// Drop-in replacement for `@tauri-apps/api/event`.
//
// Two families of events flow through the copied application code:
//  - Backend-pushed events ("grok:event", "grok:device-auth") that Tauri
//    delivered over its IPC event bus. These now travel over
//    `window.electron.onEvent` (contextBridge -> ipcRenderer.on), which
//    main.ts's `webContents.send()` calls feed.
//  - OS-level file drag-and-drop ("tauri://drag-enter/-leave/-drop"), which
//    Tauri's runtime synthesizes from native window events. Electron never
//    routes these through IPC at all — they are plain HTML5 DOM drag events
//    on the window — so this shim translates them locally instead of
//    forwarding to the main process.

type UnlistenFn = () => void;
interface EventLike<T> {
  payload: T;
}

// Without this, the browser's default "navigate to the dropped file"
// action fires before our `drop` handler runs.
if (typeof window !== "undefined") {
  window.addEventListener("dragover", (event) => event.preventDefault());
}

export async function listen<T = unknown>(
  channel: string,
  handler: (event: EventLike<T>) => void,
): Promise<UnlistenFn> {
  if (channel === "tauri://drag-enter") {
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      handler({ payload: undefined as T });
    };
    window.addEventListener("dragenter", onDragEnter);
    return () => window.removeEventListener("dragenter", onDragEnter);
  }
  if (channel === "tauri://drag-leave") {
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      handler({ payload: undefined as T });
    };
    window.addEventListener("dragleave", onDragLeave);
    return () => window.removeEventListener("dragleave", onDragLeave);
  }
  if (channel === "tauri://drag-drop") {
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths = files
        .map((file) => window.electron?.getPathForFile(file))
        .filter((value): value is string => Boolean(value));
      handler({ payload: { paths } as T });
    };
    window.addEventListener("drop", onDrop);
    return () => window.removeEventListener("drop", onDrop);
  }

  if (typeof window === "undefined" || !window.electron) {
    return () => {};
  }
  return window.electron.onEvent<T>(channel, (payload) => handler({ payload }));
}
