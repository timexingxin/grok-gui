// Drop-in replacement for `@tauri-apps/plugin-updater`, backed by
// `electron-updater` (wired in main.ts under the `updater:*` channels).

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  downloadAndInstall(): Promise<void>;
}

export async function check(): Promise<UpdateCheckResult | null> {
  if (typeof window === "undefined" || !window.electron) return null;
  const result = await window.electron.checkForUpdates();
  if (!result) return null;
  return {
    available: result.available,
    version: result.version,
    downloadAndInstall: async () => {
      await window.electron!.downloadAndInstallUpdate();
    },
  };
}
