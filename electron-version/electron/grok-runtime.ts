// Grok Build runtime — full stdio/JSON-RPC client for `grok agent stdio`.
//
// Translated from apps/desktop/src-tauri/src/grok_runtime.rs. Wire format:
// line-delimited JSON-RPC 2.0 on stdin/stdout. We act as an ACP (Agent
// Client Protocol) client; the agent is a server that sends us
// `session/update` notifications plus permission and project-scoped `fs/*`
// requests. Permissions are surfaced to the GUI rather than auto-approved.
//
// Reference: https://github.com/xai-org/grok-build
//            crates/codegen/xai-acp-lib/ in the upstream tree.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import { resolveGrokBin } from "./cli";
import { getApiKey } from "./auth";
import * as workspace from "./workspace";

// ---------------------------------------------------------------------------
// Event / model types
// ---------------------------------------------------------------------------

export type GrokEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; id: string; name: string; args: unknown }
  | { type: "tool_call_update"; id: string; status: string; output?: string }
  | { type: "plan_update"; steps: string[] }
  | { type: "usage_update"; input_tokens: number; output_tokens: number; cost_usd: number }
  /** Live context-window occupancy reported via `_meta.totalTokens` on every
   * xAI session update. Unlike cumulative usage (billing), this is the
   * actual number of tokens currently sitting in the context window. */
  | { type: "context_usage"; total_tokens: number }
  | { type: "model_changed"; model: string }
  | { type: "permission_request"; request_id: number; title: string; detail: string; options: PermissionOption[] }
  /** A durable, user-visible pre-action record. Emitted before an agent tool
   * or automatic permission decision so execution is never silent even when
   * the user selected unattended mode. */
  | { type: "action_notice"; title: string; detail: string; outcome: string }
  | { type: "turn_end"; stop_reason: string }
  | { type: "error"; message: string }
  | { type: "status"; message: string };

export interface PermissionOption {
  id: string;
  label: string;
  kind: string;
}

/** A model the agent reported during the ACP initialize handshake. The UI
 * builds its model picker from this list instead of a static guess, so
 * newly released Grok models appear without a GUI update. */
export interface ModelDescriptor {
  id: string;
  label: string;
  contextWindow?: number;
  reasoning: boolean;
}

type EventSink = (evt: GrokEvent) => void;

const MODE_ASK = 0;
const MODE_PLAN = 1;
const MODE_BUILD = 2;

/** Inputs that determine an ACP session at process-creation time. Keeping
 * them together prevents new launch controls from silently bypassing the
 * runtime's security/session handshake. */
export interface SessionOptions {
  reasoningEffort?: string | null;
  executionMode: string;
  mcpServers: unknown[];
  resumeSessionId?: string | null;
}

/** Minimal async mutex: `tokio::sync::Mutex` has no lock-free JS equivalent,
 * but Node's single-threaded event loop means a promise-chain queue gives
 * the same mutual-exclusion guarantee for interleaved async operations. */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async lock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => held);
    await previous;
    return release;
  }
}

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const APP_VERSION = "0.1.0";

export class GrokRuntime {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 10;
  private pending = new Map<number, PendingResponse>();
  private requestLock = new AsyncMutex();
  // The product default is "announce, then run": every action is recorded
  // in the UI, but routine permission choices don't stall a headless coding
  // turn waiting for another click.
  private autoApprove = true;
  private isShuttingDownFlag = false;
  /** True while a turn is in flight. The session pool skips busy runtimes
   * during LRU eviction so a long running turn is never silently killed to
   * make room for a new session. */
  private isBusyFlag = false;
  private fullAccess: boolean;
  private executionModeCode: number;
  private modelId: string;
  private workspaceRoot: string;
  private sink: EventSink;

  public sessionId = "";
  public contextWindow?: number;
  public availableModels: ModelDescriptor[] = [];

  private constructor(opts: {
    child: ChildProcessWithoutNullStreams;
    modelId: string;
    workspaceRoot: string;
    executionModeCode: number;
    fullAccess: boolean;
    sink: EventSink;
  }) {
    this.child = opts.child;
    this.modelId = opts.modelId;
    this.workspaceRoot = opts.workspaceRoot;
    this.executionModeCode = opts.executionModeCode;
    this.fullAccess = opts.fullAccess;
    this.sink = opts.sink;
  }

  /**
   * Spawn `grok agent stdio` and complete the initialize + session
   * handshake. `onEvent` is invoked for every agent notification (text
   * deltas, tool calls, plan updates, etc.) as it arrives on stdout.
   */
  static async spawn(
    workspacePath: string,
    _provider: string,
    model: string,
    options: SessionOptions,
    onEvent: EventSink,
  ): Promise<GrokRuntime> {
    const grokBin = resolveGrokBin();
    const fsPromises = await import("node:fs/promises");
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await fsPromises.realpath(workspacePath);
    } catch (e) {
      throw new Error(`invalid workspace ${workspacePath}: ${e}`);
    }

    const args: string[] = [...launchPolicyArgs(options.executionMode)];
    if (options.reasoningEffort) {
      if (!["low", "medium", "high"].includes(options.reasoningEffort)) {
        throw new Error(`unsupported reasoning effort: ${options.reasoningEffort}`);
      }
      args.push("--reasoning-effort", options.reasoningEffort);
    }
    args.push("agent", "stdio");

    const env = { ...process.env };
    const apiKey = getApiKey();
    if (apiKey) env.XAI_API_KEY = apiKey;

    const child = spawn(grokBin, args, { env, stdio: ["pipe", "pipe", "pipe"] });

    const runtime = new GrokRuntime({
      child,
      modelId: model,
      workspaceRoot: canonicalWorkspace,
      executionModeCode: modeCode(options.executionMode),
      // The CLI sandbox and the ACP filesystem bridge must agree. Without
      // this initialization Build started the CLI with full access but
      // still rejected out-of-workspace ACP file requests in the bridge.
      fullAccess: modeGrantsFullAccess(options.executionMode),
      sink: onEvent,
    });

    // --- stdout reader: line-delimited JSON-RPC ---
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      // Has `id` and no `method` -> it's a response to a request we sent.
      if (msg.id !== undefined && msg.method === undefined) {
        const pending = runtime.pending.get(msg.id);
        if (pending) {
          runtime.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(`agent error: ${JSON.stringify(msg.error)}`));
          else pending.resolve(msg.result ?? null);
        }
        return;
      }
      void runtime.handleIncoming(msg);
    });
    child.stdout.once("close", () => {
      if (!runtime.isShuttingDownFlag) {
        runtime.sink({ type: "error", message: "Grok agent disconnected. Start a new task to reconnect." });
        runtime.sink({ type: "turn_end", stop_reason: "error" });
      }
    });

    // --- stderr drainer: surface as `status` events for the UI ---
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      const msg = line.trimEnd();
      if (msg) runtime.sink({ type: "status", message: msg });
    });

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (e) =>
        reject(new Error(`failed to spawn \`${grokBin} agent stdio\` — is grok on PATH? (${e})`)),
      );
    });

    // --- Initialize handshake (synchronous: wait for response) ---
    const handshake = (async () => {
      await runtime.sendRequestWithId(1, "initialize", {
        protocolVersion: 1,
        clientInfo: { name: "grok-gui", version: APP_VERSION },
      });
      const initResult = await runtime.awaitResponse(1);

      runtime.contextWindow = contextWindowForModel(initResult, model);
      runtime.availableModels = availableModelsFromInit(initResult);

      const [sessionMethod, sessionParams] = options.resumeSessionId
        ? ["session/load", { sessionId: options.resumeSessionId, cwd: workspacePath, mcpServers: options.mcpServers }]
        : ["session/new", { cwd: workspacePath, mcpServers: options.mcpServers }];
      await runtime.sendRequestWithId(2, sessionMethod, sessionParams);
      const sessionResult = await runtime.awaitResponse(2);
      runtime.sessionId = extractSessionId(sessionResult, options.resumeSessionId ?? undefined);

      // The CLI starts with the account default. Apply the requested model
      // explicitly so the first turn uses the model shown by the UI.
      await runtime.sendRequestWithId(3, "session/set_model", { sessionId: runtime.sessionId, modelId: model });
      await runtime.awaitResponse(3);
    })();

    await Promise.race([handshake, spawnFailure]);
    return runtime;
  }

  /** Send a user prompt. The ACP result marks the end of the request while
   * content itself is delivered independently via `session/update`. */
  async sendUserMessage(text: string): Promise<void> {
    const release = await this.requestLock.lock();
    this.isBusyFlag = true;
    try {
      const id = this.nextId++;
      await this.writeFrame({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      });
      // A `session/prompt` result only arrives after the whole turn drains -
      // long builds routinely exceed the 15s default used by handshakes.
      await this.awaitResponse(id, 600_000);
    } finally {
      this.isBusyFlag = false;
      release();
    }
  }

  /** Switch model mid-session. */
  async setModel(model: string): Promise<void> {
    const release = await this.requestLock.lock();
    try {
      const id = this.nextId++;
      await this.writeFrame({
        jsonrpc: "2.0",
        id,
        method: "session/set_model",
        params: { sessionId: this.sessionId, modelId: model },
      });
      await this.awaitResponse(id);
      this.modelId = model;
    } finally {
      release();
    }
  }

  /** Non-blocking liveness probe: returns false if the child has exited.
   * Cheaper than `healthCheck` (no JSON-RPC round-trip). */
  isAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Check both the child process and the active ACP session. Unlike a
   * process-local "session exists" flag, this confirms that the agent still
   * accepts a request on its JSON-RPC stream. */
  async healthCheck(): Promise<void> {
    if (!this.isAlive()) {
      throw new Error(`grok agent exited: code=${this.child.exitCode} signal=${this.child.signalCode}`);
    }
    // Setting the already-selected model is an idempotent ACP request and
    // verifies the exact session without changing user-visible state. Skip
    // if a turn is currently in flight (request lock is effectively held).
    if (this.isBusyFlag) return;
    const release = await this.requestLock.lock();
    try {
      const id = this.nextId++;
      await this.writeFrame({
        jsonrpc: "2.0",
        id,
        method: "session/set_model",
        params: { sessionId: this.sessionId, modelId: this.modelId },
      });
      await this.awaitResponse(id);
    } finally {
      release();
    }
  }

  /** ACP specifies cancellation as a notification, not a request/reply RPC.
   * The agent subsequently emits its regular terminal turn update, so the
   * frontend can retain partial text and completed tool calls. */
  async cancelTurn(): Promise<void> {
    await this.writeFrame({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    });
  }

  async respondPermission(requestId: number, optionId: string): Promise<void> {
    await this.writeFrame({ jsonrpc: "2.0", id: requestId, result: { optionId } });
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  /** Mark this runtime as shutting down without actually killing the child
   * process. Used when the runtime is being replaced so the reader loop
   * stops emitting user-facing "disconnected" errors during the gap between
   * pool removal and `shutdown()`. */
  markShuttingDown(): void {
    this.isShuttingDownFlag = true;
  }

  isBusy(): boolean {
    return this.isBusyFlag;
  }

  async shutdown(): Promise<void> {
    this.isShuttingDownFlag = true;
    this.child.kill();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // JSON-RPC plumbing
  // -------------------------------------------------------------------------

  private writeFrame(frame: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private sendRequestWithId(id: number, method: string, params: unknown): Promise<void> {
    return this.writeFrame({ jsonrpc: "2.0", id, method, params });
  }

  private awaitResponse(id: number, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response id=${id}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Incoming message router (requests + notifications from the agent)
  // -------------------------------------------------------------------------

  private async handleIncoming(msg: any): Promise<void> {
    const method: string | undefined = msg.method;
    if (!method) return;
    const id: number | undefined = msg.id;
    const params = msg.params ?? {};

    if (id !== undefined) {
      await this.handleIncomingRequest(id, method, params);
      return;
    }

    // Notification. Grok Build embeds cumulative usage data inside
    // turn_completed updates rather than as a standalone usage_update.
    // Extract it first so the UI reflects final token/cost before the
    // stream ends.
    const usageEvent = extractEmbeddedUsage(method, params);
    if (usageEvent) this.sink(usageEvent);
    const totalTokens = params?._meta?.totalTokens;
    if (typeof totalTokens === "number") {
      this.sink({ type: "context_usage", total_tokens: totalTokens });
    }
    this.sink(translateNotification(method, params));
  }

  private async handleIncomingRequest(id: number, method: string, params: any): Promise<void> {
    switch (method) {
      case "request_permission":
      case "session/request_permission": {
        const permission = permissionEvent(id, params);
        if (this.executionModeCode === MODE_BUILD && (this.fullAccess || this.autoApprove)) {
          const optionId = preferredPermissionOption(permission.options);
          this.sink({ type: "action_notice", title: `即将执行：${permission.title}`, detail: permission.detail, outcome: "announced" });
          if (optionId) {
            // Give the renderer a moment to paint the notice before the
            // agent is allowed to continue. This is notification, not a
            // confirmation gate.
            await sleep(250);
            this.sink({ type: "action_notice", title: "已自动允许", detail: `已选择权限选项：${optionId}`, outcome: "approved" });
            try {
              await this.respondPermission(id, optionId);
            } catch (error) {
              this.sink({ type: "error", message: `自动授权失败：${error}` });
            }
          } else {
            this.sink({ type: "error", message: "权限请求没有可用的允许选项。" });
          }
        } else {
          const denyId = preferredDenyOption(permission.options);
          this.sink({ type: "action_notice", title: `已拦截：${permission.title}`, detail: `当前模式不允许此操作。${permission.detail}`, outcome: "approved" });
          if (denyId) {
            await this.respondPermission(id, denyId);
          } else {
            await this.autoRespond(id, { error: { code: -32001, message: "operation blocked by current execution mode" } });
          }
        }
        break;
      }
      case "fs/read_text_file":
      case "session/fs/read_text_file": {
        if (this.executionModeCode === MODE_ASK) {
          this.sink({ type: "action_notice", title: "已拦截读取文件", detail: "提问模式禁止读取工作区。", outcome: "approved" });
          await this.autoRespond(id, { error: { code: -32001, message: "file reads are blocked in Ask mode" } });
          return;
        }
        this.sink({ type: "action_notice", title: "即将读取文件", detail: requestPath(params), outcome: "announced" });
        await this.handleReadTextFile(id, params);
        this.sink({ type: "action_notice", title: "已处理读取请求", detail: requestPath(params), outcome: "completed" });
        break;
      }
      case "fs/write_text_file":
      case "session/fs/write_text_file": {
        if (this.executionModeCode !== MODE_BUILD) {
          this.sink({ type: "action_notice", title: "已拦截写入文件", detail: "规划和提问模式禁止写入文件。", outcome: "approved" });
          await this.autoRespond(id, { error: { code: -32001, message: "file writes are blocked outside Build mode" } });
          return;
        }
        this.sink({ type: "action_notice", title: "即将写入文件", detail: requestPath(params), outcome: "announced" });
        await this.handleWriteTextFile(id, params);
        this.sink({ type: "action_notice", title: "已处理写入请求", detail: requestPath(params), outcome: "completed" });
        break;
      }
      default:
        await this.autoRespond(id, { error: { code: -32601, message: `not implemented: ${method}` } });
    }
  }

  private async autoRespond(id: number, result: unknown): Promise<void> {
    try {
      await this.writeFrame({ jsonrpc: "2.0", id, result });
    } catch {
      // Pipe closed; nothing more to do.
    }
  }

  private resolveAgentPath(requested: string): Promise<string> {
    if (this.fullAccess) {
      return Promise.resolve(path.isAbsolute(requested) ? requested : path.join(this.workspaceRoot, requested));
    }
    return workspace.resolveWorkspacePath(this.workspaceRoot, requested);
  }

  private async handleReadTextFile(id: number, params: any): Promise<void> {
    const filePath: string = params.path ?? params.uri ?? "";
    try {
      const allowedPath = await this.resolveAgentPath(filePath);
      const fsPromises = await import("node:fs/promises");
      const stat = await fsPromises.stat(allowedPath);
      if (stat.size > 512 * 1024) {
        await this.autoRespond(id, { error: { code: -32002, message: "requested file exceeds 512 KiB limit" } });
        return;
      }
      const content = await fsPromises.readFile(allowedPath, "utf-8");
      await this.autoRespond(id, { content });
    } catch (error: any) {
      await this.autoRespond(id, { error: { code: -32002, message: String(error?.message ?? error) } });
    }
  }

  private async handleWriteTextFile(id: number, params: any): Promise<void> {
    const filePath: string = params.path ?? "";
    const content: string = params.content ?? "";
    try {
      const allowedPath = await this.resolveAgentPath(filePath);
      const fsPromises = await import("node:fs/promises");
      await fsPromises.mkdir(path.dirname(allowedPath), { recursive: true });
      await fsPromises.writeFile(allowedPath, content);
      await this.autoRespond(id, {});
    } catch (error: any) {
      await this.autoRespond(id, { error: { code: -32003, message: String(error?.message ?? error) } });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pure translation helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export function preferredPermissionOption(options: PermissionOption[]): string | undefined {
  const allow = options.find((option) => !["deny", "reject", "cancel"].includes(option.id.toLowerCase()));
  return allow?.id ?? options[0]?.id;
}

export function preferredDenyOption(options: PermissionOption[]): string | undefined {
  return options.find((option) => {
    const label = option.label.toLowerCase();
    const id = option.id.toLowerCase();
    return (
      option.kind.toLowerCase() === "deny" ||
      label.includes("deny") ||
      label.includes("reject") ||
      label.includes("cancel") ||
      id.includes("deny") ||
      id.includes("reject") ||
      id.includes("cancel")
    );
  })?.id;
}

function requestPath(params: any): string {
  return params?.path ?? params?.uri ?? "当前工作区";
}

function permissionEvent(requestId: number, params: any): Extract<GrokEvent, { type: "permission_request" }> {
  const rawOptions = params?.options ?? params?.permissionOptions ?? [];
  const options: PermissionOption[] = Array.isArray(rawOptions)
    ? rawOptions
        .map((option: any) => {
          const id = option?.optionId ?? option?.id;
          if (!id) return null;
          return {
            id,
            label: option?.name ?? option?.label ?? id,
            kind: option?.kind ?? "permission",
          } satisfies PermissionOption;
        })
        .filter((option: PermissionOption | null): option is PermissionOption => option !== null)
    : [];
  return {
    type: "permission_request",
    request_id: requestId,
    title: params?.title ?? params?.reason ?? "Grok requests permission",
    detail: params?.description ?? params?.details ?? "Review the requested action before continuing.",
    options,
  };
}

export function extractEmbeddedUsage(method: string, params: any): GrokEvent | undefined {
  const isSessionUpdate = [
    "session/update",
    "session_update",
    "session-update",
    "_x.ai/session/update",
    "_x.ai/session_notification",
  ].includes(method);
  if (!isSessionUpdate) return undefined;
  const update = params?.update;
  if (!update) return undefined;
  const kind = update.sessionUpdate;
  if (kind !== "turn_completed" && kind !== "turn_end") return undefined;
  const usage = update.usage;
  if (!usage) return undefined;
  return {
    type: "usage_update",
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cost_usd: usage.costUsd ?? 0,
  };
}

export function extractSessionId(result: any, resumeSessionId?: string): string {
  const id =
    result?.sessionId ??
    result?._meta?.sessionId ??
    result?._meta?.sessionDetail?.sessionId ??
    resumeSessionId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing sessionId in response");
  }
  return id;
}

export function translateNotification(method: string, params: any): GrokEvent {
  switch (method) {
    // ACP uses `session/update`; xAI's current CLI also sends its
    // completion notification on this private compatibility method.
    case "session/update":
    case "session_update":
    case "session-update":
    case "_x.ai/session/update":
    case "_x.ai/session_notification":
      return translateSessionUpdate(params);
    case "models_update":
    case "models/update":
      return { type: "model_changed", model: params?.currentModelId ?? "?" };
    case "announcements_update":
    case "announcements/update": {
      const first = params?.announcements?.[0];
      const msg = first?.title ?? first?.message ?? "agent update";
      return { type: "status", message: msg };
    }
    case "mcp_initialized":
    case "mcp/initialized":
      return { type: "status", message: `${params?.mcpToolCount ?? 0} MCP tools ready` };
    case "turn_end":
    case "turn/end":
      return { type: "turn_end", stop_reason: params?.stopReason ?? "end_turn" };
    default:
      return { type: "status", message: `[${method}]` };
  }
}

function translateSessionUpdate(params: any): GrokEvent {
  const update = params?.update;
  if (!update) return { type: "status", message: "[update]" };
  const kind: string = update.sessionUpdate ?? "";

  switch (kind) {
    case "agent_message_chunk":
      return { type: "text_delta", delta: strAt(update, ["content", "text"]) ?? "" };
    case "agent_thought_chunk":
    case "reasoning":
      return { type: "reasoning", delta: strAt(update, ["content", "text"]) ?? "" };
    case "tool_call":
    case "tool_call_update": {
      const id = strAny(update, ["toolCallId", "id"]) ?? "";
      const name = strAny(update, ["title", "name"]) ?? "tool";
      const status = update.status ?? "running";
      const output = contentText(update);
      const args = update.rawInput ?? update.input ?? null;
      if (kind === "tool_call" && ["pending", "in_progress", "running"].includes(status)) {
        return { type: "tool_call_start", id, name, args };
      }
      return { type: "tool_call_update", id, status, output };
    }
    case "plan":
      return {
        type: "plan_update",
        steps: Array.isArray(update.entries)
          ? update.entries.map((entry: any) => entry?.content).filter((v: unknown): v is string => typeof v === "string")
          : [],
      };
    case "usage":
      return {
        type: "usage_update",
        input_tokens: update.inputTokens ?? 0,
        output_tokens: update.outputTokens ?? 0,
        cost_usd: update.costUsd ?? 0,
      };
    case "model_changed":
      return { type: "model_changed", model: strAny(update, ["model_id", "modelId"]) ?? "?" };
    case "turn_completed":
    case "turn_end":
      return { type: "turn_end", stop_reason: strAny(update, ["stopReason", "stop_reason"]) ?? "end_turn" };
    case "available_commands_update":
    case "available_commands":
      return {
        type: "status",
        message: `${Array.isArray(update.availableCommands) ? update.availableCommands.length : 0} slash commands available`,
      };
    default:
      return { type: "status", message: `[${kind}]` };
  }
}

function strAt(v: any, pointer: string[]): string | undefined {
  let cur = v;
  for (const key of pointer) {
    cur = cur?.[key];
    if (cur === undefined) return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Current Grok ACP tool results are represented as content blocks rather
 * than a single `content.output` string. */
function contentText(update: any): string | undefined {
  const output = update?.content?.output;
  if (typeof output === "string") return output;

  const blocks = update?.content;
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .map((block: any) => block?.content?.text ?? block?.text)
    .filter((v: unknown): v is string => typeof v === "string")
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function strAny(v: any, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof v?.[key] === "string") return v[key];
  }
  return undefined;
}

export function contextWindowForModel(initResult: any, modelId: string): number | undefined {
  const models = initResult?._meta?.modelState?.availableModels;
  if (!Array.isArray(models)) return undefined;
  const found = models.find((m: any) => m?.modelId === modelId);
  return found?._meta?.totalContextTokens;
}

export function availableModelsFromInit(initResult: any): ModelDescriptor[] {
  const models = initResult?._meta?.modelState?.availableModels;
  if (!Array.isArray(models)) return [];
  const result: ModelDescriptor[] = [];
  for (const model of models) {
    const id = model?.modelId;
    if (typeof id !== "string") continue;
    result.push({
      id,
      label: typeof model?.name === "string" ? model.name : id,
      contextWindow: model?._meta?.totalContextTokens,
      reasoning: model?.reasoning === true,
    });
  }
  return result;
}

export function modeCode(mode: string): number {
  switch (mode) {
    case "ask":
      return MODE_ASK;
    case "plan":
      return MODE_PLAN;
    case "build":
      return MODE_BUILD;
    default:
      throw new Error(`unknown execution mode: ${mode}`);
  }
}

export function modeGrantsFullAccess(mode: string): boolean {
  return modeCode(mode) === MODE_BUILD;
}

/** These are Grok Build's documented process-start policy controls. Sandbox
 * policy is irreversible for a running process, so mode changes reconnect a
 * session instead of pretending an in-memory flag can retrofit isolation. */
export function launchPolicyArgs(mode: string): string[] {
  switch (mode) {
    case "ask":
      return ["--permission-mode", "dontAsk", "--sandbox", "strict", "--disable-web-search"];
    case "plan":
      return ["--permission-mode", "dontAsk", "--sandbox", "read-only", "--disable-web-search"];
    case "build":
      return ["--permission-mode", "bypassPermissions", "--sandbox", "off"];
    default:
      throw new Error(`unknown execution mode: ${mode}`);
  }
}
