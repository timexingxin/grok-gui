// Translated from `mod tests` in
// apps/desktop/src-tauri/src/grok_runtime.rs — these pin down the ACP wire
// translation (notification shapes -> GrokEvent, session id extraction,
// launch policy args) independently of a live `grok agent stdio` process.

import { describe, expect, it } from "vitest";
import {
  availableModelsFromInit,
  contextWindowForModel,
  extractEmbeddedUsage,
  extractSessionId,
  launchPolicyArgs,
  modeGrantsFullAccess,
  preferredDenyOption,
  preferredPermissionOption,
  translateNotification,
} from "./grok-runtime";
import { parseGitChanges, parseWorktreeList, resolveWorkspacePath } from "./workspace";

describe("translateNotification", () => {
  it("translates a model_changed notification", () => {
    const event = translateNotification("_x.ai/session_notification", {
      update: { sessionUpdate: "model_changed", model_id: "grok-4.5" },
    });
    expect(event).toEqual({ type: "model_changed", model: "grok-4.5" });
  });

  it("translates the xAI turn_completed notification", () => {
    const event = translateNotification("_x.ai/session/update", {
      update: { sessionUpdate: "turn_completed", stopReason: "end_turn" },
    });
    expect(event).toEqual({ type: "turn_end", stop_reason: "end_turn" });
  });

  it("extracts nested tool output from a content block array", () => {
    const event = translateNotification("_x.ai/session/update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "run_terminal_command",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "TRACE_TOOL_OK" } }],
      },
    });
    expect(event).toEqual({ type: "tool_call_update", id: "tool-1", status: "completed", output: "TRACE_TOOL_OK" });
  });

  it("keeps a running tool update as an update, not a second start", () => {
    const event = translateNotification("session/update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Read",
        status: "running",
        content: { output: "still reading" },
      },
    });
    expect(event).toEqual({ type: "tool_call_update", id: "tool-1", status: "running", output: "still reading" });
  });

  it("starts a pending tool_call as tool_call_start", () => {
    const event = translateNotification("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-2",
        title: "Write",
        status: "pending",
        rawInput: { path: "a.txt" },
      },
    });
    expect(event).toEqual({ type: "tool_call_start", id: "tool-2", name: "Write", args: { path: "a.txt" } });
  });
});

describe("resolveWorkspacePath", () => {
  it("rejects parent traversal before touching disk", async () => {
    await expect(resolveWorkspacePath("/tmp", "../private.txt")).rejects.toThrow();
    await expect(resolveWorkspacePath("/tmp", "/etc/hosts")).rejects.toThrow();
  });
});

describe("parseWorktreeList", () => {
  it("parses porcelain worktrees and marks the selected path", () => {
    const records = parseWorktreeList(
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-fix\nHEAD def\ndetached\n\n",
      "/repo",
    );
    expect(records).toHaveLength(2);
    expect(records[0].path).toBe("/repo");
    expect(records[0].branch).toBe("main");
    expect(records[0].isCurrent).toBe(true);
    expect(records[0].detached).toBe(false);
    expect(records[1].detached).toBe(true);
  });
});

describe("parseGitChanges", () => {
  it("parses renames without creating a phantom change", () => {
    const records = parseGitChanges("R  new-name.txt\0old-name.txt\0 M kept.txt\0");
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ indexStatus: "R", worktreeStatus: " ", path: "new-name.txt" });
    expect(records[1].path).toBe("kept.txt");
  });
});

describe("extractSessionId", () => {
  it("extracts from a session/new result", () => {
    expect(extractSessionId({ sessionId: "sess-new-123" })).toBe("sess-new-123");
  });

  it("extracts from a session/load result's _meta", () => {
    expect(
      extractSessionId(
        { models: { currentModelId: "grok-4.5" }, _meta: { sessionId: "sess-loaded-456" } },
        "original-id",
      ),
    ).toBe("sess-loaded-456");
  });

  it("falls back to the resume id when the result has no session id", () => {
    expect(extractSessionId({ models: {} }, "resume-fallback-789")).toBe("resume-fallback-789");
  });

  it("throws when no session id is found anywhere", () => {
    expect(() => extractSessionId({ models: {} })).toThrow();
  });
});

describe("contextWindowForModel / availableModelsFromInit", () => {
  const initResult = {
    _meta: {
      modelState: {
        availableModels: [
          { modelId: "grok-4.5", name: "Grok 4.5", reasoning: true, _meta: { totalContextTokens: 500_000 } },
        ],
      },
    },
  };

  it("reads the context window for the selected ACP model", () => {
    expect(contextWindowForModel(initResult, "grok-4.5")).toBe(500_000);
    expect(contextWindowForModel(initResult, "other")).toBeUndefined();
  });

  it("builds the picker list from the handshake", () => {
    expect(availableModelsFromInit(initResult)).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", contextWindow: 500_000, reasoning: true },
    ]);
  });
});

describe("launchPolicyArgs / modeGrantsFullAccess", () => {
  it("maps modes to the real Grok launch policies", () => {
    expect(launchPolicyArgs("ask")).toEqual(["--permission-mode", "dontAsk", "--sandbox", "strict", "--disable-web-search"]);
    expect(launchPolicyArgs("plan")).toEqual(["--permission-mode", "dontAsk", "--sandbox", "read-only", "--disable-web-search"]);
    expect(launchPolicyArgs("build")).toEqual(["--permission-mode", "bypassPermissions", "--sandbox", "off"]);
    expect(() => launchPolicyArgs("unknown")).toThrow();
  });

  it("only build mode enables the matching filesystem policy", () => {
    expect(modeGrantsFullAccess("build")).toBe(true);
    expect(modeGrantsFullAccess("ask")).toBe(false);
    expect(modeGrantsFullAccess("plan")).toBe(false);
  });
});

describe("extractEmbeddedUsage", () => {
  it("extracts cumulative usage from turn_completed", () => {
    const event = extractEmbeddedUsage("_x.ai/session_notification", {
      update: {
        sessionUpdate: "turn_completed",
        stop_reason: "end_turn",
        usage: { inputTokens: 24856, outputTokens: 30, totalTokens: 24886, numTurns: 1 },
      },
    });
    expect(event).toEqual({ type: "usage_update", input_tokens: 24856, output_tokens: 30, cost_usd: 0 });
  });

  it("extracts usage with cost from turn_end", () => {
    const event = extractEmbeddedUsage("session/update", {
      update: { sessionUpdate: "turn_end", usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.05 } },
    });
    expect(event).toEqual({ type: "usage_update", input_tokens: 100, output_tokens: 200, cost_usd: 0.05 });
  });

  it("returns undefined for non-turn notifications", () => {
    expect(
      extractEmbeddedUsage("session/update", { update: { sessionUpdate: "agent_message_chunk" } }),
    ).toBeUndefined();
    expect(
      extractEmbeddedUsage("session/update", { update: { sessionUpdate: "turn_completed" } }),
    ).toBeUndefined();
    expect(
      extractEmbeddedUsage("some/other/method", { update: { sessionUpdate: "turn_completed", usage: {} } }),
    ).toBeUndefined();
  });
});

describe("permission option selection", () => {
  it("prefers a non-deny option and falls back to the first one", () => {
    expect(
      preferredPermissionOption([
        { id: "deny", label: "Deny", kind: "deny" },
        { id: "allow_once", label: "Allow once", kind: "allow" },
      ]),
    ).toBe("allow_once");
    expect(preferredPermissionOption([{ id: "only", label: "Only", kind: "allow" }])).toBe("only");
  });

  it("finds a deny option by kind, label, or id", () => {
    expect(preferredDenyOption([{ id: "opt-1", label: "Reject this", kind: "permission" }])).toBe("opt-1");
    expect(preferredDenyOption([{ id: "allow", label: "Allow", kind: "allow" }])).toBeUndefined();
  });
});
