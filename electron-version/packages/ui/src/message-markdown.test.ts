import { describe, expect, it } from "vitest";
import { normalizeGrokMarkdown } from "./message-markdown";

describe("normalizeGrokMarkdown", () => {
  it("turns raw Grok LaTeX commands into a display formula", () => {
    const source = "不满足条件等价于：\n\n[(\\text{圆苹果}=0 \\text{或} \\text{星桃子}=0) \\text{且} (\\text{圆桃子}=0 \\text{或} \\text{星苹果}=0)]";

    expect(normalizeGrokMarkdown(source)).toContain("$$[(\\text{圆苹果}=0 \\text{或} \\text{星桃子}=0) \\text{且} (\\text{圆桃子}=0 \\text{或} \\text{星苹果}=0)]$$");
  });

  it("converts TeX parenthesis delimiters into Markdown math delimiters", () => {
    expect(normalizeGrokMarkdown("结果是 \\(x^2 + y^2\\) 。")).toBe("结果是 $x^2 + y^2$ 。");
  });
});
