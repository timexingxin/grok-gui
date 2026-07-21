// Drop-in replacement for `@tauri-apps/plugin-dialog`'s `open()`, backed by
// Electron's native `dialog.showOpenDialog` (invoked in main.ts under the
// `dialog:showOpenDialog` channel).

export interface OpenDialogOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
}

export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (typeof window === "undefined" || !window.electron) return null;
  const properties: string[] = [options.directory ? "openDirectory" : "openFile"];
  if (options.multiple) properties.push("multiSelections");
  const result = await window.electron.showOpenDialog({
    title: options.title,
    defaultPath: options.defaultPath,
    properties: properties as never,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return options.multiple ? result.filePaths : result.filePaths[0];
}
