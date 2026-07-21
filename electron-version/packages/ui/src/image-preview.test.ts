import { describe, expect, it, vi } from "vitest";
import { imagePreviewUrl } from "./image-preview";

describe("imagePreviewUrl", () => {
  it("delegates the unmodified local path to Tauri's asset URL converter", () => {
    const convert = vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`);
    const path = "/Users/time星沁/.grok-gui-paste/clipboard image.png";

    expect(imagePreviewUrl(path, convert)).toBe(
      "asset://localhost/%2FUsers%2Ftime%E6%98%9F%E6%B2%81%2F.grok-gui-paste%2Fclipboard%20image.png",
    );
    expect(convert).toHaveBeenCalledExactlyOnceWith(path);
  });
});
