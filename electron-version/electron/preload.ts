// contextBridge surface consumed by src/shims/tauri-*.ts. Keeping this
// small and generic (invoke/onEvent/dialog/file-path) means the shim layer
// — not this file — encodes Tauri-specific semantics.

import { contextBridge, ipcRenderer, webUtils } from "electron";

export interface ElectronBridge {
  invoke<T = unknown>(channel: string, args?: unknown): Promise<T>;
  onEvent<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  getPathForFile(file: File): string;
  checkForUpdates(): Promise<{ available: boolean; version?: string } | null>;
  downloadAndInstallUpdate(): Promise<void>;
  platform: string;
}

const bridge: ElectronBridge = {
  invoke: (channel, args) => ipcRenderer.invoke(channel, args),
  onEvent: (channel, callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload as never);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  showOpenDialog: (options) => ipcRenderer.invoke("dialog:showOpenDialog", options),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadAndInstallUpdate: () => ipcRenderer.invoke("updater:download_and_install"),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("electron", bridge);
