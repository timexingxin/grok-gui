// Electron entry point for Grok GUI.
// Architecture:
//   Renderer (React) <-> ipcMain/webContents.send <-> grok-runtime (ACP / stdio)
//
// Translated from apps/desktop/src-tauri/src/lib.rs's `run()` /
// `open_session_window` / asset-protocol setup.

import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from "electron";
import { join } from "node:path";
import { registerCommands, allowedImagePaths } from "./commands";
import { autoUpdater } from "electron-updater";

const PROTOCOL = "grok-asset";

protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** Windows keyed by their Tauri-equivalent label (`session-<8 char prefix>`)
 * so `open_session_window` can no-op if a window for that session is
 * already open, matching `app.get_webview_window(&label).is_some()`. */
const windowsByLabel = new Map<string, BrowserWindow>();

function createWindow(label: string, options: Electron.BrowserWindowConstructorOptions, query?: Record<string, string>): BrowserWindow {
  const win = new BrowserWindow({
    title: "Grok GUI",
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // macOS: hide the native title bar so the dark UI fills the whole window
    // and the traffic-light buttons float over the content (no white bar, no
    // title text). Non-macOS keeps the standard frame.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...options,
  });
  windowsByLabel.set(label, win);
  win.on("closed", () => windowsByLabel.delete(label));
  win.once("ready-to-show", () => win.show());

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), { query });
  }
  return win;
}

async function openSessionWindow(sessionId: string): Promise<void> {
  const prefix = sessionId.slice(0, 8);
  const label = `session-${prefix}`;
  const existing = windowsByLabel.get(label);
  if (existing) {
    existing.focus();
    return;
  }
  createWindow(
    label,
    { title: `Grok GUI · ${prefix}`, width: 1100, height: 720 },
    { session: sessionId },
  );
}

app.whenReady().then(() => {
  // Serve exactly the files `allow_image_preview` has approved. This is the
  // Electron equivalent of Tauri's per-file asset-protocol scope.
  protocol.handle(PROTOCOL, async (request) => {
    const requestedPath = decodeURIComponent(request.url.slice(`${PROTOCOL}://`.length)).replace(/\/$/, "");
    if (!allowedImagePaths.has(requestedPath)) {
      return new Response("forbidden", { status: 403 });
    }
    return fetch(`file://${requestedPath}`);
  });

  // Content-Security-Policy mirrors tauri.conf.json's `app.security.csp`.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self' ${PROTOCOL}:; connect-src 'self'; img-src 'self' ${PROTOCOL}: blob: data:; style-src 'self' 'unsafe-inline'`,
        ],
      },
    });
  });

  registerCommands({ openSessionWindow });

  // Native "choose a folder/file" dialog, used by the `@tauri-apps/plugin-dialog`
  // shim (packages/ui/src/Sidebar.tsx's "open workspace" picker).
  ipcMain.handle("dialog:showOpenDialog", (_event, options: Electron.OpenDialogOptions) =>
    dialog.showOpenDialog(options),
  );

  // electron-updater equivalent of the `@tauri-apps/plugin-updater` shim
  // used by packages/ui/src/SettingsPage.tsx's "check for updates" button.
  ipcMain.handle("updater:check", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo?.version;
      const available = !!version && version !== app.getVersion();
      return available ? { available: true, version } : { available: false };
    } catch {
      return { available: false };
    }
  });
  ipcMain.handle("updater:download_and_install", async () => {
    await autoUpdater.downloadUpdate();
    autoUpdater.quitAndInstall();
  });

  createWindow("main", {});

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow("main", {});
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Never let the renderer navigate to arbitrary external sites or spawn
// unauthenticated child windows — the same intent as Tauri's default CSP.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
});
