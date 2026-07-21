import { describe, expect, it } from "vitest";
import { shouldSubmitOnEnter } from "./composition-input";

describe("shouldSubmitOnEnter", () => {
  it("submits an ordinary Enter press", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false }, false)).toBe(true);
  });

  it("keeps Shift+Enter for a newline", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true }, false)).toBe(false);
  });

  it("does not submit while React composition is active", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false }, true)).toBe(false);
  });

  it("does not submit an Enter reported as natively composing", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
  });

  it("does not submit the legacy IME key code", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, keyCode: 229 }, false)).toBe(false);
  });
});
