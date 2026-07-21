// Translated from `mod cli_resolution_tests` in
// apps/desktop/src-tauri/src/lib.rs. Only importing the pure helper
// functions here — `registerCommands()` itself needs a live Electron main
// process (BrowserWindow/ipcMain) and is exercised manually via `npm run dev`.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isPreviewableImage, mcpServersFromList, saveClipboardImage } from "./commands";
import { OFFICIAL_INSTALLER_SCRIPT, resolveGrokBinFor, validateApiKey } from "./cli";

describe("resolveGrokBinFor", () => {
  it("finds the installer CLI without inheriting a terminal PATH", () => {
    const root = path.join(os.tmpdir(), `grok-gui-cli-test-${process.pid}`);
    const bin = path.join(root, ".grok/bin/grok");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "test cli");
    try {
      expect(resolveGrokBinFor(undefined, root, undefined)).toBe(bin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OFFICIAL_INSTALLER_SCRIPT", () => {
  it("is the documented xAI install command", () => {
    expect(OFFICIAL_INSTALLER_SCRIPT).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
  });
});

describe("validateApiKey", () => {
  it("rejects blank or multiline API keys", () => {
    expect(() => validateApiKey(" ")).toThrow();
    expect(() => validateApiKey("xai-one\ntwo")).toThrow();
    expect(validateApiKey("  xai-valid  ")).toBe("xai-valid");
  });
});

describe("saveClipboardImage", () => {
  it("saves a pasted image inside the workspace and sanitizes its name", async () => {
    const root = path.join(os.tmpdir(), `grok-gui-image-test-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const payload = bytes.toString("base64");

    try {
      const saved = await saveClipboardImage({ workspacePath: root, filename: "../clipboard.png", base64: payload });
      expect(path.basename(saved)).toBe("clipboard.png");
      expect(path.dirname(saved)).toBe(path.join(root, ".grok-gui-paste"));
      expect(fs.readFileSync(saved)).toEqual(bytes);

      const second = await saveClipboardImage({
        workspacePath: root,
        filename: "clipboard.png",
        base64: Buffer.from([1, 2, 3]).toString("base64"),
      });
      expect(second).not.toBe(saved);
      expect(fs.readFileSync(second)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized payload", async () => {
    const oversized = "a".repeat(14 * 1024 * 1024 + 1);
    await expect(saveClipboardImage({ workspacePath: "/tmp", filename: "x.png", base64: oversized })).rejects.toThrow(
      /10MB/,
    );
  });
});

describe("isPreviewableImage", () => {
  it("permits only supported image extensions for preview", () => {
    expect(isPreviewableImage("/Volumes/work/image.WEBP")).toBe(true);
    expect(isPreviewableImage("/Volumes/work/photo.jpeg")).toBe(true);
    expect(isPreviewableImage("/Volumes/work/readme.md")).toBe(false);
    expect(isPreviewableImage("/Volumes/work/no-extension")).toBe(false);
  });
});

describe("mcpServersFromList", () => {
  it("skips bad entries without blocking a session", () => {
    const mapped = mcpServersFromList([
      { name: "valid", command: "node", args: ["server.js"], enabled: true },
      { command: "missing-name", enabled: true },
      { name: "disabled", command: "ignored", enabled: false },
      { name: "broken", enabled: true },
    ]) as any[];
    expect(mapped).toHaveLength(1);
    expect(mapped[0].name).toBe("valid");
    expect(mapped[0].command).toBe("node");
  });

  it("tolerates an unexpected CLI JSON shape", () => {
    expect(mcpServersFromList({ servers: [] })).toEqual([]);
  });

  it("accepts a wrapped CLI server list", () => {
    const mapped = mcpServersFromList({ servers: [{ name: "wrapped", command: "node", args: ["server.js"] }] }) as any[];
    expect(mapped).toHaveLength(1);
    expect(mapped[0].name).toBe("wrapped");
  });
});
