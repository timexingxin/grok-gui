import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";
import type {
  ActiveModel,
  AvailableModel,
  Message,
  ProviderInfo,
  Session,
  StreamingState,
  ToolCallRecord,
  WorkspaceMode,
  WorkspaceOverview,
  WorkspacePanel,
  WorkspaceText,
  PermissionRequest,
  AgentAction,
  ConversationRecord,
  ReasoningEffort,
  AgentConnection,
  PermissionLevel,
  ScheduledTask,
  UiSettings,
  QueuedMessage,
} from "../types";
import { modeForLevel } from "../types";
import { listProviders } from "@grok-gui/provider";
import {
  deleteQueuedMessage as removeQueuedMessage,
  editQueuedMessage as replaceQueuedMessage,
  enqueueMessage,
  takeNextQueuedMessage,
} from "../message-queue";


/** Tauri context detection (set by `@tauri-apps/api` at runtime). */
const isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

/** Keeps newer settings defaults when an older local transcript is restored. */
export function mergePersistedAppState(persistedState: unknown, currentState: AppState): AppState {
  const persisted = (persistedState ?? {}) as Partial<AppState>;
  return {
    ...currentState,
    ...persisted,
    settings: { ...currentState.settings, ...persisted.settings },
  };
}

function modelContextWindow(model: { context?: number; contextWindow?: number }): number | undefined {
  return model.contextWindow ?? model.context;
}

export interface AppState {
  ready: boolean;
  providers: ProviderInfo[];
  activeModel: ActiveModel | null;
  /** Models reported by the live agent handshake; empty before first connect. */
  availableModels: AvailableModel[];
  /** Which auth path the running Grok CLI is currently using. Determines
   * the model catalog shown in pickers (oauth exposes only grok-4.5;
   * apiKey exposes the full xAI family). */
  authMode: "oauth" | "apiKey" | "none";
  session: Session | null;
  messages: Message[];
  streaming: StreamingState | null;
  /** Follow-ups waiting for the current ACP turn or runtime reconnect. */
  queuedMessages: QueuedMessage[];
  /** Live tool call records, keyed by tool-call id. */
  toolCalls: Record<string, ToolCallRecord>;
  /** Completed and in-flight agent operations for the Terminal/activity panel. */
  activity: ToolCallRecord[];
  workspace: WorkspaceOverview | null;
  selectedFile: WorkspaceText | null;
  selectedDiff: WorkspaceText | null;
  panel: WorkspacePanel;
  mode: WorkspaceMode;
  planSteps: string[];
  permissionRequest: PermissionRequest | null;
  screen: "chat" | "settings" | "plugins" | "scheduled";
  workbenchVisible: boolean;
  autoApprove: boolean;
  /** Local, reopenable transcripts, newest first. */
  history: ConversationRecord[];
  /** Stable identifier for the visible transcript, independent of the ACP runtime id. */
  activeConversationId: string | null;
  /** The most recent sidebar selection made while another session is restoring. */
  pendingConversationId: string | null;
  reasoningEffort: ReasoningEffort;
  cancelPending: boolean;
  connection: AgentConnection;
  switching: boolean;
  permissionLevel: PermissionLevel;
  sidebarCollapsed: boolean;
  scheduledTasks: ScheduledTask[];
  /** Increments on every sendMessage; lets scheduled tasks detect "my turn
   * finished" without relying on the global streaming flag. */
  turnSeq: number;
  /** Live context-window occupancy from the agent's `_meta.totalTokens`. */
  contextTokens: number;
  /** Per-session snapshot of the in-flight streaming state. When a user
   * switches away from a session that is still generating, we stash the
   * live streaming/toolCalls/activity here so the background turn keeps
   * running AND cutting back shows the latest state instead of a blank. */
  streamingBySession: Record<string, {
    streaming: StreamingState | null;
    toolCalls: Record<string, ToolCallRecord>;
    activity: ToolCallRecord[];
  }>;
  compacting: boolean;
  settings: UiSettings;
  /** Agent events for non-active sessions, replayed on switch-back so a
   * background turn's results are visible without interrupting it. Purely
   * in-memory; never persisted. */
  pendingEventsBySession: Record<string, unknown[]>;

  // actions
  init: () => Promise<void>;
  refreshAuthMode: () => Promise<void>;
  setAuthMode: (mode: "oauth" | "apiKey") => Promise<void>;
  setActiveModel: (providerId: string, modelId: string) => Promise<void>;
  startSession: (workspace: string, resumeSessionId?: string) => Promise<void>;
  /** Start a clean agent conversation in the current or selected workspace. */
  newTask: (workspace?: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  deleteMessage: (id: string) => void;
  guideMessage: (id: string) => Promise<void>;
  queueMessage: (text: string) => void;
  guideQueuedMessage: (id: string) => Promise<void>;
  editQueuedMessage: (id: string, text: string) => void;
  deleteQueuedMessage: (id: string) => void;
  dispatchNextQueuedMessage: () => Promise<void>;
  stopGenerating: () => Promise<void>;
  compactContext: () => Promise<void>;
  checkConnection: () => Promise<boolean>;
  reconnect: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  openWorkspaceFile: (path: string) => Promise<void>;
  openWorkspaceDiff: (path: string) => Promise<void>;
  setPanel: (panel: WorkspacePanel) => void;
  setMode: (mode: WorkspaceMode) => Promise<void>;
  setPermissionLevel: (level: PermissionLevel) => Promise<void>;
  respondPermission: (optionId: string) => Promise<void>;
  setScreen: (screen: "chat" | "settings" | "plugins" | "scheduled") => void;
  setWorkbenchVisible: (visible: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setAutoApprove: (enabled: boolean) => Promise<void>;
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>;
  saveCurrentConversation: (options?: { touchActivity?: boolean; expectedConversationId?: string | null }) => void;
  openConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  togglePin: (id: string) => void;
  toggleArchive: (id: string) => void;
  markUnread: (id: string) => void;
  clearAllConversations: () => void;
  createScheduledTask: (input: Omit<ScheduledTask, "id" | "status" | "createdAt" | "lastRunAt">) => string;
  deleteScheduledTask: (id: string) => void;
  toggleScheduledTaskPause: (id: string) => void;
  /** Called on a timer; fires due tasks and settles finished runs. */
  checkScheduledTasks: () => Promise<void>;
  updateSettings: (patch: Partial<UiSettings>) => void;
  appendStreamText: (delta: string) => void;
  finishStream: (stopReason?: string) => void;
}

/** Restore a local transcript without waiting for the remote agent process. */
export function hydrateConversation(
  record: ConversationRecord,
  session: Session | null,
): Pick<AppState, "messages" | "streaming" | "queuedMessages" | "cancelPending" | "toolCalls" | "activity" | "selectedFile" | "selectedDiff" | "planSteps" | "permissionRequest" | "activeConversationId" | "session"> {
  return {
    messages: record.messages,
    streaming: null,
    queuedMessages: record.queuedMessages ?? [],
    cancelPending: false,
    toolCalls: {},
    activity: [],
    selectedFile: null,
    selectedDiff: null,
    planSteps: [],
    permissionRequest: null,
    activeConversationId: record.id,
    session: session
      ? {
          ...session,
          title: record.title,
          workspace: record.workspace ?? session.workspace,
          inputTokens: record.usage?.inputTokens ?? session.inputTokens,
          outputTokens: record.usage?.outputTokens ?? session.outputTokens,
          costUsd: record.usage?.costUsd ?? session.costUsd,
          turns: record.usage?.turns ?? session.turns,
        }
      : session,
  };
}

let _idCounter = 0;
const nextId = () => `${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;
let unlistenGrokEvents: (() => void) | null = null;
let conversationSaveTimer: ReturnType<typeof setTimeout> | null = null;
let transcriptLifecycleHandlersInstalled = false;
let lastCompactAt = 0;
const COMPACT_COOLDOWN_MS = 5 * 60_000;

// The agent emits text deltas character-by-character; applying each one would
// re-render the markdown tree per character. Buffer and flush at ~20fps.
let pendingTextDelta = "";
let pendingReasoningDelta = "";
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
// When the user "guides" a queued message, we cancel the in-flight turn and
// send this text as soon as the cancellation settles (turn_end fires).
// Keyed by session id so guiding in session A can't leak into session B's
// finishStream.
const pendingGuideBySession = new Map<string, string>();

function activeThoughtIndex(parts: Message["parts"]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type === "reasoning" && !part.thought.finishedAt) return index;
  }
  return -1;
}

function flushStreamBuffers(set: Setter, get: Getter) {
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
  if (!pendingTextDelta && !pendingReasoningDelta) return;
  const text = pendingTextDelta;
  const reasoning = pendingReasoningDelta;
  pendingTextDelta = "";
  pendingReasoningDelta = "";
  set((s) => {
    if (!s.streaming) return s;
    let parts = s.streaming.parts;
    if (text) {
      const last = parts.at(-1);
      parts = last?.type === "text"
        ? [...parts.slice(0, -1), { ...last, text: last.text + text }]
        : [...parts, { type: "text" as const, text }];
    }
    if (reasoning) {
      const index = activeThoughtIndex(parts);
      if (index >= 0) {
        const part = parts[index];
        if (part.type === "reasoning") {
          parts = parts.map((entry, entryIndex) =>
            entryIndex === index
              ? { type: "reasoning" as const, thought: { ...part.thought, text: part.thought.text + reasoning } }
              : entry,
          );
        }
      }
    }
    return {
      streaming: {
        ...s.streaming,
        text: s.streaming.text + text,
        parts,
      },
    };
  });
  scheduleConversationSave(get);
}

function replayPendingEvents(set: Setter, get: Getter, sessionId: string) {
  const pending = get().pendingEventsBySession[sessionId];
  if (!pending || pending.length === 0) return;
  set((s) => {
    const rest = { ...s.pendingEventsBySession };
    delete rest[sessionId];
    return { pendingEventsBySession: rest };
  });
  pendingTextDelta = "";
  pendingReasoningDelta = "";
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
  // If the background session produced turn content (deltas/tool calls)
  // while we were away, we need a streaming container for them to land in.
  // Without it, applyEvent's text_delta/turn_end handlers bail on the
  // `if (!s.streaming)` guard and the content is silently lost.
  const hasTurnContent = pending.some(
    (e: any) =>
      e?.type === "text_delta" ||
      e?.type === "reasoning" ||
      e?.type === "tool_call_start" ||
      e?.type === "tool_call_update" ||
      e?.type === "action_notice" ||
      e?.type === "turn_end",
  );
  if (hasTurnContent && !get().streaming) {
    set({ streaming: { messageId: nextId(), text: "", parts: [], actions: [] } });
  }
  for (const evt of pending) {
    applyEvent(set, get, evt);
  }
  flushStreamBuffers(set, get);
}

function finishActiveThought(streaming: StreamingState, finishedAt = Date.now()): StreamingState {
  const index = activeThoughtIndex(streaming.parts);
  if (index < 0) return streaming;
  const part = streaming.parts[index];
  if (part.type !== "reasoning") return streaming;
  return {
    ...streaming,
    parts: streaming.parts.map((entry, entryIndex) =>
      entryIndex === index
        ? { type: "reasoning" as const, thought: { ...part.thought, finishedAt } }
        : entry,
    ),
  };
}

function scheduleStreamFlush(set: Setter, get: Getter) {
  if (streamFlushTimer) return;
  streamFlushTimer = setTimeout(() => flushStreamBuffers(set, get), 50);
}

export const useAppStore = create<AppState>()(
  persist(subscribeWithSelector((set, get) => ({
    ready: false,
    providers: [],
    activeModel: null,
    availableModels: [],
    authMode: "oauth",
    session: null,
    messages: [],
    streaming: null,
    queuedMessages: [],
    toolCalls: {},
    activity: [],
    workspace: null,
    selectedFile: null,
    selectedDiff: null,
    panel: "changes",
    mode: "build",
    permissionLevel: "trust_workspace",
    settings: {
      theme: "dark",
      accent: "blue",
      language: "en-US",
      languageChosen: false,
      fontSize: 13,
      chatMaxWidth: 960,
      interactiveEffects: true,
      showTokenUsage: true,
      showReasoningSummary: true,
      expandShellToolParts: false,
      expandEditToolParts: false,
      autoCompactThreshold: 0.85,
      clearErrorOnSend: true,
      defaultWorkspace: "~",
      defaultConversationDir: "~/Documents/AI工具/grok-build/sessions",
    },
    planSteps: [],
    permissionRequest: null,
    screen: "chat",
    // Chat remains the primary surface. Project inspection is available from
    // the top bar or Settings instead of consuming a permanent 380px column.
    workbenchVisible: false,
    autoApprove: true,
    history: [],
    activeConversationId: null,
    pendingConversationId: null,
    reasoningEffort: "high",
    cancelPending: false,
    connection: { state: "idle" },
    switching: false,
    sidebarCollapsed: false,
    scheduledTasks: [],
    turnSeq: 0,
    streamingBySession: {},
    contextTokens: 0,
    compacting: false,
    pendingEventsBySession: {},

    init: async () => {
      // Discover the auth path the Grok CLI is using, then load the matching
      // model catalog. Doing auth discovery before providers keeps the
      // catalog honest about what the user can actually pick.
      let detectedAuthMode: "oauth" | "apiKey" | "none" = "oauth";
      if (isTauri()) {
        try {
          const tauri = await import("@tauri-apps/api/core");
          const info = await tauri.invoke<{
            kind: string;
            logged_in: boolean;
            has_api_key: boolean;
          }>("get_auth_mode");
          if (info.kind === "oauth" || info.kind === "apiKey") {
            detectedAuthMode = info.kind;
          }
        } catch {
          // Non-fatal: stay on the default oauth catalog.
        }
      }
      const effectiveMode: "oauth" | "apiKey" =
        detectedAuthMode === "apiKey" ? "apiKey" : "oauth";
      set({ authMode: effectiveMode });
      const providers = await listProviders(effectiveMode);
      const xai = providers.find((p) => p.id === "xai");
      // Default to Grok 4.5 — the free-tier model the user gets from
      // their existing ~/.grok/auth.json. If 4.5 isn't in the catalog
      // (older builds) fall back to the first xai model.
      const grok45 = xai?.models.find((m) => m.id === "grok-4.5");
      const initialModel: ActiveModel | null = grok45
        ? { providerId: "xai", id: "grok-4.5", label: "Grok 4.5", contextWindow: grok45.context }
        : xai?.models[0]
          ? { providerId: "xai", id: xai.models[0].id, label: xai.models[0].label, contextWindow: xai.models[0].context }
          : null;

      set({
        providers,
        activeModel: initialModel,
        // Empty session stub; App.tsx will call startSession() right after
        // init() to spawn a real grok agent.
        session: {
          id: "",
          title: "新任务",
          workspace: "~",
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          cacheHit: false,
        },
        ready: true,
      });

      // Auto-clear stale "Agent 错误" messages left from previous sessions
      // when the clearErrorOnSend setting is enabled.
      if (get().settings.clearErrorOnSend) {
        set((s) => ({
          messages: s.messages.filter((m) => {
            if (m.role !== "assistant") return true;
            return !m.parts.some((p) => p.type === "text" && p.text.startsWith("⚠️ **Agent 错误**"));
          }),
        }));
      }

      installTranscriptLifecycleHandlers(get);

      // Subscribe to grok events from Rust. If we're not inside Tauri
      // (e.g. running `vite` alone), this is a no-op.
      if (isTauri()) {
        const tauriEvent = await import("@tauri-apps/api/event");
        unlistenGrokEvents?.();
        unlistenGrokEvents = await tauriEvent.listen("grok:event", (e: any) => {
          const payload = e.payload as any;
          const evt = payload?.event ?? payload;
          const state = get();
          const eventSessionId: string | undefined = payload?.session_id;
          // Events without a session id come from the handshake phase before
          // the ACP session is known; they are not safe to route, drop them.
          if (!eventSessionId) return;
          // During a session switch the visible session.id may still be the
          // old one (hydrateConversation does not change it). Cache EVERY
          // event by its own session id so neither the leaving session's tail
          // events nor the target session's early events are lost. They are
          // replayed by replayPendingEvents after the switch settles.
          if (state.switching || eventSessionId !== state.session?.id) {
            set((s) => {
              const existing = s.pendingEventsBySession[eventSessionId] ?? [];
              // Cap per-session backlog to bound memory. Drop the oldest
              // deltas once we exceed the limit rather than growing unbounded.
              const capped = existing.length >= 500
                ? [...existing.slice(-499), evt]
                : [...existing, evt];
              return {
                pendingEventsBySession: {
                  ...s.pendingEventsBySession,
                  [eventSessionId]: capped,
                },
              };
            });
            return;
          }
          applyEvent(set, get, evt);
        });
      }
    },

    refreshAuthMode: async () => {
      if (!isTauri()) return;
      try {
        const tauri = await import("@tauri-apps/api/core");
        const info = await tauri.invoke<{
          kind: string;
          logged_in: boolean;
          has_api_key: boolean;
        }>("get_auth_mode");
        const detected = info.kind === "apiKey" ? "apiKey" : "oauth";
        set({ authMode: detected });
        const providers = await listProviders(detected);
        set({
          providers,
          availableModels: providers[0]?.models ?? [],
        });
      } catch (error) {
        console.error("refreshAuthMode failed:", error);
      }
    },

    setAuthMode: async (mode) => {
      set({ authMode: mode });
      const providers = await listProviders(mode);
      set({
        providers,
        availableModels: providers[0]?.models ?? [],
      });
      // The CLI picks up the new env (XAI_API_KEY) or auth.json on next
      // start_session; if the user already has a live session, reconnect it
      // so the next prompt uses the chosen auth path.
      if (get().session?.id) {
        void get().reconnect();
      }
    },

    setActiveModel: async (providerId, modelId) => {
      const p = get().providers.find((x) => x.id === providerId);
      // The ACP handshake can offer models newer than the static provider
      // catalog. Prefer static metadata when available, then fall back to the
      // live catalog that powers the picker.
      const m = p?.models.find((x) => x.id === modelId)
        ?? (get().availableModels ?? []).find((x) => x.id === modelId);
      if (!p || !m) return;
      if (isTauri()) {
        const tauri = await import("@tauri-apps/api/core");
        await tauri.invoke("set_model", { sessionId: get().session?.id, model: modelId });
      }
      set({ activeModel: { providerId, id: modelId, label: m.label, contextWindow: modelContextWindow(m) } });
    },

    startSession: async (workspace, resumeSessionId) => {
      if (isTauri()) {
        set({ connection: { state: "connecting" } });
        const tauri = await import("@tauri-apps/api/core");
        try {
          const resp = await tauri.invoke<{
            session_id: string;
            workspace: string;
            context_window?: number;
            available_models?: AvailableModel[];
          }>(
            "start_session",
            {
              workspacePath: workspace,
              provider: get().activeModel?.providerId ?? "xai",
              model: get().activeModel?.id ?? "grok-4.5",
              // Grok 4.5 has an official native CLI setting. Do not send a
              // made-up effort value to other models.
              reasoningEffort: supportsOfficialReasoningEffort(get().activeModel)
                ? get().reasoningEffort
                : null,
              resumeSessionId,
              executionMode: get().mode,
            },
          );
          const realWorkspace = resp.workspace;
          // Each native runtime starts with a safe, known default. Reapply the
          // user's setting after replacing a session so the UI and runtime do
          // not drift apart.
          await tauri.invoke("set_auto_approve", { sessionId: resp.session_id, enabled: get().autoApprove });
          set((s) => ({
            session: s.session
              ? { ...s.session, id: resp.session_id, workspace: realWorkspace, turns: resumeSessionId ? s.session.turns : 0 }
              : {
                  id: resp.session_id,
                  title: "新任务",
                  workspace: realWorkspace,
                  turns: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  costUsd: 0,
                  cacheHit: false,
                },
            activeModel: s.activeModel
              ? { ...s.activeModel, contextWindow: resp.context_window ?? s.activeModel.contextWindow }
              : s.activeModel,
            availableModels:
              resp.available_models && resp.available_models.length > 0
                ? resp.available_models
                : s.availableModels,
            // A resumed transcript keeps its own stable local id. New sessions
            // use the ACP id as their initial local id.
            activeConversationId: resumeSessionId ? s.activeConversationId : resp.session_id,
            cancelPending: false,
            connection: { state: "connected", checkedAt: Date.now() },
          }));
          // The transcript is already local and the ACP session is ready.
          // Directory enumeration can be slow on large workspaces, so never
          // make switching or queued input wait for it.
          void get().refreshWorkspace().catch((workspaceError) => {
            // The ACP session remains usable even when a directory cannot be
            // indexed (for example a protected folder under the home dir).
            console.warn("workspace inspection failed:", workspaceError);
          });
          return;
        } catch (err) {
          console.error("start_session failed:", err);
          set({ connection: { state: "error", detail: String(err), checkedAt: Date.now() } });
          throw err;
        }
      }
      // Fallback (no Tauri): just update the session in the store.
      set((s) => ({
        session: s.session
          ? { ...s.session, workspace, turns: 0 }
          : {
              id: nextId(),
              title: "新任务",
              workspace,
              turns: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            cacheHit: false,
          },
        activeConversationId: s.session?.id || nextId(),
        connection: { state: "connected", checkedAt: Date.now() },
      }));
    },

    newTask: async (workspace) => {
      const state = get();
      if (state.switching) return;
      const targetWorkspace = workspace ?? state.session?.workspace ?? "~";
      flushStreamBuffers(set, get);
      get().saveCurrentConversation();
      set({
        messages: [],
        streaming: null,
        queuedMessages: [],
        toolCalls: {},
        activity: [],
        selectedFile: null,
        selectedDiff: null,
        planSteps: [],
        permissionRequest: null,
        cancelPending: false,
        activeConversationId: null,
        switching: true,
        session: {
          id: "",
          title: "新任务",
          workspace: targetWorkspace,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          cacheHit: false,
        },
      });
      try {
        await get().startSession(targetWorkspace);
      } finally {
        set({ switching: false });
      }
    },

    sendMessage: async (text) => {
      const normalized = text.trim();
      if (!normalized) return;
      const state = get();
      // A permission change restarts the ACP runtime. Do not turn an accidental
      // click during that short transition into a durable follow-up; the input
      // component keeps the draft in place and shows reconnecting instead.
      if (state.switching) return;
      // ACP accepts only one active turn. Keep follow-ups locally until the
      // turn settles or a background session restore completes.
      if (state.streaming || state.connection.state !== "connected") {
        get().queueMessage(normalized);
        return;
      }
      const userMsg: Message = {
        id: nextId(),
        role: "user",
        parts: [{ type: "text", text: normalized }],
        createdAt: Date.now(),
      };
      set((s) => {
        const filtered = s.settings.clearErrorOnSend
          ? s.messages.filter((m) => {
              if (m.role !== "assistant") return true;
              return !m.parts.some((p) => p.type === "text" && p.text.startsWith("⚠️ **Agent 错误**"));
            })
          : s.messages;
        return {
          messages: [...filtered, userMsg],
          streaming: { messageId: nextId(), text: "", parts: [], actions: [] },
          toolCalls: {},
          cancelPending: false,
          turnSeq: s.turnSeq + 1,
        };
      });
      get().saveCurrentConversation({ touchActivity: true });

      if (isTauri()) {
        const tauri = await import("@tauri-apps/api/core");
        try {
          await tauri.invoke("send_message", { sessionId: get().session?.id, text: instructionForMode(get().mode, normalized) });
        } catch (err) {
          console.error("send_message failed:", err);
          set((s) => ({
            streaming: null,
            cancelPending: false,
            toolCalls: {},
            messages: s.streaming
              ? [
                  ...s.messages,
                  {
                    id: s.streaming.messageId,
                    role: "assistant",
                    parts: [{ type: "text", text: `⚠️ **Agent request failed**: \`${String(err)}\`` }],
                    createdAt: Date.now(),
                  },
                ]
              : s.messages,
          }));
          get().saveCurrentConversation({ touchActivity: true });
        }
        return;
      }

      // Fallback (no Tauri): simulate a streaming response so the UI
      // can be exercised in browser dev mode.
      const reply =
        `好的，我来帮你处理这个任务。\n\n` +
        `我先看一下项目结构，然后给一个计划：\n\n` +
        `1. 探索 \`~/Projects/claude-test\` 目录\n` +
        `2. 阅读关键文件\n` +
        `3. 给出方案\n\n` +
        `（这是 fallback demo；Tauri 模式下会发到真实 grok agent）`;
      let i = 0;
      const tick = () => {
        if (i >= reply.length) {
          set((s) => {
            const streaming = s.streaming;
            if (!streaming) return {};
            return {
              streaming: null,
              messages: [
                ...s.messages,
                {
                  id: streaming.messageId,
                  role: "assistant",
                  parts: [{ type: "text", text: reply }],
                  createdAt: Date.now(),
                },
              ],
              session: s.session
                ? { ...s.session, turns: s.session.turns + 1 }
                : s.session,
            };
          });
          get().saveCurrentConversation();
          return;
        }
        set((s) =>
          s.streaming
            ? { streaming: { ...s.streaming, text: reply.slice(0, i + 1) } }
            : {},
        );
        i += 3;
        setTimeout(tick, 18);
      };
      setTimeout(tick, 200);
    },

    deleteMessage: (id) => {
      set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }));
      get().saveCurrentConversation({ touchActivity: false });
    },

    guideMessage: async (id) => {
      const msg = get().messages.find((m) => m.id === id);
      if (!msg || msg.role !== "user") return;
      if (get().switching) return;
      const text = msg.parts.find((p) => p.type === "text")?.text;
      if (!text) return;
      const sid = get().session?.id;
      if (!sid) return;
      if (get().streaming) {
        pendingGuideBySession.set(sid, text);
        await get().stopGenerating();
      } else {
        void get().sendMessage(text);
      }
    },

    queueMessage: (text) => {
      const normalized = text.trim();
      if (!normalized) return;
      set((s) => ({
        queuedMessages: enqueueMessage(s.queuedMessages, {
          id: nextId(),
          text: normalized,
          createdAt: Date.now(),
        }),
      }));
      // This is durable input, but it intentionally does not reorder an
      // existing conversation until it is actually dispatched to the agent.
      get().saveCurrentConversation();
      // Editing and resending from an idle conversation also uses this path.
      // Wake the queue immediately when no active turn is blocking it.
      void get().dispatchNextQueuedMessage();
    },

    guideQueuedMessage: async (id) => {
      const msg = get().queuedMessages.find((m) => m.id === id);
      if (!msg) return;
      // Do not remove from the queue while a session restore is in flight:
      // sendMessage() drops sends during switching, which would lose the
      // message. Leave it queued so the user can retry after the switch.
      if (get().switching) return;
      const sid = get().session?.id;
      if (!sid) return;
      set((s) => ({ queuedMessages: s.queuedMessages.filter((m) => m.id !== id) }));
      get().saveCurrentConversation();
      if (get().streaming) {
        pendingGuideBySession.set(sid, msg.text);
        await get().stopGenerating();
      } else {
        void get().sendMessage(msg.text);
      }
    },

    editQueuedMessage: (id, text) => {
      set((s) => ({ queuedMessages: replaceQueuedMessage(s.queuedMessages, id, text) }));
      get().saveCurrentConversation();
    },

    deleteQueuedMessage: (id) => {
      set((s) => ({ queuedMessages: removeQueuedMessage(s.queuedMessages, id) }));
      get().saveCurrentConversation();
    },

    dispatchNextQueuedMessage: async () => {
      const state = get();
      if (state.streaming || state.switching || state.connection.state !== "connected") return;
      const { next, remaining } = takeNextQueuedMessage(state.queuedMessages);
      if (!next) return;
      set({ queuedMessages: remaining });
      get().saveCurrentConversation();
      await get().sendMessage(next.text);
    },

    stopGenerating: async () => {
      if (!get().streaming || get().cancelPending) return;
      flushStreamBuffers(set, get);
      set({ cancelPending: true });
      if (!isTauri()) {
        get().finishStream("cancelled");
        return;
      }
      try {
        const tauri = await import("@tauri-apps/api/core");
        await tauri.invoke("cancel_turn", { sessionId: get().session?.id });
      } catch (error) {
        console.error("cancel_turn failed:", error);
        // The turn cannot be cancelled (pipe broken / session gone). End the
        // stream so the UI is not stuck in "generating" forever, and drop any
        // pending guide text for this session so it can't leak elsewhere.
        const sid = get().session?.id;
        if (sid) pendingGuideBySession.delete(sid);
        get().finishStream("error");
      }
    },

    compactContext: async () => {
      if (get().compacting || get().streaming || !isTauri()) return;
      set({ compacting: true });
      try {
        const tauri = await import("@tauri-apps/api/core");
        await tauri.invoke("compact_session", { sessionId: get().session?.id });
        lastCompactAt = Date.now();
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: nextId(),
              role: "assistant" as const,
              parts: [{ type: "text" as const, text: "🗜️ 上下文已自动压缩。" }],
              createdAt: Date.now(),
            },
          ],
        }));
      } catch (error) {
        console.error("compact failed:", error);
      } finally {
        set({ compacting: false });
      }
    },

    checkConnection: async () => {
      if (!isTauri()) {
        set({ connection: { state: "connected", checkedAt: Date.now() } });
        return true;
      }
      set({ connection: { state: "connecting" } });
      try {
        const tauri = await import("@tauri-apps/api/core");
        const result = await tauri.invoke<{ connected: boolean; detail?: string }>("check_connection", { sessionId: get().session?.id });
        set({ connection: {
          state: result.connected ? "connected" : "disconnected",
          detail: result.detail,
          checkedAt: Date.now(),
        } });
        return result.connected;
      } catch (error) {
        set({ connection: { state: "error", detail: String(error), checkedAt: Date.now() } });
        return false;
      }
    },

    reconnect: async () => {
      const state = get();
      if (state.switching) return;
      const workspace = state.session?.workspace ?? "~";
      set({ switching: true });
      try {
        await get().startSession(workspace, state.session?.id);
      } finally {
        const nextConversationId = get().pendingConversationId;
        set({ switching: false, pendingConversationId: null });
        if (nextConversationId) {
          void get().openConversation(nextConversationId);
        } else {
          void get().dispatchNextQueuedMessage();
        }
      }
    },

    appendStreamText: (delta) => {
      set((s) =>
        s.streaming
          ? { streaming: { ...s.streaming, text: s.streaming.text + delta } }
          : {},
      );
    },

    refreshWorkspace: async () => {
      const workspace = get().session?.workspace;
      if (!workspace || !isTauri()) return;
      const tauri = await import("@tauri-apps/api/core");
      const overview = await tauri.invoke<WorkspaceOverview>("workspace_overview", {
        workspacePath: workspace,
      });
      set({ workspace: overview });
    },

    openWorkspaceFile: async (path) => {
      const workspace = get().session?.workspace;
      if (!workspace || !isTauri()) return;
      const tauri = await import("@tauri-apps/api/core");
      const selectedFile = await tauri.invoke<WorkspaceText>("workspace_file", {
        workspacePath: workspace,
        relativePath: path,
      });
      set({ selectedFile, selectedDiff: null, panel: "files" });
    },

    openWorkspaceDiff: async (path) => {
      const workspace = get().session?.workspace;
      if (!workspace || !isTauri()) return;
      const tauri = await import("@tauri-apps/api/core");
      const selectedDiff = await tauri.invoke<WorkspaceText>("workspace_diff", {
        workspacePath: workspace,
        relativePath: path,
      });
      set({ selectedDiff, selectedFile: null, panel: "changes" });
    },

    setPanel: (panel) => set({ panel }),
    setMode: async (mode) => {
      const state = get();
      if (mode === state.mode) return;
      if (state.streaming) throw new Error("请在当前生成结束后再切换执行模式。");
      set({ mode, switching: isTauri() && Boolean(state.session?.id) });
      if (isTauri() && state.session?.id) {
        try {
          await get().startSession(state.session.workspace ?? "~", state.session.id);
        } catch {
          // Resume failed. Try a fresh session with the new mode so the
          // sandbox policy change still takes effect. Local transcript
          // is preserved; only the server-side ACP session resets.
          try {
            await get().startSession(state.session.workspace ?? "~");
          } catch (freshError) {
            set({ mode: state.mode });
            throw freshError;
          }
        } finally {
          const nextConversationId = get().pendingConversationId;
          set({ switching: false, pendingConversationId: null });
          if (nextConversationId) {
            void get().openConversation(nextConversationId);
          } else {
            void get().dispatchNextQueuedMessage();
          }
        }
      }
    },

    setPermissionLevel: async (level) => {
      const state = get();
      if (level === state.permissionLevel) return;
      if (state.streaming) throw new Error("请在当前生成结束后再切换权限级别。");
      const targetMode = modeForLevel(level);
      set({
        permissionLevel: level,
        mode: targetMode,
        switching: isTauri() && Boolean(state.session?.id),
      });
      if (isTauri() && state.session?.id) {
        try {
          await get().startSession(state.session.workspace ?? "~", state.session.id);
        } catch {
          try {
            await get().startSession(state.session.workspace ?? "~");
          } catch (freshError) {
            set({ permissionLevel: state.permissionLevel, mode: state.mode });
            throw freshError;
          }
        } finally {
          const nextConversationId = get().pendingConversationId;
          set({ switching: false, pendingConversationId: null });
          if (nextConversationId) {
            void get().openConversation(nextConversationId);
          } else {
            void get().dispatchNextQueuedMessage();
          }
        }
      }
    },
    setScreen: (screen) => set({ screen }),
    setWorkbenchVisible: (workbenchVisible) => set({ workbenchVisible }),
    setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    setAutoApprove: async (autoApprove) => {
      if (isTauri()) {
        const tauri = await import("@tauri-apps/api/core");
        await tauri.invoke("set_auto_approve", { sessionId: get().session?.id, enabled: autoApprove });
      }
      set({ autoApprove });
    },
    setReasoningEffort: async (reasoningEffort) => {
      const state = get();
      if (reasoningEffort === state.reasoningEffort || state.streaming) return;
      set({
        reasoningEffort,
        switching: isTauri() && Boolean(state.session?.id && supportsOfficialReasoningEffort(state.activeModel)),
      });

      if (isTauri() && state.session?.id && supportsOfficialReasoningEffort(state.activeModel)) {
        try {
          await get().startSession(state.session.workspace ?? "~", state.session.id);
        } catch {
          try {
            await get().startSession(state.session.workspace ?? "~");
          } catch (freshError) {
            set({ reasoningEffort: state.reasoningEffort });
            throw freshError;
          }
        } finally {
          const nextConversationId = get().pendingConversationId;
          set({ switching: false, pendingConversationId: null });
          if (nextConversationId) {
            void get().openConversation(nextConversationId);
          } else {
            void get().dispatchNextQueuedMessage();
          }
        }
      }
    },

    saveCurrentConversation: (options = {}) => {
      const state = get();
      const realMessages = state.messages.filter((m) => {
        if (m.role !== "assistant") return true;
        return !m.parts.some((p) => p.type === "text" && p.text.startsWith("⚠️ **Agent 错误**"));
      });
      if (realMessages.length === 0 && state.queuedMessages.length === 0) return;
      const id = state.activeConversationId ?? state.session?.id ?? nextId();
      if (options.expectedConversationId && options.expectedConversationId !== id) return;
      const existing = state.history.find((entry) => entry.id === id);
      const messages = snapshotConversationMessages(state.messages, state.streaming);
      const generatedTitle = conversationTitle(messages);
      // Old records have no titleSource. Treat a stored title that differs
      // from today's generated title as a legacy manual rename so a save does
      // not erase the user's wording after this upgrade.
      const titleSource = existing?.titleSource
        ?? (existing && existing.title !== generatedTitle ? "manual" : "auto");
      const title = conversationTitle(messages, existing?.title ?? state.session?.title, titleSource);
      const now = Date.now();
      
      const record: ConversationRecord = {
        id,
        agentSessionId: state.session?.id || existing?.agentSessionId,
        title,
        titleSource,
        workspace: state.session?.workspace,
        messages,
        queuedMessages: state.queuedMessages,
        usage: state.session
          ? {
              inputTokens: state.session.inputTokens,
              outputTokens: state.session.outputTokens,
              costUsd: state.session.costUsd,
              turns: state.session.turns,
              contextWindow: state.activeModel?.contextWindow,
            }
          : existing?.usage,
        createdAt: existing?.createdAt ?? now,
        lastActivityAt: options.touchActivity
          ? now
          : (existing?.lastActivityAt ?? existing?.updatedAt ?? now),
        updatedAt: existing?.updatedAt ?? now,
        pinned: existing?.pinned ?? false,
        archived: existing?.archived ?? false,
        unread: existing?.unread ?? false,
      };

      // Persist a newer timestamp only for a durable transcript change. A
      // conversation switch calls this method to protect the current tab, so
      // letting that save reorder history would make every opened row jump.
      record.updatedAt = conversationContentChanged(existing, record)
        ? now
        : (existing?.updatedAt ?? now);
      
      let newHistory = state.history.map((entry) => entry.id === id ? record : entry);
      
      if (!newHistory.find((e) => e.id === id)) {
        newHistory = [record, ...newHistory];
      }
      
      newHistory = sortConversationRecords(newHistory);
      
      set({
        activeConversationId: id,
        session: state.session ? { ...state.session, title } : state.session,
        history: newHistory,
      });
    },

    openConversation: async (id) => {
      if (get().switching) {
        // Keep only the latest intent: a fast A -> B -> C sequence should land
        // on C after the in-flight restore, rather than silently dropping it.
        set({ pendingConversationId: id });
        return;
      }
      const record = get().history.find((entry) => entry.id === id);
      if (!record) return;
      flushStreamBuffers(set, get);
      // Stash the about-to-be-unmounted session's live UI state so its turn
      // remains visible if the user switches back while it is still streaming.
      // The actual turn is driven by the runtime in the Rust pool; this only
      // preserves the front-end's display state.
      set((s) => {
        const oldSid = s.session?.id;
        const updates: Partial<AppState> = {
          switching: true,
          pendingConversationId: null,
          ...hydrateConversation(record, s.session),
        };
        if (oldSid && (s.streaming || Object.keys(s.toolCalls).length > 0)) {
          updates.streamingBySession = {
            ...s.streamingBySession,
            [oldSid]: {
              streaming: s.streaming,
              toolCalls: s.toolCalls,
              activity: s.activity,
            },
          };
          updates.streaming = null;
          updates.toolCalls = {};
          updates.activity = [];
        }
        // Restore the incoming session's snapshotted live state if any.
        const restored = updates.streamingBySession?.[record.id];
        if (restored) {
          updates.streaming = restored.streaming;
          updates.toolCalls = restored.toolCalls;
          updates.activity = restored.activity;
        }
        return updates;
      });

      // Multi-session: if the target session's runtime is still alive in the
      // Rust pool, start_session's fast path returns immediately without
      // re-spawning or killing the current background runtime. Only fall back
      // to a fresh session when the ACP session is gone (evicted/restarted).
      try {
        try {
          await get().startSession(record.workspace ?? "~", record.agentSessionId);
        } catch {
          await get().startSession(record.workspace ?? "~");
        }
      } finally {
        const nextConversationId = get().pendingConversationId;
        set({
          switching: false,
          pendingConversationId: null,
        });
        if (nextConversationId && nextConversationId !== record.id) {
          void get().openConversation(nextConversationId);
        } else {
          // Replay any events the background runtime produced while this
          // session was not the active view, so its transcript catches up.
          replayPendingEvents(set, get, get().session?.id ?? "");
          void get().dispatchNextQueuedMessage();
        }
      }
    },

    deleteConversation: async (id) => {
      const state = get();
      if (state.activeConversationId === id) {
        flushStreamBuffers(set, get);
        get().saveCurrentConversation();
        const workspace = get().session?.workspace ?? "~";
        set((current) => ({
          messages: [],
          streaming: null,
          queuedMessages: [],
          toolCalls: {},
          activity: [],
          selectedFile: null,
          selectedDiff: null,
          planSteps: [],
          permissionRequest: null,
          cancelPending: false,
          activeConversationId: null,
          pendingConversationId: null,
          history: current.history.filter((entry) => entry.id !== id),
          switching: true,
          session: {
            id: "",
            title: "新任务",
            workspace,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            cacheHit: false,
          },
        }));
        try {
          await get().startSession(workspace);
        } finally {
          const nextConversationId = get().pendingConversationId;
          set({ switching: false, pendingConversationId: null });
          if (nextConversationId) {
            void get().openConversation(nextConversationId);
          }
        }
        return;
      }
      set({ history: state.history.filter((entry) => entry.id !== id) });
    },

    renameConversation: (id, title) => {
      const normalizedTitle = title.replace(/\s+/g, " ").trim() || "新任务";
      const titleSource = normalizedTitle === "新任务" ? "auto" : "manual";
      set((s) => ({
        history: s.history.map((entry) =>
          entry.id === id ? { ...entry, title: normalizedTitle, titleSource, updatedAt: Date.now() } : entry,
        ),
        session: s.activeConversationId === id && s.session
          ? { ...s.session, title: normalizedTitle }
          : s.session,
      }));
    },

    togglePin: (id) => {
      set((s) => ({
        history: s.history.map((entry) =>
          entry.id === id ? toggleConversationPin(entry) : entry,
        ),
      }));
    },

    toggleArchive: (id) => {
      set((s) => ({
        history: s.history.map((entry) =>
          entry.id === id ? { ...entry, archived: !entry.archived, updatedAt: Date.now() } : entry,
        ),
      }));
    },

    markUnread: (id) => {
      set((s) => ({
        history: s.history.map((entry) =>
          entry.id === id ? { ...entry, unread: !entry.unread, updatedAt: Date.now() } : entry,
        ),
      }));
    },

    clearAllConversations: () => {
      set({
        history: [],
        messages: [],
        streaming: null,
        queuedMessages: [],
        toolCalls: {},
        activity: [],
        activeConversationId: null,
      });
    },

    createScheduledTask: (input) => {
      const task: ScheduledTask = {
        ...input,
        id: nextId(),
        status: "pending",
        createdAt: Date.now(),
      };
      set((s) => ({ scheduledTasks: [task, ...s.scheduledTasks] }));
      return task.id;
    },

    deleteScheduledTask: (id) => {
      set((s) => ({ scheduledTasks: s.scheduledTasks.filter((t) => t.id !== id) }));
    },

    toggleScheduledTaskPause: (id) => {
      set((s) => ({
        scheduledTasks: s.scheduledTasks.map((t) =>
          t.id === id
            ? { ...t, status: t.status === "paused" ? "pending" : "paused" }
            : t,
        ),
      }));
    },

    checkScheduledTasks: async () => {
      const now = Date.now();
      // A running task whose turn has drained settles: one-shot tasks complete,
      // branch (loop) tasks re-arm for the next day at the same wall-clock
      // time. We use the per-task turnSeqStarted watermark (set when the task's
      // prompt was sent) so a user-driven turn can't prematurely settle us.
      const state = get();
      const running = state.scheduledTasks.find((t) => t.status === "running");
      if (
        running &&
        running.turnSeqStarted !== undefined &&
        state.turnSeq > running.turnSeqStarted &&
        !state.streaming
      ) {
        set((s) => ({
          scheduledTasks: s.scheduledTasks.map((t) =>
            t.id === running.id
              ? t.mode === "branch"
                ? { ...t, status: "pending", scheduledAt: (t.scheduledAt ?? now) + 86_400_000, lastRunAt: now }
                : { ...t, status: "completed", lastRunAt: now }
              : t,
          ),
        }));
      }
      const due = get().scheduledTasks.find(
        (t) => t.status === "pending" && t.scheduledAt != null && t.scheduledAt <= now,
      );
      if (!due) return;
      // Never interrupt an in-flight turn; the next tick retries.
      if (get().streaming || get().switching) return;
      // Record this run's turn watermark; settle logic above compares against it.
      set((s) => ({
        scheduledTasks: s.scheduledTasks.map((t) =>
          t.id === due.id ? { ...t, status: "running", turnSeqStarted: s.turnSeq } : t,
        ),
      }));
      try {
        await get().newTask(get().session?.workspace);
        await get().sendMessage(due.content || due.title);
      } catch (error) {
        console.error("scheduled task failed:", error);
        set((s) => ({
          scheduledTasks: s.scheduledTasks.map((t) =>
            t.id === due.id ? { ...t, status: "failed" } : t,
          ),
        }));
      }
    },

    updateSettings: (patch) => {
      set((s) => ({
        settings: { ...s.settings, ...patch },
      }));
    },

    respondPermission: async (optionId) => {
      const request = get().permissionRequest;
      if (!request || !isTauri()) return;
      const tauri = await import("@tauri-apps/api/core");
      await tauri.invoke("respond_permission", {
        sessionId: get().session?.id,
        requestId: request.requestId,
        optionId,
      });
      set({ permissionRequest: null });
    },

    finishStream: (stopReason) => {
      const sid = get().session?.id;
      const guideText = sid ? pendingGuideBySession.get(sid) : undefined;
      if (sid && guideText !== undefined) pendingGuideBySession.delete(sid);
      set((s) => {
        const streaming = s.streaming;
        if (!streaming) return {};
        // Preserve the agent's emitted order. Appending every tool at turn end
        // made the UI falsely place all operations below the final reply.
        const completed = finishActiveThought(streaming);
        const parts = completed.parts;
        return {
          streaming: null,
          cancelPending: false,
          toolCalls: {},
          messages:
            parts.length > 0 || completed.actions.length > 0
              ? [
                  ...s.messages,
                  {
                    id: streaming.messageId,
                    role: "assistant",
                    parts,
                    createdAt: Date.now(),
                    trace: { actions: completed.actions },
                  },
                ]
              : s.messages,
          session: s.session
            ? {
                ...s.session,
                turns:
                  stopReason === "end_turn" || !stopReason
                    ? s.session.turns + 1
                    : s.session.turns,
              }
            : s.session,
        };
      });
      get().saveCurrentConversation({ touchActivity: stopReason === "end_turn" || !stopReason });
      // A guided message interrupts the previous turn and is sent immediately
      // once the cancellation settles, taking priority over the normal queue.
      if (guideText) {
        void get().sendMessage(guideText);
        return;
      }
      void get().dispatchNextQueuedMessage();
    },
  })), {
    name: "grok-build-transcripts-v1",
    version: 1,
    merge: mergePersistedAppState,
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({
      // localStorage is capped at ~5MB. Bound both the transcript count and
      // per-transcript length so a long build session can never evict the
      // whole history or fail the write silently.
      history: state.history.slice(0, 80).map((entry) => ({
        ...entry,
        messages: entry.messages.slice(-100),
      })),
      reasoningEffort: state.reasoningEffort,
      mode: state.mode,
      permissionLevel: state.permissionLevel,
      settings: state.settings,
      workbenchVisible: state.workbenchVisible,
      autoApprove: state.autoApprove,
      sidebarCollapsed: state.sidebarCollapsed,
      scheduledTasks: state.scheduledTasks,
    }),
  }),
);

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

export type Setter = (
  partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState>),
) => void;
export type Getter = () => AppState;

function scheduleConversationSave(get: Getter) {
  if (conversationSaveTimer) clearTimeout(conversationSaveTimer);
  const state = get();
  const expectedConversationId = state.activeConversationId ?? state.session?.id ?? null;
  conversationSaveTimer = setTimeout(() => {
    conversationSaveTimer = null;
    get().saveCurrentConversation({ expectedConversationId });
  }, 450);
}

function installTranscriptLifecycleHandlers(get: Getter) {
  if (transcriptLifecycleHandlersInstalled || typeof window === "undefined") return;
  transcriptLifecycleHandlersInstalled = true;
  const saveNow = () => get().saveCurrentConversation();
  window.addEventListener("beforeunload", saveNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveNow();
  });
}

function snapshotConversationMessages(
  messages: Message[],
  streaming: StreamingState | null,
): Message[] {
  if (!streaming) return messages;
  const parts = streaming.parts;
  if (parts.length === 0 && streaming.actions.length === 0) return messages;
  return [...messages, {
    id: streaming.messageId,
    role: "assistant",
    parts,
    createdAt: Date.now(),
    trace: { actions: streaming.actions },
  }];
}

/**
 * A reopen starts a fresh local runtime and can create a new snapshot
 * timestamp. That is not a user-visible transcript update and must not move a
 * conversation to the top of the sidebar. Compare only durable content.
 */
export function conversationContentChanged(
  existing: ConversationRecord | undefined,
  candidate: ConversationRecord,
): boolean {
  if (!existing) return true;
  const durableContent = (record: ConversationRecord) => ({
    title: record.title,
    titleSource: record.titleSource,
    workspace: record.workspace,
    messages: record.messages.map(({ id, role, parts, trace }) => ({ id, role, parts, trace })),
    queuedMessages: record.queuedMessages ?? [],
    usage: record.usage,
  });
  return JSON.stringify(durableContent(existing)) !== JSON.stringify(durableContent(candidate));
}

/** Use this for sidebar order and time groups; updatedAt is only a persistence checkpoint. */
export function conversationActivityTimestamp(record: ConversationRecord): number {
  return record.lastActivityAt ?? record.updatedAt;
}

export function sortConversationRecords(records: ConversationRecord[]): ConversationRecord[] {
  return [...records].sort((a, b) => conversationActivityTimestamp(b) - conversationActivityTimestamp(a));
}

/** Pinning is presentation state, not a conversation update. */
export function toggleConversationPin(record: ConversationRecord): ConversationRecord {
  return { ...record, pinned: !record.pinned };
}

export function applyEvent(set: Setter, get: Getter, evt: any) {
  switch (evt?.type) {
    case "text_delta":
      flushStreamBuffers(set, get);
      set((s) => s.streaming ? { streaming: finishActiveThought(s.streaming) } : s);
      pendingTextDelta += evt.delta ?? "";
      scheduleStreamFlush(set, get);
      return;

    case "reasoning":
      pendingReasoningDelta += evt.delta ?? "";
      set((s) => {
        if (s.streaming && !s.streaming.parts.some((part) => part.type === "reasoning" && !part.thought.finishedAt)) {
          return {
            streaming: {
              ...s.streaming,
              parts: [
                ...s.streaming.parts,
                { type: "reasoning", thought: { id: nextId(), text: "", startedAt: Date.now() } },
              ],
            },
          };
        }
        return s;
      });
      scheduleStreamFlush(set, get);
      return;

    case "tool_call_start": {
      flushStreamBuffers(set, get);
      const id: string = evt.id ?? "tc";
      const name: string = evt.name ?? "tool";
      const args = evt.args;
      const call: ToolCallRecord = {
        id,
        name,
        args,
        status: "running",
        startedAt: Date.now(),
      };
      set((s) => ({
        toolCalls: {
          ...s.toolCalls,
          [id]: call,
        },
        activity: [...s.activity.filter((entry) => entry.id !== id), call].slice(-100),
        streaming: s.streaming
          ? {
              ...finishActiveThought(s.streaming),
              parts: [...finishActiveThought(s.streaming).parts, { type: "tool_call", call }],
              actions: [...s.streaming.actions, { id: `tool-${id}`, title: `即将调用：${name}`, detail: formatActionArgs(args), outcome: "announced", createdAt: Date.now() }],
            }
          : s.streaming,
      }));
      break;
    }

    case "tool_call_update": {
      const id: string = evt.id;
      set((s) => {
        const prev = s.toolCalls[id];
        if (!prev) return s;
        const status: ToolCallRecord["status"] =
          evt.status === "completed" || evt.status === "complete" || evt.status === "ok"
            ? "ok"
            : evt.status === "failed" || evt.status === "error"
              ? "error"
              : "running";
        const next = {
          ...prev,
          status,
          output: evt.output ?? prev.output,
          isError: status === "error",
          finishedAt: status === "running" ? prev.finishedAt : Date.now(),
        };
        return {
          toolCalls: {
            ...s.toolCalls,
            [id]: next,
          },
          activity: [...s.activity.filter((entry) => entry.id !== id), next].slice(-100),
          streaming:
            s.streaming
              ? {
                  ...s.streaming,
                  parts: s.streaming.parts.map((part) =>
                    part.type === "tool_call" && part.call.id === id
                      ? { type: "tool_call" as const, call: next }
                      : part,
                  ),
                  actions: [
                    ...s.streaming.actions,
                    {
                      id: `tool-${id}-${status}`,
                      title: `${status === "ok" ? "已完成" : "执行失败"}：${prev.name}`,
                      detail: next.output,
                      outcome: status === "ok" ? "completed" : "error",
                      createdAt: Date.now(),
                    },
                  ],
                }
              : s.streaming,
        };
      });
      break;
    }

    case "plan_update":
      set({ planSteps: Array.isArray(evt.steps) ? evt.steps : [] });
      break;

    case "permission_request":
      set({
        permissionRequest: {
          requestId: evt.request_id,
          title: evt.title ?? "Grok requests permission",
          detail: evt.detail ?? "Review the requested action before continuing.",
          options: Array.isArray(evt.options) ? evt.options : [],
        },
      });
      break;

    case "action_notice": {
      const action: AgentAction = {
        id: nextId(), title: evt.title ?? "Agent 操作", detail: evt.detail,
        outcome:
          evt.outcome === "approved"
            ? "approved"
            : evt.outcome === "completed"
              ? "completed"
              : evt.outcome === "error"
                ? "error"
                : "announced",
        createdAt: Date.now(),
      };
      set((s) => s.streaming ? { streaming: { ...s.streaming, actions: [...s.streaming.actions, action] } } : s);
      break;
    }

    case "usage_update":
      // ACP `usage_update` reports cumulative session totals (see
      // agentclientprotocol.com/rfds/session-usage: "Total input tokens
      // across all turns", "Cumulative session cost"). Use last-writer-wins
      // instead of accumulating, so reconnects, replays, or model switches
      // do not double-count tokens or cost.
      set((s) =>
        s.session
          ? {
              session: {
                ...s.session,
                inputTokens: evt.input_tokens ?? s.session.inputTokens,
                outputTokens: evt.output_tokens ?? s.session.outputTokens,
                costUsd: evt.cost_usd ?? s.session.costUsd,
              },
            }
          : s,
      );
      break;

    case "context_usage":
      set({ contextTokens: evt.total_tokens ?? 0 });
      break;

    case "model_changed": {
      const modelId: string | undefined = evt.model;
      if (!modelId) break;
      const provider = get().providers.find((p) => p.id === get().activeModel?.providerId);
      const modelInfo = provider?.models.find((m) => m.id === modelId)
        ?? (get().availableModels ?? []).find((m) => m.id === modelId);
      set((s) => ({
        activeModel: s.activeModel
          ? {
              ...s.activeModel,
              id: modelId,
              label: modelInfo?.label ?? modelId,
              contextWindow: modelInfo ? modelContextWindow(modelInfo) : s.activeModel.contextWindow,
            }
          : s.activeModel,
      }));
      break;
    }

    case "turn_end":
      flushStreamBuffers(set, get);
      get().finishStream(evt.stop_reason ?? "end_turn");
      // The agent's writes are only visible in the workbench after a refresh;
      // do it automatically so Changes reflects the just-finished turn.
      void get().refreshWorkspace().catch(() => {});
      {
        const s = get();
        const threshold = s.settings.autoCompactThreshold;
        const window = s.activeModel?.contextWindow ?? 0;
        const cooledDown = Date.now() - lastCompactAt > COMPACT_COOLDOWN_MS;
        if (
          threshold > 0 &&
          window > 0 &&
          s.contextTokens > threshold * window &&
          !s.compacting &&
          cooledDown
        ) {
          void get().compactContext();
        }
      }
      break;

    case "error": {
      flushStreamBuffers(set, get);
      const message = evt.message ?? "agent error";
      const isDisconnect = /disconnected|closed|broken pipe/i.test(message);
      const disconnectState = isDisconnect
        ? { state: "disconnected" as const, detail: message, checkedAt: Date.now() }
        : get().connection;
      set((s) => {
        if (s.streaming) {
          const errorText = `⚠️ **Agent 错误**: ${message}`;
          return {
            streaming: {
              ...s.streaming,
              text: (s.streaming.text ?? "") + `\n\n⚠️ ${message}`,
              parts: [
                ...s.streaming.parts,
                { type: "text" as const, text: errorText },
              ],
            },
            connection: disconnectState,
          };
        }
        // When the error arrives after the turn already ended (e.g. the
        // child process exited between turns), surface it as a visible
        // assistant message instead of silently dropping it.
        const errorId = nextId();
        return {
          connection: disconnectState,
          messages: [
            ...s.messages,
            {
              id: errorId,
              role: "assistant" as const,
              parts: [{ type: "text" as const, text: `⚠️ **Agent 错误**: ${message}` }],
              createdAt: Date.now(),
            },
          ],
        };
      });
      break;
    }

    case "status":
    default:
      // Log only — could show in a status bar in P2.
      console.log("[grok]", evt);
      break;
  }
  if (evt?.type !== "status") scheduleConversationSave(get);
}

function formatActionArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  try { const value = JSON.stringify(args); return value.length > 180 ? `${value.slice(0, 177)}…` : value; } catch { return undefined; }
}

export function conversationTitle(
  messages: Message[],
  fallback = "新任务",
  source: "auto" | "manual" = "auto",
): string {
  if (source === "manual") return fallback;
  const firstUserText = messages
    .find((message) => message.role === "user")
    ?.parts.find((part): part is Extract<Message["parts"][number], { type: "text" }> => part.type === "text")
    ?.text;
  const baseTitle = firstUserText?.replace(/\s+/g, " ").trim() || fallback;
  return baseTitle.length > 36 ? `${baseTitle.slice(0, 35)}…` : baseTitle;
}

function supportsOfficialReasoningEffort(model: ActiveModel | null): boolean {
  return model?.providerId === "xai" && model.id === "grok-4.5";
}

// Mode permissions are enforced by the Grok CLI sandbox (process-level),
// not by per-message text. Wrapping the prompt with a mode instruction
// would just bloat the agent's context without changing behavior.
function instructionForMode(_mode: WorkspaceMode, text: string): string {
  return text;
}
