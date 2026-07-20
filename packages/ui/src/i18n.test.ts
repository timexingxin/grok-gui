import { describe, expect, it } from "vitest";
import { dictionaries, t, uiLanguageOptions } from "./i18n";

describe("UI localization", () => {
  it("keeps Chinese and English dictionaries structurally identical", () => {
    expect(Object.keys(dictionaries.enUS).sort()).toEqual(Object.keys(dictionaries.zhCN).sort());
  });

  it("has no Chinese fallback text in the English dictionary", () => {
    expect(Object.values(dictionaries.enUS).join(" ")).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("selects English chrome without a Chinese fallback", () => {
    expect(t("en-US", "settings")).toBe("Settings");
    expect(t("en-US", "queue")).toBe("Add to queue");
    expect(t("en-US", "resend")).toBe("Resend");
    expect(t("zh-CN", "resend")).toBe("重发");
  });

  it("offers exactly the two supported UI languages", () => {
    expect(uiLanguageOptions).toEqual([
      { value: "zh-CN", label: "简体中文" },
      { value: "en-US", label: "English" },
    ]);
  });
});
