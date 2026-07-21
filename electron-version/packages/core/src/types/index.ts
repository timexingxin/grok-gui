/**
 * Shared domain types for the Grok GUI frontend. These mirror the
 * `GrokEvent` enum defined in `apps/desktop/src-tauri/src/grok_runtime.rs`.
 *
 * When in doubt, the Rust side is the source of truth; this file should
 * be kept in lock-step with the serde rename rules there.
 */

export type ProviderKind =
  | "xai"
  | "openai"
  | "anthropic"
  | "google"
  | "openai_compat";

export interface ModelInfo {
  id: string;            // e.g. "grok-4", "claude-sonnet-4-5", "deepseek-v4-flash"
  label: string;         // human display
  context?: number;      // max context tokens
  reasoning?: boolean;   // emits reasoning blocks
  toolCall?: boolean;    // supports native tool/function calling
  cost?: {
    inputPerMTok: number;  // USD per 1M input tokens
    outputPerMTok: number; // USD per 1M output tokens
  };
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;     // e.g. "ANTHROPIC_API_KEY"
  enabled: boolean;
  models: ModelInfo[];
}

export interface ActiveModel {
  providerId: string;
  id: string;
  label: string;
  /** Context window reported by the provider/ACP handshake, when available. */
  contextWindow?: number;
}

/** A model the running agent reported in its ACP initialize handshake. */
export interface AvailableModel {
  id: string;
  label: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export type Role = "user" | "assistant" | "system";

export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
  output?: string;
  isError?: boolean;
  status: "running" | "ok" | "error";
  startedAt: number;
  finishedAt?: number;
}

/** A distinct reasoning phase in the agent's event stream. */
export interface ThoughtRecord {
  id: string;
  text: string;
  startedAt: number;
  finishedAt?: number;
}

export interface AgentAction {
  id: string;
  title: string;
  detail?: string;
  outcome: "announced" | "approved" | "completed" | "error";
  createdAt: number;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; thought: ThoughtRecord }
  | { type: "tool_call"; call: ToolCallRecord };

export interface Message {
  id: string;
  role: Role;
  parts: MessagePart[];
  createdAt: number;
  trace?: { reasoning?: string; actions: AgentAction[] };
}

/** A local follow-up that has not been sent to the ACP session yet. */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  /** A user-selected next instruction. At most one item is guided. */
  guided?: boolean;
}

/** A locally saved transcript paired with its durable Grok ACP session. */
export interface ConversationRecord {
  id: string;
  /** ACP session id. Reopening restores the agent's actual server-side state. */
  agentSessionId?: string;
  title: string;
  /** Whether the title came from the first prompt or was explicitly renamed. */
  titleSource?: "auto" | "manual";
  workspace?: string;
  messages: Message[];
  /** Durable local queue. These are intentionally absent from the ACP transcript. */
  queuedMessages?: QueuedMessage[];
  usage?: UsageSummary;
  createdAt: number;
  /** Last real user/agent transcript activity; checkpoint saves never change it. */
  lastActivityAt?: number;
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  contextWindow?: number;
}

export type AgentConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface AgentConnection {
  state: AgentConnectionState;
  detail?: string;
  checkedAt?: number;
}

export interface Session {
  id: string;
  title: string;
  workspace?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheHit: boolean;
}

export type WorkspaceMode = "ask" | "plan" | "build";

/** Codex-style workspace permission levels, mapped onto WorkspaceMode for the
 * running agent. Display-only labels; the real Grok sandbox is process-bound
 * so changing the level reconnects the agent. */
export type PermissionLevel =
  | "always_ask"      // 每次工具调用都询问；最安全
  | "read_only"       // 仅读取类工具自动执行
  | "sensitive_ask"   // 普通读取自动；敏感操作先询问
  | "ask_write"       // 写入工作区前询问；工作区外写入和主机命令被阻止
  | "trust_workspace" // 工作区内修改不再询问；工作区外写入和主机命令仍被阻止
  | "full_access";    // 不询问且拥有完整权限

export function modeForLevel(level: PermissionLevel): WorkspaceMode {
  switch (level) {
    case "always_ask":
    case "sensitive_ask":
      return "ask";
    case "read_only":
    case "ask_write":
      return "plan";
    case "trust_workspace":
    case "full_access":
      return "build";
  }
}
export type WorkspacePanel = "changes" | "files" | "terminal" | "plan";
/** Official xAI levels for Grok 4.5. Other model families are intentionally
 * not included until their supported levels are verified. */
export type ReasoningEffort = "low" | "medium" | "high";

export interface WorkspaceChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface WorkspaceFile {
  path: string;
  depth: number;
  isDir: boolean;
}

export interface WorkspaceWorktree {
  path: string;
  branch: string | null;
  detached: boolean;
  isCurrent: boolean;
  dirty: boolean;
}

export interface WorkspaceOverview {
  root: string;
  name: string;
  branch: string | null;
  worktrees: WorkspaceWorktree[];
  changes: WorkspaceChange[];
  files: WorkspaceFile[];
}

export interface WorkspaceText {
  path: string;
  content: string;
}

export interface PermissionOption {
  id: string;
  label: string;
  kind: string;
}

export type ScheduledTaskPriority = "low" | "medium" | "high";
export type ScheduledTaskStatus = "pending" | "running" | "completed" | "paused" | "failed";
/** once: fire immediately on creation; scheduled: fire at scheduledAt; branch: re-arm daily after each run. */
export type ScheduledTaskMode = "once" | "scheduled" | "branch";

export interface ScheduledTask {
  id: string;
  title: string;
  content: string;
  priority: ScheduledTaskPriority;
  status: ScheduledTaskStatus;
  mode: ScheduledTaskMode;
  model?: string;
  /** Epoch ms when the task should fire. Absent for `once`. */
  scheduledAt?: number;
  lastRunAt?: number;
  /** Store turn counter at the moment this task's prompt was sent. The
   * scheduler treats a "running" task as finished only once a later turn
   * completes, so other conversations' in-flight turns can't reclaim it. */
  turnSeqStarted?: number;
  createdAt: number;
}

export interface PermissionRequest {
  requestId: number;
  title: string;
  detail: string;
  options: PermissionOption[];
}

/** Live streaming state. */
export interface StreamingState {
  messageId: string;
  text: string;
  /** Ordered so thought → reply → next thought keeps its actual chronology. */
  parts: MessagePart[];
  activeToolCall?: ToolCallRecord;
  actions: AgentAction[];
}

/** UI appearance settings. All values persist locally and apply immediately. */
export type Theme = "light" | "dark" | "system";
export type AccentColor = "blue" | "orange" | "violet" | "emerald" | "rose" | "sky";
export type UiLanguage = "zh-CN" | "en-US";

export interface UiSettings {
  theme: Theme;
  accent: AccentColor;
  language: UiLanguage;
  /** True after the user has gone through the first-run language picker. */
  languageChosen: boolean;
  /** UI font size in px (12-18). */
  fontSize: number;
  /** Max width of the chat content area in px (640-1200). */
  chatMaxWidth: number;
  /** Show interactive highlight when hovering over interactive elements. */
  interactiveEffects: boolean;
  /** Show token & cost in the status area. */
  showTokenUsage: boolean;
  /** Show the model's reasoning summary inside the activity timeline. */
  showReasoningSummary: boolean;
  /** Expand shell/terminal tool cards by default. */
  expandShellToolParts: boolean;
  /** Expand edit/write/patch tool cards by default. */
  expandEditToolParts: boolean;
  /** Send /compact automatically once context usage exceeds this ratio. */
  autoCompactThreshold: number;
  /** Send a message automatically clears the previous Agent-error stub. */
  clearErrorOnSend: boolean;
  /** Default workspace directory (used when starting a new task without one). */
  defaultWorkspace: string;
  /** Default conversation directory (auto-created for un-bound conversations). */
  defaultConversationDir: string;
}
