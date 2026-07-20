import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Setter, Getter } from "./app-store";
import {
  applyEvent,
  conversationActivityTimestamp,
  conversationContentChanged,
  conversationTitle,
  hydrateConversation,
  mergePersistedAppState,
  sortConversationRecords,
  toggleConversationPin,
  useAppStore,
} from "./app-store";
import type { Session, ActiveModel, ProviderInfo, ConversationRecord } from "../types";

function makeInitialState(overrides: Partial<AppState> = {}): AppState {
  return {
    ready: false,
    providers: [],
    activeModel: null,
    session: null,
    messages: [],
    streaming: null,
    toolCalls: {},
    activity: [],
    workspace: null,
    selectedFile: null,
    selectedDiff: null,
    panel: "changes",
    mode: "build",
    planSteps: [],
    permissionRequest: null,
    screen: "chat",
    workbenchVisible: false,
    autoApprove: true,
    history: [],
    activeConversationId: null,
    reasoningEffort: "high",
    cancelPending: false,
    connection: { state: "idle" },
    ...overrides,
  } as AppState;
}

function createMockStore(initial: AppState) {
  let state = initial;
  const get: Getter = () => state;
  const set: Setter = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...next };
  };
  return { get, set, getState: () => state };
}

const baseSession: Session = {
  id: "sess-1",
  title: "test",
  workspace: "/tmp",
  turns: 0,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.01,
  cacheHit: false,
};

const baseModel: ActiveModel = {
  providerId: "xai",
  id: "grok-4.5",
  label: "Grok 4.5",
  contextWindow: 131072,
};

const baseProviders: ProviderInfo[] = [
  {
    id: "xai",
    name: "xAI",
    kind: "xai",
    enabled: true,
    models: [
      { id: "grok-4.5", label: "Grok 4.5", context: 131072 },
      { id: "grok-4", label: "Grok 4", context: 65536 },
    ],
  },
];

const liveStoreSnapshot = useAppStore.getState();

afterEach(() => {
  vi.useRealTimers();
  useAppStore.setState(liveStoreSnapshot, true);
});

describe("applyEvent — usage_update", () => {
  it("replaces cumulative totals instead of accumulating (last-writer-wins)", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ session: { ...baseSession, inputTokens: 100, outputTokens: 50, costUsd: 0.01 } }),
    );
    applyEvent(set, get, { type: "usage_update", input_tokens: 300, output_tokens: 150, cost_usd: 0.05 });
    const s = getState();
    expect(s.session!.inputTokens).toBe(300);
    expect(s.session!.outputTokens).toBe(150);
    expect(s.session!.costUsd).toBe(0.05);
  });

  it("does not double-count when the same cumulative value is sent twice", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ session: { ...baseSession, inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
    );
    applyEvent(set, get, { type: "usage_update", input_tokens: 500, output_tokens: 200, cost_usd: 0.1 });
    applyEvent(set, get, { type: "usage_update", input_tokens: 500, output_tokens: 200, cost_usd: 0.1 });
    const s = getState();
    expect(s.session!.inputTokens).toBe(500);
    expect(s.session!.outputTokens).toBe(200);
    expect(s.session!.costUsd).toBe(0.1);
  });

  it("preserves previous value when event field is missing", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ session: { ...baseSession, inputTokens: 100, outputTokens: 50, costUsd: 0.01 } }),
    );
    applyEvent(set, get, { type: "usage_update" });
    const s = getState();
    expect(s.session!.inputTokens).toBe(100);
    expect(s.session!.outputTokens).toBe(50);
    expect(s.session!.costUsd).toBe(0.01);
  });
});

describe("applyEvent — model_changed", () => {
  it("updates activeModel id and label from provider catalog", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ activeModel: baseModel, providers: baseProviders }),
    );
    applyEvent(set, get, { type: "model_changed", model: "grok-4" });
    const s = getState();
    expect(s.activeModel!.id).toBe("grok-4");
    expect(s.activeModel!.label).toBe("Grok 4");
    expect(s.activeModel!.contextWindow).toBe(65536);
  });

  it("uses model id as label when model not in catalog", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ activeModel: baseModel, providers: baseProviders }),
    );
    applyEvent(set, get, { type: "model_changed", model: "grok-5-custom" });
    const s = getState();
    expect(s.activeModel!.id).toBe("grok-5-custom");
    expect(s.activeModel!.label).toBe("grok-5-custom");
  });

  it("uses the live agent catalog metadata when a model is not built in", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({
        activeModel: baseModel,
        providers: [baseProviders[0]],
        availableModels: [{ id: "grok-code-fast", label: "Grok Code Fast", contextWindow: 262144 }],
      }),
    );
    applyEvent(set, get, { type: "model_changed", model: "grok-code-fast" });
    expect(getState().activeModel).toMatchObject({
      id: "grok-code-fast",
      label: "Grok Code Fast",
      contextWindow: 262144,
    });
  });

  it("does nothing when model id is missing", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ activeModel: baseModel, providers: baseProviders }),
    );
    applyEvent(set, get, { type: "model_changed" });
    expect(getState().activeModel).toEqual(baseModel);
  });
});

describe("model selection and persistence regressions", () => {
  it("switches to a model reported only by the live ACP handshake", async () => {
    useAppStore.setState({
      ...liveStoreSnapshot,
      providers: [{ ...baseProviders[0], models: [baseProviders[0].models[0]] }],
      availableModels: [{ id: "grok-code-fast", label: "Grok Code Fast", contextWindow: 262144 }],
      activeModel: baseModel,
    }, true);

    await useAppStore.getState().setActiveModel("xai", "grok-code-fast");
    expect(useAppStore.getState().activeModel).toEqual({
      providerId: "xai",
      id: "grok-code-fast",
      label: "Grok Code Fast",
      contextWindow: 262144,
    });
  });

  it("keeps new settings defaults when rehydrating an older settings object", () => {
    const current = {
      ...liveStoreSnapshot,
      settings: { ...liveStoreSnapshot.settings, language: "zh-CN" as const, autoCompactThreshold: 0.35 },
    };
    const merged = mergePersistedAppState({ settings: { theme: "light" } }, current);
    expect(merged.settings.theme).toBe("light");
    expect(merged.settings.language).toBe("zh-CN");
    expect(merged.settings.autoCompactThreshold).toBe(0.35);
    expect(merged.settings.clearErrorOnSend).toBe(true);
  });
});

describe("applyEvent — error", () => {
  it("preserves an active-stream error in visible message parts", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({
        session: baseSession,
        streaming: { messageId: "m1", text: "partial output", parts: [], actions: [] },
      }),
    );
    applyEvent(set, get, { type: "error", message: "something broke" });
    const s = getState();
    expect(s.streaming).not.toBeNull();
    expect(s.streaming!.text).toContain("⚠️ something broke");
    expect(s.streaming!.text).toContain("partial output");
    expect(s.streaming!.parts).toContainEqual({
      type: "text",
      text: "⚠️ **Agent 错误**: something broke",
    });
  });

  it("adds a visible assistant message when streaming is null", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ session: baseSession, streaming: null, messages: [] }),
    );
    applyEvent(set, get, { type: "error", message: "agent disconnected" });
    const s = getState();
    expect(s.streaming).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("assistant");
    expect(s.messages[0].parts[0]).toMatchObject({ type: "text" });
    expect((s.messages[0].parts[0] as any).text).toContain("agent disconnected");
  });

  it("sets connection to disconnected on disconnect-like errors", () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({ session: baseSession, streaming: null, messages: [] }),
    );
    applyEvent(set, get, { type: "error", message: "stdout closed unexpectedly" });
    expect(getState().connection.state).toBe("disconnected");
  });
});

describe("live conversation safety", () => {
  it("does not queue a message while a permission change is reconnecting", async () => {
    useAppStore.setState({
      ...liveStoreSnapshot,
      session: baseSession,
      connection: { state: "connecting" },
      switching: true,
      streaming: null,
      messages: [],
      queuedMessages: [],
    }, true);

    await useAppStore.getState().sendMessage("keep this draft visible");

    expect(useAppStore.getState().queuedMessages).toEqual([]);
    expect(useAppStore.getState().messages).toEqual([]);
  });

  it("removes an active conversation and its queued messages before starting a blank task", async () => {
    const record: ConversationRecord = {
      id: "active-conversation",
      agentSessionId: "agent-active",
      title: "active",
      workspace: "/tmp",
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }], createdAt: 1 }],
      queuedMessages: [{ id: "q1", text: "follow up", createdAt: 2 }],
      createdAt: 1,
      updatedAt: 1,
    };
    useAppStore.setState({
      ...liveStoreSnapshot,
      history: [record],
      activeConversationId: record.id,
      session: { ...baseSession, id: "agent-active" },
      messages: record.messages,
      queuedMessages: record.queuedMessages ?? [],
      connection: { state: "connected" },
    }, true);

    await useAppStore.getState().deleteConversation(record.id);

    const state = useAppStore.getState();
    expect(state.history.some((entry) => entry.id === record.id)).toBe(false);
    expect(state.queuedMessages).toEqual([]);
    expect(state.activeConversationId).not.toBe(record.id);
  });

  it("dispatches a queued edit immediately when the agent is idle and connected", async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      ...liveStoreSnapshot,
      session: baseSession,
      activeConversationId: "active-conversation",
      connection: { state: "connected" },
      streaming: null,
      queuedMessages: [],
      messages: [],
    }, true);

    useAppStore.getState().queueMessage("resend this");
    await Promise.resolve();

    const state = useAppStore.getState();
    expect(state.queuedMessages).toEqual([]);
    expect(state.messages.at(-1)?.parts).toContainEqual({ type: "text", text: "resend this" });
  });
});

describe("applyEvent — ordered thought phases", () => {
  it("keeps thought → reply → thought in order and finalizes each duration", async () => {
    const { get, set, getState } = createMockStore(
      makeInitialState({
        session: baseSession,
        streaming: { messageId: "m1", text: "", parts: [], actions: [] },
      }),
    );

    applyEvent(set, get, { type: "reasoning", delta: "first analysis" });
    await new Promise((resolve) => setTimeout(resolve, 70));
    applyEvent(set, get, { type: "text_delta", delta: "First reply." });
    await new Promise((resolve) => setTimeout(resolve, 70));
    applyEvent(set, get, { type: "reasoning", delta: "second analysis" });
    await new Promise((resolve) => setTimeout(resolve, 70));
    applyEvent(set, get, { type: "tool_call_start", id: "tool-1", name: "read", args: {} });

    const parts = getState().streaming!.parts;
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "text", "reasoning", "tool_call"]);
    const thoughts = parts.filter((part) => part.type === "reasoning");
    expect(thoughts).toHaveLength(2);
    expect(thoughts.every((part) => part.type === "reasoning" && part.thought.finishedAt)).toBe(true);
  });
});

describe("conversationContentChanged", () => {
  const saved: ConversationRecord = {
    id: "conversation-1",
    agentSessionId: "agent-1",
    title: "读取 README",
    workspace: "/workspace",
    messages: [{
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "读取 README" }],
      createdAt: 1,
    }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, turns: 1 },
    createdAt: 1,
    updatedAt: 2,
  };

  it("does not treat a transcript snapshot timestamp as a conversation update", () => {
    expect(conversationContentChanged(saved, {
      ...saved,
      agentSessionId: "new-runtime-session",
      messages: [{ ...saved.messages[0], createdAt: 999 }],
    })).toBe(false);
  });

  it("detects an actual transcript or usage change", () => {
    expect(conversationContentChanged(saved, {
      ...saved,
      messages: [...saved.messages, {
        id: "message-2",
        role: "assistant",
        parts: [{ type: "text", text: "README 已读取" }],
        createdAt: 2,
      }],
    })).toBe(true);
    expect(conversationContentChanged(saved, {
      ...saved,
      usage: { ...saved.usage!, outputTokens: 6 },
    })).toBe(true);
  });
});

describe("conversation activity ordering", () => {
  const older: ConversationRecord = {
    id: "older",
    title: "older",
    messages: [],
    createdAt: 1,
    updatedAt: 100,
    lastActivityAt: 10,
  };
  const newer: ConversationRecord = {
    id: "newer",
    title: "newer",
    messages: [],
    createdAt: 2,
    updatedAt: 20,
    lastActivityAt: 20,
  };

  it("uses legacy updatedAt only when lastActivityAt is absent", () => {
    expect(conversationActivityTimestamp({ ...older, lastActivityAt: undefined, updatedAt: 30 })).toBe(30);
  });

  it("keeps checkpointed conversations in place but promotes actual activity", () => {
    const checkpointedOlder = { ...older, updatedAt: 999 };
    expect(sortConversationRecords([newer, checkpointedOlder]).map((record) => record.id)).toEqual(["newer", "older"]);

    const activeOlder = { ...older, lastActivityAt: 1_000, updatedAt: 1_000 };
    expect(sortConversationRecords([newer, activeOlder]).map((record) => record.id)).toEqual(["older", "newer"]);
  });

  it("does not use a pin as a recency sort key", () => {
    const olderPinned = { ...older, pinned: true };
    expect(sortConversationRecords([olderPinned, newer]).map((record) => record.id)).toEqual(["newer", "older"]);
  });

  it("changes only the pin flag, never a conversation activity timestamp", () => {
    expect(toggleConversationPin(older)).toMatchObject({
      pinned: true,
      updatedAt: older.updatedAt,
      lastActivityAt: older.lastActivityAt,
    });
  });
});

describe("conversationTitle", () => {
  it("uses the first user message as a concise automatic title", () => {
    expect(conversationTitle([{
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "  帮我把这个项目的自动化测试补完整  " }],
      createdAt: 1,
    }])).toBe("帮我把这个项目的自动化测试补完整");
  });

  it("keeps a title the user renamed manually", () => {
    expect(conversationTitle([{
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "帮我把这个项目的自动化测试补完整" }],
      createdAt: 1,
    }], "测试覆盖", "manual")).toBe("测试覆盖");
  });
});

describe("hydrateConversation", () => {
  it("makes the stored transcript visible before runtime resume", () => {
    const record: ConversationRecord = {
      id: "saved-1",
      agentSessionId: "agent-1",
      title: "已保存会话",
      workspace: "/repo-fix",
      messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "继续修复" }], createdAt: 1 }],
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 0, turns: 2 },
      createdAt: 1,
      updatedAt: 2,
      lastActivityAt: 1,
    };

    const hydrated = hydrateConversation(record, baseSession);

    expect(hydrated.activeConversationId).toBe(record.id);
    expect(hydrated.messages).toEqual(record.messages);
    expect(hydrated.streaming).toBeNull();
    expect(hydrated.session).toMatchObject({ title: record.title, workspace: record.workspace, turns: 2 });
  });

  it("restores queued follow-ups with the transcript before runtime resume", () => {
    const record: ConversationRecord = {
      id: "saved-queue",
      title: "排队会话",
      workspace: "/repo",
      messages: [],
      queuedMessages: [{ id: "queued-1", text: "等完成后继续", createdAt: 3 }],
      createdAt: 1,
      updatedAt: 2,
    };

    const hydrated = hydrateConversation(record, baseSession);

    expect(hydrated.queuedMessages).toEqual(record.queuedMessages);
  });
});
