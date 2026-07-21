// Ambient type for the contextBridge surface exposed by electron/preload.ts.
export interface ElectronBridge {
  invoke<T = unknown>(channel: string, args?: unknown): Promise<T>;
  onEvent<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    properties?: string[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  getPathForFile(file: File): string;
  checkForUpdates(): Promise<{ available: boolean; version?: string } | null>;
  downloadAndInstallUpdate(): Promise<void>;
  platform: string;
}

declare global {
  interface Window {
    electron?: ElectronBridge;
    /** Set from `src/main.tsx` so the application code's pre-existing
     * `isTauri()` / `__TAURI_INTERNALS__` desktop-shell checks (copied
     * unchanged from the Tauri build) also recognize the Electron shell. */
    __TAURI_INTERNALS__?: unknown;
  }
}
