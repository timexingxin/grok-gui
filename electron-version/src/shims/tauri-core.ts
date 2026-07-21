// Drop-in replacement for `@tauri-apps/api/core`, aliased in
// electron.vite.config.ts so the copied application code (App.tsx,
// packages/core/src/stores/app-store.ts, packages/ui/src/*.tsx) needs no
// per-call-site edits: every `import { invoke } from "@tauri-apps/api/core"`
// resolves here instead, and `invoke()` now goes out over
// `window.electron.invoke` (contextBridge -> ipcRenderer.invoke) rather than
// Tauri's IPC bridge.

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === "undefined" || !window.electron) {
    throw new Error(`invoke("${cmd}") called outside the Electron renderer`);
  }
  return window.electron.invoke<T>(cmd, args);
}

/** Tauri's asset-protocol path -> URL converter. Our main process exposes
 * the same concept as a custom `grok-asset://` protocol scoped to files the
 * `allow_image_preview` command has approved. */
export function convertFileSrc(filePath: string, _protocol = "asset"): string {
  return `grok-asset://${encodeURIComponent(filePath)}`;
}
