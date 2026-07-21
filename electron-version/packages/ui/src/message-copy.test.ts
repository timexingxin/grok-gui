import { describe, expect, it } from "vitest";
import type { Message } from "@grok-gui/core";
import { canCopyMessage, copyableMessageText } from "./message-copy";

const assistantMessage: Message = {
  id: "assistant-1",
  role: "assistant",
  createdAt: 1,
  parts: [
    { type: "reasoning", thought: { id: "thought-1", text: "internal analysis", startedAt: 1 } },
    { type: "tool_call", call: { id: "tool-1", name: "Read", args: { path: "secret" }, status: "ok", startedAt: 1 } },
    { type: "text", text: "## 完成情况\n\n主要输出内容。" },
  ],
};

describe("copyableMessageText", () => {
  it("copies only visible answer text, excluding thought and tool data", () => {
    expect(copyableMessageText(assistantMessage)).toBe("## 完成情况\n\n主要输出内容。");
    expect(canCopyMessage(assistantMessage)).toBe(true);
  });

  it("does not report copy success for a tool-only message", () => {
    const toolOnly: Message = {
      ...assistantMessage,
      parts: assistantMessage.parts.filter((part) => part.type !== "text"),
    };
    expect(copyableMessageText(toolOnly)).toBe("");
    expect(canCopyMessage(toolOnly)).toBe(false);
  });
});
