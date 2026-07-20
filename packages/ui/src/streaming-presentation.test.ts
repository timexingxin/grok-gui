import { describe, expect, it } from "vitest";
import { shouldShowStreamingCaret } from "./streaming-presentation";

describe("shouldShowStreamingCaret", () => {
  it("does not render a standalone caret for an empty stream text part", () => {
    expect(shouldShowStreamingCaret("", true)).toBe(false);
  });

  it("renders the caret only after visible final text", () => {
    expect(shouldShowStreamingCaret("正在读取文件", true)).toBe(true);
    expect(shouldShowStreamingCaret("正在读取文件", false)).toBe(false);
  });
});
