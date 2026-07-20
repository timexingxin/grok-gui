// Grok Build runtime — full stdio/JSON-RPC client for `grok agent stdio`.
//
// Wire format: line-delimited JSON-RPC 2.0 on stdin/stdout. We act as an
// ACP (Agent Client Protocol) client; the agent is a server that sends us
// `session/update` notifications plus permission and project-scoped `fs/*`
// requests. Permissions are surfaced to the GUI rather than auto-approved.
//
// Reference: https://github.com/xai-org/grok-build
//            crates/codegen/xai-acp-lib/ in the upstream tree.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GrokEvent {
    TextDelta {
        delta: String,
    },
    Reasoning {
        delta: String,
    },
    ToolCallStart {
        id: String,
        name: String,
        args: Value,
    },
    ToolCallUpdate {
        id: String,
        status: String,
        output: Option<String>,
    },
    PlanUpdate {
        steps: Vec<String>,
    },
    UsageUpdate {
        input_tokens: u64,
        output_tokens: u64,
        cost_usd: f64,
    },
    /// Live context-window occupancy reported via `_meta.totalTokens` on every
    /// xAI session update. Unlike cumulative usage (billing), this is the
    /// actual number of tokens currently sitting in the context window.
    ContextUsage {
        total_tokens: u64,
    },
    ModelChanged {
        model: String,
    },
    PermissionRequest {
        request_id: u64,
        title: String,
        detail: String,
        options: Vec<PermissionOption>,
    },
    /// A durable, user-visible pre-action record. This is emitted before an
    /// agent tool or automatic permission decision so execution is never
    /// silent even when the user selected unattended mode.
    ActionNotice {
        title: String,
        detail: String,
        outcome: String,
    },
    TurnEnd {
        stop_reason: String,
    },
    Error {
        message: String,
    },
    Status {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: String,
}

/// Thread-safe event sink we can clone cheaply.
type EventSink = Arc<dyn Fn(GrokEvent) + Send + Sync + 'static>;

const MODE_ASK: u8 = 0;
const MODE_PLAN: u8 = 1;
const MODE_BUILD: u8 = 2;

/// A model the agent reported during the ACP initialize handshake. The UI
/// builds its model picker from this list instead of a static guess, so newly
/// released Grok models appear without a GUI update.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescriptor {
    pub id: String,
    pub label: String,
    pub context_window: Option<u64>,
    pub reasoning: bool,
}

#[derive(Clone)]
pub struct GrokRuntime {
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    next_id: Arc<Mutex<u64>>,
    responses: Arc<Mutex<mpsc::Receiver<Value>>>,
    request_lock: Arc<Mutex<()>>,
    auto_approve: Arc<AtomicBool>,
    pub session_id: String,
    pub context_window: Option<u64>,
    pub available_models: Vec<ModelDescriptor>,
    model_id: Arc<Mutex<String>>,
    is_shutting_down: Arc<AtomicBool>,
    /// True while a turn is in flight (send_user_message holds request_lock).
    /// The session pool skips busy runtimes during LRU eviction so a long
    /// running turn is never silently killed to make room for a new session.
    is_busy: Arc<AtomicBool>,
    _child: Arc<Mutex<Child>>,
}

/// Inputs that determine an ACP session at process creation time. Keeping
/// them together prevents new launch controls from silently bypassing the
/// runtime's security/session handshake.
pub struct SessionOptions {
    pub reasoning_effort: Option<String>,
    pub execution_mode: String,
    pub mcp_servers: Vec<Value>,
    pub resume_session_id: Option<String>,
}

impl GrokRuntime {
    /// Spawn `grok agent stdio` and complete the initialize + session handshake.
    /// handshake. The `on_event` callback is invoked for every agent
    /// notification (text deltas, tool calls, plan updates, etc.) on a
    /// background tokio task.
    pub async fn spawn(
        workspace: &str,
        _provider: &str,
        _model: &str,
        options: SessionOptions,
        on_event: Box<dyn Fn(GrokEvent) + Send + Sync + 'static>,
    ) -> Result<Self> {
        let sink: EventSink = Arc::new(on_event);

        let grok_bin = crate::resolve_grok_bin().map_err(|error| anyhow!(error))?;
        let workspace_root = std::path::Path::new(workspace)
            .canonicalize()
            .map_err(|e| anyhow!("invalid workspace {}: {}", workspace, e))?;
        info!(
            "spawning `{} agent stdio` (workspace={}, effort={:?})",
            grok_bin.display(),
            workspace,
            options.reasoning_effort
        );

        let mut cmd = Command::new(&grok_bin);
        if let Some(api_key) = crate::api_key_for_runtime().map_err(|error| anyhow!(error))? {
            cmd.env("XAI_API_KEY", api_key);
        }
        for arg in launch_policy_args(&options.execution_mode)? {
            cmd.arg(arg);
        }
        if let Some(effort) = options.reasoning_effort.as_deref() {
            if !matches!(effort, "low" | "medium" | "high") {
                return Err(anyhow!("unsupported reasoning effort: {}", effort));
            }
            cmd.args(["--reasoning-effort", effort]);
        }
        cmd.args(["agent", "stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            anyhow!(
                "failed to spawn `{} agent stdio` — is grok on PATH? ({})",
                grok_bin.display(),
                e
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no stdin handle on child"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no stdout handle on child"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("no stderr handle on child"))?;

        let stdin = Arc::new(Mutex::new(stdin));
        // The product default is "announce, then run": every action is
        // recorded in the UI, but routine permission choices don't stall a
        // headless coding turn waiting for another click.
        let auto_approve = Arc::new(AtomicBool::new(true));
        let mode = mode_code(&options.execution_mode)?;
        // The CLI sandbox and the ACP filesystem bridge must agree. Without
        // this initialization Build started the CLI with full access but still
        // rejected out-of-workspace ACP file requests in the Rust bridge.
        let full_access = Arc::new(AtomicBool::new(mode_grants_full_access(
            &options.execution_mode,
        )?));
        let execution_mode = Arc::new(AtomicU8::new(mode));
        let is_shutting_down = Arc::new(AtomicBool::new(false));
        let is_busy = Arc::new(AtomicBool::new(false));

        let (resp_tx, mut resp_rx) = mpsc::channel::<Value>(64);
        {
            let stdin_for_requests = stdin.clone();
            let sink_for_reader = sink.clone();
            let resp_tx_for_reader = resp_tx.clone();
            let workspace_for_reader = workspace_root.clone();
            let auto_approve_for_reader = auto_approve.clone();
            let full_access_for_reader = full_access.clone();
            let execution_mode_for_reader = execution_mode.clone();
            let shutdown_flag = is_shutting_down.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            let msg: Value = match serde_json::from_str(trimmed) {
                                Ok(v) => v,
                                Err(e) => {
                                    warn!("bad JSON line: {} — {}", e, trimmed);
                                    continue;
                                }
                            };
                            // Has `id` and no `method` → it's a response to a request.
                            if msg.get("id").is_some() && msg.get("method").is_none() {
                                if resp_tx_for_reader.send(msg).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                            handle_incoming(
                                msg,
                                &stdin_for_requests,
                                &sink_for_reader,
                                &workspace_for_reader,
                                &auto_approve_for_reader,
                                &full_access_for_reader,
                                &execution_mode_for_reader,
                            )
                            .await;
                        }
                        Err(e) => {
                            warn!("stdout read error: {}", e);
                            break;
                        }
                    }
                }
                info!("grok agent stdout closed");
                if !shutdown_flag.load(Ordering::Relaxed) {
                    sink_for_reader(GrokEvent::Error {
                        message: "Grok agent disconnected. Start a new task to reconnect.".into(),
                    });
                    sink_for_reader(GrokEvent::TurnEnd {
                        stop_reason: "error".into(),
                    });
                }
            });
        }

        // --- Stderr drainer: surface as `Status` events for the UI ---
        {
            let sink_for_stderr = sink.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let msg = line.trim_end().to_string();
                    if !msg.is_empty() {
                        sink_for_stderr(GrokEvent::Status { message: msg });
                    }
                }
            });
        }

        // --- Initialize handshake (synchronous: wait for response) ---
        send_request(
            stdin.as_ref(),
            1,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientInfo": {
                    "name": "grok-gui",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )
        .await?;
        let init_result = await_response(&mut resp_rx, 1).await?;
        info!("agent initialized: {}", summarize(&init_result));
        let context_window = context_window_for_model(&init_result, _model);
        let available_models = available_models_from_init(&init_result);

        // --- Create or restore a durable Grok session (synchronous: need its id) ---
        let (session_method, session_params) = match options.resume_session_id.as_deref() {
            Some(session_id) => (
                "session/load",
                json!({ "sessionId": session_id, "cwd": workspace, "mcpServers": options.mcp_servers }),
            ),
            None => (
                "session/new",
                json!({ "cwd": workspace, "mcpServers": options.mcp_servers }),
            ),
        };
        send_request(stdin.as_ref(), 2, session_method, session_params).await?;
        let session_result = await_response(&mut resp_rx, 2).await?;
        let session_id = extract_session_id(&session_result, options.resume_session_id.as_deref())
            .map_err(|e| anyhow!("{}: {}", session_method, e))?;
        info!("session ready: {}", session_id);

        // The CLI starts with the account default. Apply the requested model
        // explicitly so the first turn uses the model shown by the UI.
        send_request(
            stdin.as_ref(),
            3,
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": _model }),
        )
        .await?;
        await_response(&mut resp_rx, 3).await?;

        Ok(Self {
            stdin,
            next_id: Arc::new(Mutex::new(10)),
            responses: Arc::new(Mutex::new(resp_rx)),
            request_lock: Arc::new(Mutex::new(())),
            auto_approve,
            session_id,
            context_window,
            available_models,
            model_id: Arc::new(Mutex::new(_model.to_string())),
            is_shutting_down,
            is_busy,
            _child: Arc::new(Mutex::new(child)),
        })
    }

    /// Send a user prompt. The ACP result marks the end of the request while
    /// content itself is delivered independently via `session/update`.
    pub async fn send_user_message(&self, text: &str) -> Result<()> {
        let _request_guard = self.request_lock.lock().await;
        let _busy_guard = BusyGuard(self.is_busy.clone());
        let id = {
            let mut g = self.next_id.lock().await;
            let id = *g;
            *g += 1;
            id
        };
        send_request(
            self.stdin.as_ref(),
            id,
            "session/prompt",
            json!({
                "sessionId": self.session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
        )
        .await?;
        let mut responses = self.responses.lock().await;
        // A `session/prompt` result only arrives after the whole turn drains -
        // long builds routinely exceed the 15s default used by handshakes.
        await_response_with_timeout(&mut responses, id, Duration::from_secs(600))
            .await
            .map(|_| ())
    }
    /// Switch model mid-session. P2 will wire this to the model picker.
    pub async fn set_model(&self, model: &str) -> Result<()> {
        let _request_guard = self.request_lock.lock().await;
        let id = {
            let mut g = self.next_id.lock().await;
            let id = *g;
            *g += 1;
            id
        };
        send_request(
            self.stdin.as_ref(),
            id,
            "session/set_model",
            json!({
                "sessionId": self.session_id,
                "modelId": model,
            }),
        )
        .await?;
        let mut responses = self.responses.lock().await;
        await_response(&mut responses, id).await?;
        *self.model_id.lock().await = model.to_string();
        Ok(())
    }

    /// Non-blocking liveness probe: returns false if the child has exited.
    /// Cheaper than `health_check` (no JSON-RPC round-trip) and safe to call
    /// on the fast path of `start_session` without blocking on request_lock.
    pub fn is_alive(&self) -> bool {
        if let Ok(mut child) = self._child.try_lock() {
            return child.try_wait().ok().flatten().is_none();
        }
        // Could not acquire the lock (another command holds it); assume alive
        // rather than falsely forcing a re-spawn.
        true
    }

    /// Check both the child process and the active ACP session. Unlike a
    /// process-local "session exists" flag, this confirms that the agent still
    /// accepts a request on its JSON-RPC stream. While a turn is in flight
    /// (the request lock is held for the whole prompt/response round-trip),
    /// the locked stream is itself proof of life, so we skip the round-trip.
    pub async fn health_check(&self) -> Result<()> {
        {
            let mut child = self._child.lock().await;
            if let Some(status) = child.try_wait()? {
                return Err(anyhow!("grok agent exited: {}", status));
            }
        }
        let Ok(_request_guard) = self.request_lock.try_lock() else {
            return Ok(());
        };
        let id = {
            let mut g = self.next_id.lock().await;
            let id = *g;
            *g += 1;
            id
        };
        let model_id = self.model_id.lock().await.clone();
        // Setting the already-selected model is an idempotent ACP request and
        // verifies the exact session without changing user-visible state.
        send_request(
            self.stdin.as_ref(),
            id,
            "session/set_model",
            json!({ "sessionId": self.session_id, "modelId": model_id }),
        )
        .await?;
        let mut responses = self.responses.lock().await;
        await_response(&mut responses, id).await.map(|_| ())
    }

    /// ACP specifies cancellation as a notification, not a request/reply RPC.
    /// The agent subsequently emits its regular terminal turn update, so the
    /// frontend can retain partial text and completed tool calls.
    pub async fn cancel_turn(&self) -> Result<()> {
        write_frame(
            self.stdin.as_ref(),
            &json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": self.session_id },
            }),
        )
        .await
    }

    pub async fn respond_permission(&self, request_id: u64, option_id: &str) -> Result<()> {
        respond_permission_frame(self.stdin.as_ref(), request_id, option_id).await
    }

    pub fn set_auto_approve(&self, enabled: bool) {
        self.auto_approve.store(enabled, Ordering::Relaxed);
    }

    /// Mark this runtime as shutting down without actually killing the child
    /// process. Used when the runtime is being replaced so the reader task
    /// stops emitting user-facing "disconnected" errors during the gap
    /// between `take()` and `shutdown()`.
    pub fn mark_shutting_down(&self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);
    }

    pub fn is_busy(&self) -> bool {
        self.is_busy.load(Ordering::Relaxed)
    }

    pub async fn shutdown(self) -> Result<()> {
        self.is_shutting_down.store(true, Ordering::Relaxed);
        info!("shutting down grok agent");
        let mut child = self._child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
        Ok(())
    }
}

/// RAII guard that clears `is_busy` when dropped, so the flag is always
/// released even if `send_user_message` returns early via `?`.
struct BusyGuard(Arc<AtomicBool>);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Pull a specific response by id off the channel, with a timeout.
async fn await_response(rx: &mut mpsc::Receiver<Value>, id: u64) -> Result<Value> {
    await_response_with_timeout(rx, id, Duration::from_secs(15)).await
}

async fn await_response_with_timeout(
    rx: &mut mpsc::Receiver<Value>,
    id: u64,
    budget: Duration,
) -> Result<Value> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(anyhow!("timeout waiting for response id={}", id));
        }
        let remaining = deadline - now;
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(msg)) => {
                if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
                    if let Some(err) = msg.get("error") {
                        return Err(anyhow!("agent error: {}", err));
                    }
                    return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                }
            }
            Ok(None) => return Err(anyhow!("response channel closed")),
            Err(_) => return Err(anyhow!("timeout waiting for response id={}", id)),
        }
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

async fn write_frame(stdin: &Mutex<tokio::process::ChildStdin>, frame: &Value) -> Result<()> {
    let mut s = stdin.lock().await;
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    s.write_all(&bytes).await?;
    s.flush().await?;
    Ok(())
}

/// Reply to an ACP permission request. Keeping this separate from the public
/// runtime method also lets the event reader acknowledge requests without
/// waiting for the UI round-trip.
async fn respond_permission_frame(
    stdin: &Mutex<tokio::process::ChildStdin>,
    request_id: u64,
    option_id: &str,
) -> Result<()> {
    write_frame(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "optionId": option_id },
        }),
    )
    .await
}

async fn send_request(
    stdin: &Mutex<tokio::process::ChildStdin>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<()> {
    write_frame(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
    .await
}

// ---------------------------------------------------------------------------
// Incoming message router
// ---------------------------------------------------------------------------

async fn handle_incoming(
    msg: Value,
    stdin: &Arc<Mutex<tokio::process::ChildStdin>>,
    sink: &EventSink,
    workspace_root: &Path,
    auto_approve: &Arc<AtomicBool>,
    full_access: &Arc<AtomicBool>,
    execution_mode: &Arc<AtomicU8>,
) {
    // Response to a request we sent (no `method` field). Drop — we don't
    // currently track async responses.
    if msg.get("id").is_some() && msg.get("method").is_none() {
        return;
    }

    let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
        return;
    };
    let id = msg.get("id").and_then(|i| i.as_u64());
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    if let Some(req_id) = id {
        match method {
            "request_permission" | "session/request_permission" => {
                let permission = permission_event(req_id, &params);
                if execution_mode.load(Ordering::Relaxed) == MODE_BUILD
                    && (full_access.load(Ordering::Relaxed) || auto_approve.load(Ordering::Relaxed))
                {
                    let (title, detail, option_id) = match &permission {
                        GrokEvent::PermissionRequest {
                            title,
                            detail,
                            options,
                            ..
                        } => (
                            title.clone(),
                            detail.clone(),
                            preferred_permission_option(options),
                        ),
                        _ => unreachable!("permission_event must return PermissionRequest"),
                    };
                    sink(GrokEvent::ActionNotice {
                        title: format!("即将执行：{}", title),
                        detail,
                        outcome: "announced".into(),
                    });
                    if let Some(option_id) = option_id {
                        // Give the renderer a moment to paint the notice before
                        // the agent is allowed to continue. This is notification,
                        // not a confirmation gate.
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        sink(GrokEvent::ActionNotice {
                            title: "已自动允许".into(),
                            detail: format!("已选择权限选项：{}", option_id),
                            outcome: "approved".into(),
                        });
                        if let Err(error) =
                            respond_permission_frame(stdin.as_ref(), req_id, &option_id).await
                        {
                            sink(GrokEvent::Error {
                                message: format!("自动授权失败：{}", error),
                            });
                        }
                    } else {
                        sink(GrokEvent::Error {
                            message: "权限请求没有可用的允许选项。".into(),
                        });
                    }
                } else {
                    let (title, detail, deny_id) = match &permission {
                        GrokEvent::PermissionRequest {
                            title,
                            detail,
                            options,
                            ..
                        } => (
                            title.clone(),
                            detail.clone(),
                            preferred_deny_option(options),
                        ),
                        _ => unreachable!("permission_event must return PermissionRequest"),
                    };
                    sink(GrokEvent::ActionNotice {
                        title: format!("已拦截：{}", title),
                        detail: format!("当前模式不允许此操作。{}", detail),
                        outcome: "approved".into(),
                    });
                    if let Some(option_id) = deny_id {
                        let _ = respond_permission_frame(stdin.as_ref(), req_id, &option_id).await;
                    } else {
                        auto_respond(
                            stdin,
                            req_id,
                            json!({ "error": { "code": -32001, "message": "operation blocked by current execution mode" } }),
                        )
                        .await;
                    }
                }
            }
            "fs/read_text_file" | "session/fs/read_text_file" => {
                if execution_mode.load(Ordering::Relaxed) == MODE_ASK {
                    sink(GrokEvent::ActionNotice {
                        title: "已拦截读取文件".into(),
                        detail: "提问模式禁止读取工作区。".into(),
                        outcome: "approved".into(),
                    });
                    auto_respond(
                        stdin,
                        req_id,
                        json!({ "error": { "code": -32001, "message": "file reads are blocked in Ask mode" } }),
                    )
                    .await;
                    return;
                }
                sink(GrokEvent::ActionNotice {
                    title: "即将读取文件".into(),
                    detail: request_path(&params),
                    outcome: "announced".into(),
                });
                handle_read_text_file(
                    stdin,
                    req_id,
                    &params,
                    workspace_root,
                    full_access.load(Ordering::Relaxed),
                )
                .await;
                sink(GrokEvent::ActionNotice {
                    title: "已处理读取请求".into(),
                    detail: request_path(&params),
                    outcome: "completed".into(),
                });
            }
            "fs/write_text_file" | "session/fs/write_text_file" => {
                if execution_mode.load(Ordering::Relaxed) != MODE_BUILD {
                    sink(GrokEvent::ActionNotice {
                        title: "已拦截写入文件".into(),
                        detail: "规划和提问模式禁止写入文件。".into(),
                        outcome: "approved".into(),
                    });
                    auto_respond(
                        stdin,
                        req_id,
                        json!({ "error": { "code": -32001, "message": "file writes are blocked outside Build mode" } }),
                    )
                    .await;
                    return;
                }
                sink(GrokEvent::ActionNotice {
                    title: "即将写入文件".into(),
                    detail: request_path(&params),
                    outcome: "announced".into(),
                });
                handle_write_text_file(
                    stdin,
                    req_id,
                    &params,
                    workspace_root,
                    full_access.load(Ordering::Relaxed),
                )
                .await;
                sink(GrokEvent::ActionNotice {
                    title: "已处理写入请求".into(),
                    detail: request_path(&params),
                    outcome: "completed".into(),
                });
            }
            _ => {
                auto_respond(
                    stdin,
                    req_id,
                    json!({ "error": { "code": -32601, "message": format!("not implemented: {}", method) } }),
                )
                .await;
            }
        }
        return;
    }

    // Otherwise it's a notification — translate to GrokEvent.
    // Grok Build embeds cumulative usage data inside turn_completed
    // updates rather than as a standalone usage_update. Extract it
    // first so the UI reflects final token/cost before the stream ends.
    if let Some(usage_event) = extract_embedded_usage(method, &params) {
        sink(usage_event);
    }
    if let Some(total) = params.pointer("/_meta/totalTokens").and_then(Value::as_u64) {
        sink(GrokEvent::ContextUsage {
            total_tokens: total,
        });
    }
    sink(translate_notification(method, params));
}

fn preferred_permission_option(options: &[PermissionOption]) -> Option<String> {
    options
        .iter()
        .find(|option| {
            !matches!(
                option.id.to_ascii_lowercase().as_str(),
                "deny" | "reject" | "cancel"
            )
        })
        .map(|option| option.id.clone())
        .or_else(|| options.first().map(|option| option.id.clone()))
}

fn preferred_deny_option(options: &[PermissionOption]) -> Option<String> {
    options
        .iter()
        .find(|option| {
            let label = option.label.to_ascii_lowercase();
            let id = option.id.to_ascii_lowercase();
            option.kind.eq_ignore_ascii_case("deny")
                || label.contains("deny")
                || label.contains("reject")
                || label.contains("cancel")
                || id.contains("deny")
                || id.contains("reject")
                || id.contains("cancel")
        })
        .map(|option| option.id.clone())
}

fn request_path(params: &Value) -> String {
    params
        .get("path")
        .or_else(|| params.get("uri"))
        .and_then(|value| value.as_str())
        .unwrap_or("当前工作区")
        .to_string()
}

fn permission_event(request_id: u64, params: &Value) -> GrokEvent {
    let options = params
        .get("options")
        .or_else(|| params.get("permissionOptions"))
        .and_then(|v| v.as_array())
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    let id = option
                        .get("optionId")
                        .or_else(|| option.get("id"))?
                        .as_str()?;
                    Some(PermissionOption {
                        id: id.to_string(),
                        label: option
                            .get("name")
                            .or_else(|| option.get("label"))
                            .and_then(|v| v.as_str())
                            .unwrap_or(id)
                            .to_string(),
                        kind: option
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("permission")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    GrokEvent::PermissionRequest {
        request_id,
        title: params
            .get("title")
            .or_else(|| params.get("reason"))
            .and_then(|v| v.as_str())
            .unwrap_or("Grok requests permission")
            .to_string(),
        detail: params
            .get("description")
            .or_else(|| params.get("details"))
            .and_then(|v| v.as_str())
            .unwrap_or("Review the requested action before continuing.")
            .to_string(),
        options,
    }
}

fn extract_embedded_usage(method: &str, params: &Value) -> Option<GrokEvent> {
    let is_session_update = matches!(
        method,
        "session/update"
            | "session_update"
            | "session-update"
            | "_x.ai/session/update"
            | "_x.ai/session_notification"
    );
    if !is_session_update {
        return None;
    }
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate").and_then(|v| v.as_str())?;
    if !matches!(kind, "turn_completed" | "turn_end") {
        return None;
    }
    let usage = update.get("usage")?;
    Some(GrokEvent::UsageUpdate {
        input_tokens: usage
            .get("inputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        output_tokens: usage
            .get("outputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cost_usd: usage.get("costUsd").and_then(|v| v.as_f64()).unwrap_or(0.0),
    })
}

fn extract_session_id(result: &Value, resume_session_id: Option<&str>) -> Result<String> {
    result
        .get("sessionId")
        .or_else(|| result.pointer("/_meta/sessionId"))
        .or_else(|| result.pointer("/_meta/sessionDetail/sessionId"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| resume_session_id.map(String::from))
        .ok_or_else(|| anyhow!("missing sessionId in response"))
}

fn translate_notification(method: &str, params: Value) -> GrokEvent {
    match method {
        // ACP uses `session/update`; xAI's current CLI also sends its
        // completion notification on this private compatibility method.
        "session/update"
        | "session_update"
        | "session-update"
        | "_x.ai/session/update"
        | "_x.ai/session_notification" => translate_session_update(&params),
        "models_update" | "models/update" => GrokEvent::ModelChanged {
            model: params
                .get("currentModelId")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string(),
        },
        "announcements_update" | "announcements/update" => {
            let msg = params
                .pointer("/announcements/0/title")
                .or_else(|| params.pointer("/announcements/0/message"))
                .and_then(|v| v.as_str())
                .unwrap_or("agent update")
                .to_string();
            GrokEvent::Status { message: msg }
        }
        "mcp_initialized" | "mcp/initialized" => GrokEvent::Status {
            message: format!(
                "{} MCP tools ready",
                params
                    .get("mcpToolCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
            ),
        },
        "turn_end" | "turn/end" => GrokEvent::TurnEnd {
            stop_reason: params
                .get("stopReason")
                .and_then(|v| v.as_str())
                .unwrap_or("end_turn")
                .to_string(),
        },
        _ => GrokEvent::Status {
            message: format!("[{}]", method),
        },
    }
}

fn translate_session_update(params: &Value) -> GrokEvent {
    let Some(update) = params.get("update") else {
        return GrokEvent::Status {
            message: "[update]".into(),
        };
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" => GrokEvent::TextDelta {
            delta: str_at(update, "/content/text").unwrap_or_default(),
        },
        "agent_thought_chunk" | "reasoning" => GrokEvent::Reasoning {
            delta: str_at(update, "/content/text").unwrap_or_default(),
        },
        "tool_call" | "tool_call_update" => {
            let id = str_any(update, &["toolCallId", "id"]).unwrap_or_default();
            let name = str_any(update, &["title", "name"]).unwrap_or_else(|| "tool".into());
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("running")
                .to_string();
            let output = content_text(update);
            let args = update
                .get("rawInput")
                .or_else(|| update.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            if kind == "tool_call"
                && matches!(status.as_str(), "pending" | "in_progress" | "running")
            {
                GrokEvent::ToolCallStart { id, name, args }
            } else {
                GrokEvent::ToolCallUpdate { id, status, output }
            }
        }
        "plan" => GrokEvent::PlanUpdate {
            steps: update
                .get("entries")
                .and_then(|e| e.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| {
                            x.get("content")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "usage" => GrokEvent::UsageUpdate {
            input_tokens: update
                .pointer("/inputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output_tokens: update
                .pointer("/outputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cost_usd: update
                .pointer("/costUsd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
        },
        "model_changed" => GrokEvent::ModelChanged {
            model: str_any(update, &["model_id", "modelId"]).unwrap_or_else(|| "?".into()),
        },
        "turn_completed" | "turn_end" => GrokEvent::TurnEnd {
            stop_reason: str_any(update, &["stopReason", "stop_reason"])
                .unwrap_or_else(|| "end_turn".into()),
        },
        "available_commands_update" | "available_commands" => GrokEvent::Status {
            message: format!(
                "{} slash commands available",
                update
                    .get("availableCommands")
                    .and_then(|c| c.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0)
            ),
        },
        _ => GrokEvent::Status {
            message: format!("[{}]", kind),
        },
    }
}

fn str_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer)
        .and_then(|x| x.as_str())
        .map(String::from)
}

/// Current Grok ACP tool results are represented as content blocks rather
/// than a single `content.output` string.
fn content_text(update: &Value) -> Option<String> {
    if let Some(output) = update.pointer("/content/output").and_then(|v| v.as_str()) {
        return Some(output.to_string());
    }

    update
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|blocks| {
            let text = blocks
                .iter()
                .filter_map(|block| {
                    block
                        .pointer("/content/text")
                        .or_else(|| block.get("text"))
                        .and_then(|value| value.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        })
}

fn str_any(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

async fn auto_respond(stdin: &Arc<Mutex<tokio::process::ChildStdin>>, id: u64, result: Value) {
    let frame = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });
    if let Err(e) = write_frame(stdin.as_ref(), &frame).await {
        warn!("failed to send auto-response for id={}: {}", id, e);
    }
}

async fn handle_read_text_file(
    stdin: &Arc<Mutex<tokio::process::ChildStdin>>,
    id: u64,
    params: &Value,
    workspace_root: &Path,
    full_access: bool,
) {
    let path = params
        .get("path")
        .or_else(|| params.get("uri"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match resolve_agent_path(workspace_root, path, full_access) {
        Ok(allowed_path) => match tokio::fs::metadata(&allowed_path).await {
            Ok(metadata) if metadata.len() > 512 * 1024 => auto_respond(
                stdin,
                id,
                json!({ "error": { "code": -32002, "message": "requested file exceeds 512 KiB limit" } }),
            )
            .await,
            Ok(_) => match tokio::fs::read_to_string(allowed_path).await {
            Ok(content) => auto_respond(stdin, id, json!({ "content": content })).await,
            Err(e) => auto_respond(
                stdin,
                id,
                json!({ "error": { "code": -32002, "message": e.to_string() } }),
            )
            .await,
            },
            Err(e) => auto_respond(
                stdin,
                id,
                json!({ "error": { "code": -32002, "message": e.to_string() } }),
            )
            .await,
        },
        Err(e) => {
            auto_respond(
                stdin,
                id,
                json!({ "error": { "code": -32002, "message": e.to_string() } }),
            )
            .await;
        }
    }
}

async fn handle_write_text_file(
    stdin: &Arc<Mutex<tokio::process::ChildStdin>>,
    id: u64,
    params: &Value,
    workspace_root: &Path,
    full_access: bool,
) {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let res: Result<()> = async {
        let allowed_path = resolve_agent_path(workspace_root, path, full_access)?;
        if let Some(parent) = allowed_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(allowed_path, content).await?;
        Ok(())
    }
    .await;
    match res {
        Ok(()) => auto_respond(stdin, id, json!({})).await,
        Err(e) => {
            auto_respond(
                stdin,
                id,
                json!({ "error": { "code": -32003, "message": e.to_string() } }),
            )
            .await
        }
    }
}

fn resolve_agent_path(
    workspace_root: &Path,
    requested: &str,
    full_access: bool,
) -> Result<PathBuf> {
    if full_access {
        let path = PathBuf::from(requested);
        return Ok(if path.is_absolute() {
            path
        } else {
            workspace_root.join(path)
        });
    }
    crate::workspace::resolve_workspace_path(workspace_root, requested)
}

fn summarize(v: &Value) -> String {
    let ver = v
        .pointer("/_meta/agentVersion")
        .and_then(|x| x.as_str())
        .unwrap_or("?");
    let model = v
        .pointer("/_meta/modelState/currentModelId")
        .and_then(|x| x.as_str())
        .unwrap_or("?");
    format!("agentVersion={} model={}", ver, model)
}

fn context_window_for_model(init_result: &Value, model_id: &str) -> Option<u64> {
    init_result
        .pointer("/_meta/modelState/availableModels")
        .and_then(Value::as_array)
        .and_then(|models| {
            models
                .iter()
                .find(|model| model.get("modelId").and_then(Value::as_str) == Some(model_id))
        })
        .and_then(|model| model.pointer("/_meta/totalContextTokens"))
        .and_then(Value::as_u64)
}

fn available_models_from_init(init_result: &Value) -> Vec<ModelDescriptor> {
    init_result
        .pointer("/_meta/modelState/availableModels")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("modelId").and_then(Value::as_str)?.to_string();
                    let label = model
                        .get("name")
                        .and_then(Value::as_str)
                        .map(String::from)
                        .unwrap_or_else(|| id.clone());
                    Some(ModelDescriptor {
                        id,
                        label,
                        context_window: model
                            .pointer("/_meta/totalContextTokens")
                            .and_then(Value::as_u64),
                        reasoning: model
                            .get("reasoning")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn mode_code(mode: &str) -> Result<u8> {
    match mode {
        "ask" => Ok(MODE_ASK),
        "plan" => Ok(MODE_PLAN),
        "build" => Ok(MODE_BUILD),
        _ => Err(anyhow!("unknown execution mode: {}", mode)),
    }
}

fn mode_grants_full_access(mode: &str) -> Result<bool> {
    Ok(mode_code(mode)? == MODE_BUILD)
}

/// These are Grok Build's documented process-start policy controls. Sandbox
/// policy is irreversible for a running process, so mode changes reconnect a
/// session instead of pretending an in-memory flag can retrofit isolation.
fn launch_policy_args(mode: &str) -> Result<Vec<&'static str>> {
    match mode {
        "ask" => Ok(vec![
            "--permission-mode",
            "dontAsk",
            "--sandbox",
            "strict",
            "--disable-web-search",
        ]),
        "plan" => Ok(vec![
            "--permission-mode",
            "dontAsk",
            "--sandbox",
            "read-only",
            "--disable-web-search",
        ]),
        "build" => Ok(vec![
            "--permission-mode",
            "bypassPermissions",
            "--sandbox",
            "off",
        ]),
        _ => Err(anyhow!("unknown execution mode: {}", mode)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_model_changed_notification() {
        let event = translate_notification(
            "_x.ai/session_notification",
            json!({
                "update": {
                    "sessionUpdate": "model_changed",
                    "model_id": "grok-4.5"
                }
            }),
        );

        assert!(matches!(event, GrokEvent::ModelChanged { model } if model == "grok-4.5"));
    }

    #[test]
    fn translates_xai_turn_completed_notification() {
        let event = translate_notification(
            "_x.ai/session/update",
            json!({
                "update": {
                    "sessionUpdate": "turn_completed",
                    "stopReason": "end_turn"
                }
            }),
        );

        assert!(matches!(event, GrokEvent::TurnEnd { stop_reason } if stop_reason == "end_turn"));
    }

    #[test]
    fn extracts_nested_tool_output() {
        let event = translate_notification(
            "_x.ai/session/update",
            json!({
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-1",
                    "title": "run_terminal_command",
                    "status": "completed",
                    "content": [{
                        "type": "content",
                        "content": { "type": "text", "text": "TRACE_TOOL_OK" }
                    }]
                }
            }),
        );

        assert!(matches!(
            event,
            GrokEvent::ToolCallUpdate { id, status, output: Some(output) }
                if id == "tool-1" && status == "completed" && output == "TRACE_TOOL_OK"
        ));
    }

    #[test]
    fn keeps_a_running_tool_update_as_an_update_not_a_second_start() {
        let event = translate_notification(
            "session/update",
            json!({
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-1",
                    "title": "Read",
                    "status": "running",
                    "content": { "output": "still reading" }
                }
            }),
        );

        assert!(matches!(
            event,
            GrokEvent::ToolCallUpdate { id, status, output }
            if id == "tool-1" && status == "running" && output.as_deref() == Some("still reading")
        ));
    }

    #[test]
    fn build_mode_resolves_paths_outside_workspace() {
        let root = PathBuf::from("/tmp/grok-workspace");
        assert_eq!(
            resolve_agent_path(&root, "/etc/hosts", true).unwrap(),
            PathBuf::from("/etc/hosts")
        );
        assert!(resolve_agent_path(&root, "/etc/hosts", false).is_err());
    }

    #[test]
    fn reads_context_window_for_selected_acp_model() {
        let init = json!({
            "_meta": { "modelState": { "availableModels": [
                { "modelId": "grok-4.5", "_meta": { "totalContextTokens": 500000 } }
            ]}}
        });
        assert_eq!(context_window_for_model(&init, "grok-4.5"), Some(500_000));
        assert_eq!(context_window_for_model(&init, "other"), None);
    }

    #[test]
    fn maps_modes_to_real_grok_launch_policies() {
        assert_eq!(
            launch_policy_args("ask").unwrap(),
            vec![
                "--permission-mode",
                "dontAsk",
                "--sandbox",
                "strict",
                "--disable-web-search"
            ],
        );
        assert_eq!(
            launch_policy_args("plan").unwrap(),
            vec![
                "--permission-mode",
                "dontAsk",
                "--sandbox",
                "read-only",
                "--disable-web-search"
            ],
        );
        assert_eq!(
            launch_policy_args("build").unwrap(),
            vec!["--permission-mode", "bypassPermissions", "--sandbox", "off"],
        );
        assert!(launch_policy_args("unknown").is_err());
    }

    #[test]
    fn build_mode_enables_the_matching_filesystem_policy() {
        assert!(mode_grants_full_access("build").unwrap());
        assert!(!mode_grants_full_access("ask").unwrap());
        assert!(!mode_grants_full_access("plan").unwrap());
    }

    #[test]
    fn extracts_cumulative_usage_from_turn_completed() {
        let event = extract_embedded_usage(
            "_x.ai/session_notification",
            &json!({
                "update": {
                    "sessionUpdate": "turn_completed",
                    "stop_reason": "end_turn",
                    "usage": {
                        "inputTokens": 24856,
                        "outputTokens": 30,
                        "totalTokens": 24886,
                        "numTurns": 1
                    }
                }
            }),
        );

        assert!(matches!(
            event,
            Some(GrokEvent::UsageUpdate {
                input_tokens: 24856,
                output_tokens: 30,
                cost_usd: 0.0
            })
        ));
    }

    #[test]
    fn extracts_usage_with_cost_from_turn_completed() {
        let event = extract_embedded_usage(
            "session/update",
            &json!({
                "update": {
                    "sessionUpdate": "turn_end",
                    "usage": {
                        "inputTokens": 100,
                        "outputTokens": 200,
                        "costUsd": 0.05
                    }
                }
            }),
        );

        assert!(matches!(
            event,
            Some(GrokEvent::UsageUpdate { input_tokens: 100, output_tokens: 200, cost_usd })
                if (cost_usd - 0.05).abs() < 1e-9
        ));
    }

    #[test]
    fn returns_none_for_non_turn_notifications() {
        assert!(extract_embedded_usage(
            "session/update",
            &json!({ "update": { "sessionUpdate": "agent_message_chunk" } }),
        )
        .is_none());

        assert!(
            extract_embedded_usage(
                "session/update",
                &json!({ "update": { "sessionUpdate": "turn_completed" } }),
            )
            .is_none(),
            "turn_completed without usage field should return None"
        );

        assert!(extract_embedded_usage(
            "some/other/method",
            &json!({ "update": { "sessionUpdate": "turn_completed", "usage": {} } }),
        )
        .is_none());
    }

    #[test]
    fn extracts_session_id_from_session_new_result() {
        let result = json!({ "sessionId": "sess-new-123" });
        assert_eq!(extract_session_id(&result, None).unwrap(), "sess-new-123");
    }

    #[test]
    fn extracts_session_id_from_session_load_meta() {
        let result = json!({
            "models": { "currentModelId": "grok-4.5" },
            "_meta": { "sessionId": "sess-loaded-456" }
        });
        assert_eq!(
            extract_session_id(&result, Some("original-id")).unwrap(),
            "sess-loaded-456"
        );
    }

    #[test]
    fn falls_back_to_resume_id_when_result_has_no_session_id() {
        let result = json!({ "models": {} });
        assert_eq!(
            extract_session_id(&result, Some("resume-fallback-789")).unwrap(),
            "resume-fallback-789"
        );
    }

    #[test]
    fn errors_when_no_session_id_anywhere() {
        let result = json!({ "models": {} });
        assert!(extract_session_id(&result, None).is_err());
    }
}
