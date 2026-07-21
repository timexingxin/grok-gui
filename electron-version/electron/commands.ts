// Electron main-process command surface.
//
// Translated from the `#[tauri::command]` functions and `AppState` in
// apps/desktop/src-tauri/src/lib.rs. Every exported Tauri command becomes an
// `ipcMain.handle` registration with the same command name and (as closely
// as IPC argument shape allows) the same parameter names the frontend
// already sends, so `packages/core/src/stores/app-store.ts` needed no
// call-site edits — only the transport shim in `src/shims/` changed.

import { ipcMain, BrowserWindow, shell, powerSaveBlocker } from "electron";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  resolveGrokBin,
  grokCliCandidatesFor,
  expandTilde,
  homeDir,
  OFFICIAL_INSTALLER_SCRIPT,
  validateApiKey,
} from "./cli";
import { saveApiKey, getAuthMode } from "./auth";
import { GrokRuntime, type GrokEvent, type SessionOptions } from "./grok-runtime";
import { SessionPool, MAX_RUNTIMES, nextSpawnHint } from "./session-pool";
import * as workspace from "./workspace";

const execFileAsync = promisify(execFile);
const APP_VERSION = "0.1.0";

class AppState {
  runtimes = new SessionPool();
  activeSession: string | null = null;
  keepAwakeBlockerId: number | null = null;
}

const state = new AppState();

/** Absolute file paths the renderer is currently allowed to load through the
 * `grok-asset://` protocol. Mirrors Tauri's per-file asset-protocol scope
 * (`app.asset_protocol_scope().allow_file(...)`), which only ever grants
 * access to one user-selected image at a time. */
export const allowedImagePaths = new Set<string>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function requireRuntime(sessionId: string): Promise<GrokRuntime> {
  const runtime = state.runtimes.get(sessionId);
  if (!runtime) {
    throw new Error(`没有找到会话 ${sessionId} 的活动 Agent 运行时。它可能已被回收或结束，请重新连接。`);
  }
  return runtime;
}

const PREVIEWABLE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "ico"]);
export function isPreviewableImage(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return PREVIEWABLE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// CLI install / auth
// ---------------------------------------------------------------------------

async function installOfficialGrokCli(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn("powershell", ["-NoProfile", "-Command", `irm ${OFFICIAL_INSTALLER_SCRIPT} | iex`], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn("/bin/zsh", ["-lc", OFFICIAL_INSTALLER_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => reject(new Error("无法启动官方 Grok Build 安装器。")));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("官方 Grok Build 安装未完成，请检查网络后重试。"));
    });
  });
}

async function loginGrok(args: string[]): Promise<void> {
  const grokBin = resolveGrokBin();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(grokBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => reject(new Error("无法启动 Grok Build 官方登录。")));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("官方登录未完成，请在浏览器完成授权后重试。"));
    });
  });
}

/** Device authentication is interactive: the CLI prints a URL and code
 * before it exits. Waiting for full completion would discard those
 * instructions, leaving the GUI user unable to continue — so every stdout
 * and stderr line streams to the renderer as it arrives. */
async function loginGrokDeviceCode(): Promise<void> {
  const grokBin = resolveGrokBin();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(grokBin, ["login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => reject(new Error("无法启动 Grok Build 设备码登录。")));
    const forward = (stream: NodeJS.ReadableStream) => {
      let buffer = "";
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          broadcast("grok:device-auth", { message: line });
        }
      });
    };
    forward(child.stdout);
    forward(child.stderr);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("官方设备码登录未完成，请完成浏览器授权后重试。"));
    });
  });
}

// ---------------------------------------------------------------------------
// grok CLI passthrough (MCP / inspect)
// ---------------------------------------------------------------------------

async function runGrokJson(args: string[], cwd?: string): Promise<unknown> {
  const grokBin = resolveGrokBin();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(grokBin, args, { cwd, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error: any) {
    throw new Error((error?.stderr ?? String(error)).toString().trim());
  }
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Grok 返回了非 JSON 输出：${error}`);
  }
}

async function runGrokSuccess(args: string[], cwd?: string): Promise<null> {
  const grokBin = resolveGrokBin();
  try {
    await execFileAsync(grokBin, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  } catch (error: any) {
    throw new Error((error?.stderr ?? String(error)).toString().trim());
  }
  return null;
}

/** ACP requires each MCP server to be supplied at session creation. Grok's
 * CLI configuration uses a compact shape, so translate it into ACP's actual
 * stdio/HTTP shapes rather than starting every session with `mcpServers: []`. */
async function configuredMcpServers(workspacePath: string): Promise<unknown[]> {
  let configured: unknown;
  try {
    configured = await runGrokJson(["mcp", "list", "--json"], workspacePath);
  } catch {
    // Non-fatal: start the session without MCP servers.
    return [];
  }
  return mcpServersFromList(configured);
}

export function mcpServersFromList(configured: unknown): unknown[] {
  let servers: any[];
  if (Array.isArray(configured)) {
    servers = configured;
  } else if (Array.isArray((configured as any)?.servers)) {
    servers = (configured as any).servers;
  } else if (Array.isArray((configured as any)?.mcpServers)) {
    servers = (configured as any).mcpServers;
  } else {
    return [];
  }
  const result: unknown[] = [];
  for (const server of servers) {
    if (server?.enabled === false) continue;
    const name = server?.name;
    if (typeof name !== "string") continue;
    if (typeof server?.command === "string") {
      result.push({
        name,
        command: server.command,
        args: Array.isArray(server?.args) ? server.args : [],
        // ACP specifies env as an array of { name, value } entries.
        // `grok mcp list` deliberately does not expose configured secrets,
        // so credentials remain in the CLI-owned config rather than being
        // copied into the GUI process or its persisted UI state.
        env: [],
      });
    } else if (typeof server?.url === "string") {
      result.push({ name, url: server.url, headers: [] });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

interface StartSessionArgs {
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort?: string | null;
  executionMode: string;
  resumeSessionId?: string | null;
}

interface StartSessionResponse {
  session_id: string;
  workspace: string;
  context_window?: number;
  available_models: unknown[];
}

async function startSession(args: StartSessionArgs): Promise<StartSessionResponse> {
  const expanded = expandTilde(args.workspacePath);

  // Fast path: a live runtime for this session id already exists, so we
  // return immediately without spawning. isAlive() is non-blocking — a
  // zombie entry (child exited but slot still present) drops out so the
  // spawn path below can take over.
  if (args.resumeSessionId) {
    const existing = state.runtimes.get(args.resumeSessionId);
    if (existing && existing.isAlive()) {
      state.activeSession = args.resumeSessionId;
      return {
        session_id: args.resumeSessionId,
        workspace: expanded,
        context_window: existing.contextWindow,
        available_models: existing.availableModels,
      };
    }
    if (existing) {
      // Pool entry survived the liveness check; the child must have exited.
      // Remove it so the new spawn doesn't collide.
      state.runtimes.remove(args.resumeSessionId);
    }
  }

  // Admission control. The hint token is reserved BEFORE we touch the
  // expensive ACP handshake so a surge of concurrent calls cannot all burn
  // a child process only to find the pool full on insert.
  const hint = nextSpawnHint();
  if (!state.runtimes.tryAdmit(hint, args.resumeSessionId ?? "")) {
    throw new Error(`并发会话已达上限（${MAX_RUNTIMES}），全部正在执行任务，请等待其中一个完成后再试。`);
  }

  // Spawn outside any lock (Node has none to hold); a spawn failure rolls
  // the reservation back so the slot is freed for the next call immediately.
  let sessionIdForEvents: string | undefined;
  const sessionOptions: SessionOptions = {
    reasoningEffort: args.reasoningEffort,
    executionMode: args.executionMode,
    mcpServers: await configuredMcpServers(expanded),
    resumeSessionId: args.resumeSessionId,
  };

  let runtime: GrokRuntime;
  try {
    runtime = await GrokRuntime.spawn(expanded, args.provider, args.model, sessionOptions, (evt: GrokEvent) => {
      broadcast("grok:event", { session_id: sessionIdForEvents, event: evt });
    });
  } catch (error: any) {
    state.runtimes.releaseReservation(hint);
    throw new Error(String(error?.message ?? error));
  }

  const sessionId = runtime.sessionId;
  sessionIdForEvents = sessionId;

  // Promote the admission placeholder into a real slot.
  const evicted = state.runtimes.insert(sessionId, runtime, hint);
  state.activeSession = sessionId;

  // Evicted (if any) is shut down WITHOUT markShuttingDown: this is not an
  // expected epoch replacement, so its disconnect event must reach the
  // frontend so the user sees that session ended.
  if (evicted) {
    await evicted.shutdown();
  }

  return {
    session_id: sessionId,
    workspace: expanded,
    context_window: runtime.contextWindow,
    available_models: runtime.availableModels,
  };
}

export async function saveClipboardImage(args: { workspacePath?: string; filename: string; base64: string }): Promise<string> {
  // ~14MB of base64 ~= 10MB of image data; refuse unbounded clipboard dumps.
  if (args.base64.length > 14 * 1024 * 1024) {
    throw new Error("图片超过 10MB 大小限制。");
  }
  const safeName = path.basename(args.filename) || "clipboard.png";
  const expanded = expandTilde(args.workspacePath ?? "~");
  const dir = path.join(expanded, ".grok-gui-paste");
  await fs.mkdir(dir, { recursive: true });
  const stem = path.parse(safeName).name || "clipboard";
  const extension = path.parse(safeName).ext.replace(/^\./, "");
  let target = path.join(dir, safeName);
  while (fsSync.existsSync(target)) {
    const suffix = crypto.randomUUID();
    const name = extension ? `${stem}-${suffix}.${extension}` : `${stem}-${suffix}`;
    target = path.join(dir, name);
  }
  const buffer = Buffer.from(args.base64, "base64");
  await fs.writeFile(target, buffer);
  return target;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface CommandDeps {
  /** Opens (or focuses, if already open) a secondary window scoped to one
   * session id. Owned by main.ts so window creation stays in one place. */
  openSessionWindow: (sessionId: string) => Promise<void>;
}

export function registerCommands(deps: CommandDeps): void {
  ipcMain.handle("ping", async () => ({
    ok: true,
    version: APP_VERSION,
    session_id: state.activeSession,
  }));

  ipcMain.handle("detect_grok_cli", async () => {
    const custom = process.env.GROK_BIN;
    const home = homeDir();
    for (const candidate of grokCliCandidatesFor(custom, home, process.env.PATH)) {
      if (!fsSync.existsSync(candidate) || !fsSync.statSync(candidate).isFile()) continue;
      try {
        const { stdout } = await execFileAsync(candidate, ["--version"]);
        return { installed: true, path: candidate, version: stdout.trim() };
      } catch {
        continue;
      }
    }
    return { installed: false, path: null, version: null };
  });

  ipcMain.handle("install_official_grok_cli", async () => {
    await installOfficialGrokCli();
  });

  ipcMain.handle("login_grok_oauth", async () => {
    await loginGrok(["login", "--oauth"]);
  });

  ipcMain.handle("login_grok_device_code", async () => {
    await loginGrokDeviceCode();
  });

  ipcMain.handle("save_xai_api_key", async (_event, args: { key: string }) => {
    const normalized = validateApiKey(args.key);
    saveApiKey(normalized);
  });

  ipcMain.handle("get_auth_mode", async () => {
    const mode = getAuthMode();
    return { kind: mode.kind, logged_in: mode.loggedIn, has_api_key: mode.hasApiKey };
  });

  ipcMain.handle("check_connection", async (_event, args: { sessionId: string }) => {
    const runtime = state.runtimes.get(args.sessionId);
    if (!runtime) {
      return { connected: false, session_id: null, detail: "没有活动 Agent 会话。" };
    }
    try {
      await runtime.healthCheck();
      return { connected: true, session_id: runtime.sessionId, detail: null };
    } catch (error: any) {
      return { connected: false, session_id: runtime.sessionId, detail: String(error?.message ?? error) };
    }
  });

  ipcMain.handle("start_session", async (_event, args: StartSessionArgs) => startSession(args));

  ipcMain.handle("stop_session", async (_event, args: { sessionId: string }) => {
    const runtime = state.runtimes.remove(args.sessionId);
    if (runtime) {
      runtime.markShuttingDown();
      await runtime.shutdown();
    }
    if (state.activeSession === args.sessionId) state.activeSession = null;
  });

  ipcMain.handle("list_active_sessions", async () => state.runtimes.activeIds());

  ipcMain.handle("cancel_turn", async (_event, args: { sessionId: string }) => {
    const runtime = await requireRuntime(args.sessionId);
    await runtime.cancelTurn();
  });

  /** Ask the agent to compress its conversation history (`/compact` slash
   * command). Runs as a normal turn, so the frontend's regular event flow
   * (usage_update, turn_end) applies without special-casing. */
  ipcMain.handle("compact_session", async (_event, args: { sessionId: string }) => {
    const runtime = await requireRuntime(args.sessionId);
    await runtime.sendUserMessage("/compact");
  });

  ipcMain.handle("send_message", async (_event, args: { sessionId: string; text: string }) => {
    const runtime = await requireRuntime(args.sessionId);
    await runtime.sendUserMessage(args.text);
  });

  ipcMain.handle("set_model", async (_event, args: { sessionId: string; model: string }) => {
    const runtime = await requireRuntime(args.sessionId);
    await runtime.setModel(args.model);
  });

  ipcMain.handle("respond_permission", async (_event, args: { sessionId: string; requestId: number; optionId: string }) => {
    const runtime = await requireRuntime(args.sessionId);
    await runtime.respondPermission(args.requestId, args.optionId);
  });

  ipcMain.handle("set_auto_approve", async (_event, args: { sessionId: string; enabled: boolean }) => {
    const runtime = await requireRuntime(args.sessionId);
    runtime.setAutoApprove(args.enabled);
  });

  ipcMain.handle("list_providers", async () => []);

  ipcMain.handle("inspect_grok_configuration", async (_event, args: { workspacePath: string }) =>
    runGrokJson(["inspect", "--json"], expandTilde(args.workspacePath)),
  );

  ipcMain.handle("list_mcp_servers", async (_event, args: { workspacePath: string }) =>
    runGrokJson(["mcp", "list", "--json"], expandTilde(args.workspacePath)),
  );

  ipcMain.handle("diagnose_mcp_server", async (_event, args: { name: string; workspacePath: string }) =>
    runGrokJson(["mcp", "doctor", args.name, "--json"], expandTilde(args.workspacePath)),
  );

  ipcMain.handle("upsert_mcp_server", async (_event, args: { workspacePath: string; input: any }) => {
    const input = args.input;
    // The original CLI arg key was `command_or_url`; accept either spelling
    // in case the caller sends the JS-conventional camelCase form.
    const commandOrUrl: string = input?.command_or_url ?? input?.commandOrUrl ?? "";
    if (!input?.name?.trim() || !commandOrUrl.trim()) {
      throw new Error("MCP 名称和命令（或 URL）不能为空。");
    }
    if (!["stdio", "http", "sse"].includes(input.transport)) {
      throw new Error("不支持的 MCP transport。");
    }
    if (!["user", "project"].includes(input.scope)) {
      throw new Error("MCP scope 必须为 user 或 project。");
    }
    const cliArgs = ["mcp", "add", "--transport", input.transport, "--scope", input.scope, input.name];
    if (input.transport === "stdio") cliArgs.push("--");
    cliArgs.push(commandOrUrl);
    if (Array.isArray(input.args)) cliArgs.push(...input.args);
    return runGrokSuccess(cliArgs, expandTilde(args.workspacePath));
  });

  ipcMain.handle("remove_mcp_server", async (_event, args: { name: string; scope?: string; workspacePath: string }) => {
    if (!args.name?.trim()) throw new Error("MCP 名称不能为空。");
    const cliArgs = ["mcp", "remove"];
    if (args.scope) {
      if (!["user", "project"].includes(args.scope)) throw new Error("MCP scope 必须为 user 或 project。");
      cliArgs.push("--scope", args.scope);
    }
    cliArgs.push(args.name);
    return runGrokSuccess(cliArgs, expandTilde(args.workspacePath));
  });

  ipcMain.handle("workspace_overview", async (_event, args: { workspacePath: string }) =>
    workspace.overview(expandTilde(args.workspacePath)),
  );

  ipcMain.handle("workspace_file", async (_event, args: { workspacePath: string; relativePath: string }) =>
    workspace.readText(expandTilde(args.workspacePath), args.relativePath),
  );

  ipcMain.handle("workspace_diff", async (_event, args: { workspacePath: string; relativePath: string }) =>
    workspace.diff(expandTilde(args.workspacePath), args.relativePath),
  );

  ipcMain.handle("save_clipboard_image", async (_event, args: { workspacePath?: string; filename: string; base64: string }) =>
    saveClipboardImage(args),
  );

  /** Grant the custom asset protocol access to one user-selected image. This
   * keeps the allowlist narrow while allowing previews for images on
   * external volumes. */
  ipcMain.handle("allow_image_preview", async (_event, args: { path: string }) => {
    const requested = expandTilde(args.path);
    let canonical: string;
    try {
      canonical = await fs.realpath(requested);
    } catch (error) {
      throw new Error(`无法读取图片：${error}`);
    }
    const stat = await fs.stat(canonical);
    if (!stat.isFile() || !isPreviewableImage(canonical)) {
      throw new Error("只能预览受支持的图片文件。");
    }
    allowedImagePaths.add(canonical);
  });

  ipcMain.handle("show_in_finder", async (_event, args: { path: string }) => {
    const expanded = expandTilde(args.path);
    const stat = await fs.stat(expanded).catch((e) => {
      throw new Error(`无法访问路径：${e}`);
    });
    const target = stat.isDirectory() ? expanded : path.dirname(expanded);
    const error = await shell.openPath(target);
    if (error) throw new Error(`Finder 打开失败：${error}`);
  });

  ipcMain.handle("open_session_window", async (_event, args: { sessionId: string }) => {
    await deps.openSessionWindow(args.sessionId);
  });

  ipcMain.handle("set_keep_awake", async (_event, args: { enabled: boolean }) => {
    // The Rust build shelled out to macOS-only `caffeinate`. Electron's
    // built-in powerSaveBlocker covers the same "keep the machine awake
    // while a long agent turn runs" need on every desktop platform.
    if (args.enabled) {
      if (state.keepAwakeBlockerId !== null) return;
      state.keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (state.keepAwakeBlockerId !== null) {
      powerSaveBlocker.stop(state.keepAwakeBlockerId);
      state.keepAwakeBlockerId = null;
    }
  });
}

export { state as appState };
