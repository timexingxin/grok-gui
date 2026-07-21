// Tauri 2 entry point for Grok GUI Lite.
// Architecture:
//   Frontend (React) <-> Tauri commands/events <-> grok_runtime (ACP / stdio)
//
// P0: shell boots, plugins loaded, frontend served. The `grok_runtime`
// module is a stub — P1 will implement the JSON-RPC client for spawning
// the `grok` CLI and streaming its agent events to the frontend.

use once_cell::sync::OnceCell;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::{info, warn};

mod grok_runtime;
mod provider_config;
mod workspace;

use grok_runtime::{GrokEvent, GrokRuntime, ModelDescriptor, SessionOptions};
use provider_config::ProviderConfig;

static APP_HANDLE: OnceCell<tauri::AppHandle> = OnceCell::new();
const OFFICIAL_INSTALLER_SCRIPT: &str = "curl -fsSL https://x.ai/cli/install.sh | bash";
const KEYCHAIN_SERVICE: &str = "com.grok-gui.lite";
const KEYCHAIN_ACCOUNT: &str = "xai-api-key";

/// Maximum number of concurrent ACP runtimes kept alive in the pool. Each
/// runtime is a full `grok agent stdio` subprocess; the cap bounds memory/fd
/// usage while letting several projects run in parallel.
const MAX_RUNTIMES: usize = 6;

/// Generates a unique token for `start_session`'s admission-control slot
/// reservation. The pool only uses the token as an opaque placeholder key;
/// its readable form is purely for debugging.
static SPAWN_HINT_COUNTER: AtomicU64 = AtomicU64::new(0);
fn next_spawn_hint() -> String {
    format!("spawn:{}", SPAWN_HINT_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Pick the session id with the oldest `last_used` timestamp. Extracted as a
/// pure function so the LRU direction can be unit-tested without constructing
/// a real `GrokRuntime` (which requires a live subprocess).
#[cfg(test)]
fn lru_oldest(timestamps: &HashMap<String, Instant>) -> Option<String> {
    timestamps
        .iter()
        .min_by_key(|(_, t)| *t)
        .map(|(id, _)| id.clone())
}

/// Live ACP runtimes keyed by session id. On overflow the least-recently-used
/// entry is returned from `insert` so the caller can shut it down outside the
/// lock, keeping multiple conversations alive across switches.
/// Live ACP runtimes keyed by session id. On overflow the least-recently-used
/// entry is returned from `insert` so the caller can shut it down outside the
/// lock, keeping multiple conversations alive across switches.
pub struct SessionPool {
    runtimes: HashMap<String, GrokRuntime>,
    last_used: HashMap<String, Instant>,
    /// Admission-control placeholder for sessions currently being spawned.
    /// `start_session` reserves a slot here before calling `GrokRuntime::spawn`
    /// and then either promotes it via `insert` (real session id known) or
    /// rolls it back via `release_reservation` (spawn failure). This prevents
    /// a burst of concurrent start_session calls from all spawning a child
    /// process only to find the pool full afterwards.
    in_flight: HashSet<String>,
}

impl Default for SessionPool {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionPool {
    fn new() -> Self {
        Self {
            runtimes: HashMap::new(),
            last_used: HashMap::new(),
            in_flight: HashSet::new(),
        }
    }

    /// Returns a cheap clone (every `GrokRuntime` field is `Arc<Mutex<…>>`,
    /// so the clone shares stdin/child) and marks the session most-recently-used.
    fn get(&mut self, session_id: &str) -> Option<GrokRuntime> {
        let runtime = self.runtimes.get(session_id).cloned();
        if runtime.is_some() {
            self.last_used.insert(session_id.to_string(), Instant::now());
        }
        runtime
    }

    #[allow(dead_code)]
    fn contains(&self, session_id: &str) -> bool {
        self.runtimes.contains_key(session_id)
    }

    /// Insert a runtime. If the pool is full and this is a new key, the
    /// least-recently-used **idle** runtime is evicted and returned for
    /// shutdown. Returns Err if the pool is full and every runtime is busy
    /// (a running turn must never be killed to make room). `hint` is the
    /// reservation token `try_admit` placed in `in_flight`; this call
    /// promotes it into a real slot by removing it.
    fn insert(
        &mut self,
        session_id: String,
        runtime: GrokRuntime,
        hint: &str,
    ) -> Result<Option<GrokRuntime>, String> {
        let is_new = !self.runtimes.contains_key(&session_id);
        let evicted = if is_new && self.runtimes.len() >= MAX_RUNTIMES {
            self.evict_oldest_idle()
        } else {
            None
        };
        if is_new && evicted.is_none() && self.runtimes.len() >= MAX_RUNTIMES {
            return Err(format!(
                "并发会话已达上限（{}），且全部正在执行任务，请等待其中一个完成后再试。",
                MAX_RUNTIMES
            ));
        }
        // Promote the reservation into a real slot.
        // Promote the reservation into a real slot.
        self.in_flight.remove(hint);
        self.runtimes.insert(session_id.clone(), runtime);
        self.last_used.insert(session_id, Instant::now());
        Ok(evicted)
    }

    /// Reserve a slot for a session not yet inserted into the pool. Returns
    /// true if the projected capacity (runtimes + in-flight placeholders)
    /// still fits under MAX_RUNTIMES; the hint is recorded so concurrent
    /// start_session calls don't all clear the gate.
    fn try_admit(&mut self, hint: &str, resume_sid: &str) -> bool {
        // Re-admitting an existing runtime is free; no new slot consumed.
        if self.runtimes.contains_key(resume_sid) {
            return true;
        }
        if self.runtimes.len() + self.in_flight.len() >= MAX_RUNTIMES {
            return false;
        }
        self.in_flight.insert(hint.to_string());
        true
    }

    /// Roll back a reservation whose `spawn` subsequently failed; if
    /// `insert` succeeds, the hint is removed there instead.
    fn release_reservation(&mut self, hint: &str) {
        self.in_flight.remove(hint);
    }

    fn remove(&mut self, session_id: &str) -> Option<GrokRuntime> {
        self.last_used.remove(session_id);
        self.runtimes.remove(session_id)
    }

    fn evict_oldest_idle(&mut self) -> Option<GrokRuntime> {
        let candidates: Vec<String> = self
            .runtimes
            .iter()
            .filter(|(_, r)| !r.is_busy())
            .map(|(id, _)| id.clone())
            .collect();
        let oldest_id = candidates
            .iter()
            .filter_map(|id| self.last_used.get(id).map(|t| (id.clone(), *t)))
            .min_by_key(|(_, t)| *t)
            .map(|(id, _)| id)?;
        self.last_used.remove(&oldest_id);
        self.runtimes.remove(&oldest_id)
    }

    fn active_ids(&self) -> Vec<String> {
        self.runtimes.keys().cloned().collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.runtimes.len()
    }
}

#[derive(Default)]
pub struct AppState {
    pub runtimes: Arc<Mutex<SessionPool>>,
    pub providers: Arc<Mutex<Vec<ProviderConfig>>>,
    pub active_session: Arc<Mutex<Option<String>>>,
    pub keep_awake: Arc<Mutex<Option<tokio::process::Child>>>,
}

impl AppState {
    /// Resolve the runtime for the given session id, or return an error
    /// describing which side (frontend/backend) lost track of the id.
    async fn require_runtime(&self, session_id: &str) -> Result<GrokRuntime, String> {
        let runtime = self.runtimes.lock().await.get(session_id);
        runtime.ok_or_else(|| {
            format!(
                "没有找到会话 {} 的活动 Agent 运行时。它可能已被回收或结束，请重新连接。",
                session_id
            )
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PingResponse {
    pub ok: bool,
    pub version: &'static str,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectionCheckResponse {
    pub connected: bool,
    pub session_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerInput {
    name: String,
    transport: String,
    command_or_url: String,
    #[serde(default)]
    args: Vec<String>,
    scope: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartSessionResponse {
    pub session_id: String,
    pub workspace: String,
    pub context_window: Option<u64>,
    pub available_models: Vec<ModelDescriptor>,
}

#[derive(Debug, Serialize)]
pub struct GrokCliStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthUpdate {
    message: String,
}

/// Build the complete list of CLI locations independently of a terminal shell.
/// Finder-launched macOS apps do not inherit the user's shell PATH, so every
/// runtime call must use this same resolver instead of `Command::new("grok")`.
fn grok_cli_candidates_for(
    custom: Option<&str>,
    home: Option<&Path>,
    path: Option<&std::ffi::OsStr>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(custom) = custom.filter(|value| !value.trim().is_empty()) {
        candidates.push(PathBuf::from(custom));
    }
    if let Some(home) = home {
        candidates.push(home.join(".grok/bin/grok"));
    }
    if let Some(path) = path {
        candidates.extend(std::env::split_paths(path).map(|directory| directory.join("grok")));
    }
    candidates
}

fn resolve_grok_bin_for(
    custom: Option<&str>,
    home: Option<&Path>,
    path: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    grok_cli_candidates_for(custom, home, path)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "找不到 Grok Build CLI。请安装 Grok Build，或设置 GROK_BIN。".to_string())
}

pub(crate) fn resolve_grok_bin() -> Result<PathBuf, String> {
    let custom = std::env::var("GROK_BIN").ok();
    let home = home_dir();
    let path = std::env::var_os("PATH");
    resolve_grok_bin_for(custom.as_deref(), home.as_deref(), path.as_deref())
}

fn official_installer_script() -> &'static str {
    OFFICIAL_INSTALLER_SCRIPT
}

fn validate_api_key(key: &str) -> Result<String, String> {
    let normalized = key.trim();
    if normalized.is_empty() || normalized.contains(['\n', '\r']) {
        return Err("请输入有效的单行 xAI API Key。".to_string());
    }
    Ok(normalized.to_string())
}

/// The key never crosses this Rust boundary except as a child-process env var.
pub(crate) fn api_key_for_runtime() -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("无法访问凭据存储：{}", e))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("无法读取凭据存储中的 API Key：{}", e)),
    }
}

/// Cross-platform home directory: `HOME` on Unix, `USERPROFILE` on Windows.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[tauri::command]
async fn install_official_grok_cli() -> Result<(), String> {
    let script = official_installer_script();
    let output = if cfg!(target_os = "windows") {
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("irm {script} | iex")])
            .stdin(Stdio::null())
            .output()
            .await
    } else {
        Command::new("/bin/zsh")
            .args(["-lc", script])
            .stdin(Stdio::null())
            .output()
            .await
    }
    .map_err(|_| "无法启动官方 Grok Build 安装器。".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("官方 Grok Build 安装未完成，请检查网络后重试。".to_string())
    }
}

async fn login_grok(args: &[&str]) -> Result<(), String> {
    let output = Command::new(resolve_grok_bin()?)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "无法启动 Grok Build 官方登录。".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("官方登录未完成，请在浏览器完成授权后重试。".to_string())
    }
}

#[tauri::command]
async fn login_grok_oauth() -> Result<(), String> {
    login_grok(&["login", "--oauth"]).await
}

#[tauri::command]
async fn login_grok_device_code(app: tauri::AppHandle) -> Result<(), String> {
    // Device authentication is interactive: the CLI prints a URL and code
    // before it exits. `Command::output()` would wait for completion and
    // discard those instructions, leaving the GUI user unable to continue.
    let mut child = Command::new(resolve_grok_bin()?)
        .args(["login", "--device-auth"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动 Grok Build 设备码登录。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 Grok Build 设备码登录输出。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 Grok Build 设备码登录输出。".to_string())?;

    let forward = |reader: tokio::process::ChildStdout, handle: tauri::AppHandle| async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = handle.emit("grok:device-auth", DeviceAuthUpdate { message: line });
        }
    };
    let stdout_task = tokio::spawn(forward(stdout, app.clone()));
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("grok:device-auth", DeviceAuthUpdate { message: line });
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|_| "无法等待 Grok Build 设备码登录完成。".to_string())?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if status.success() {
        Ok(())
    } else {
        Err("官方设备码登录未完成，请完成浏览器授权后重试。".to_string())
    }
}

#[tauri::command]
async fn save_xai_api_key(key: String) -> Result<(), String> {
    let normalized = validate_api_key(&key)?;
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("无法访问凭据存储：{}", e))?;
    entry.set_password(&normalized)
        .map_err(|e| format!("无法保存 API Key 到凭据存储：{}", e))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMode {
    /// "oauth" when ~/.grok/auth.json exists (account login); "apiKey" when a
    /// key is saved in the macOS keychain; "none" when nothing is configured.
    pub kind: String,
    pub logged_in: bool,
    pub has_api_key: bool,
}

/// Report which authentication path Grok Build will use next:
/// 1. account login via `~/.grok/auth.json` (preferred, costs nothing extra)
/// 2. macOS keychain `XAI_API_KEY` (paid metered access)
/// 3. CLI auto-detects whichever is present; if both, keychain wins.
#[tauri::command]
async fn get_auth_mode() -> Result<AuthMode, String> {
    let home = home_dir();
    let auth_json = home
        .as_ref()
        .map(|h| h.join(".grok").join("auth.json"))
        .filter(|p| p.is_file());
    let has_api_key = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let kind = if has_api_key {
        // XAI_API_KEY in env beats auth.json (this is the CLI's documented
        // priority); only fall back to oauth if neither a key nor auth.json
        // exists yet.
        "apiKey"
    } else if auth_json.is_some() {
        "oauth"
    } else {
        "none"
    };
    Ok(AuthMode {
        kind: kind.to_string(),
        logged_in: auth_json.is_some(),
        has_api_key,
    })
}

/// Locate the grok CLI the runtime will spawn: explicit GROK_BIN override,
/// the installer default ~/.grok/bin/grok, then PATH. Verification runs
/// `grok --version` so a broken shim is reported as not installed.
#[tauri::command]
async fn detect_grok_cli() -> Result<GrokCliStatus, String> {
    let custom = std::env::var("GROK_BIN").ok();
    let home = home_dir();
    let path = std::env::var_os("PATH");
    for candidate in grok_cli_candidates_for(custom.as_deref(), home.as_deref(), path.as_deref()) {
        if !candidate.is_file() {
            continue;
        }
        match Command::new(&candidate).arg("--version").output().await {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Ok(GrokCliStatus {
                    installed: true,
                    path: Some(candidate.to_string_lossy().to_string()),
                    version: Some(version),
                });
            }
            _ => continue,
        }
    }
    Ok(GrokCliStatus {
        installed: false,
        path: None,
        version: None,
    })
}

#[tauri::command]
async fn ping(state: tauri::State<'_, AppState>) -> Result<PingResponse, String> {
    info!("ping called");
    let session = state.active_session.lock().await.clone();
    Ok(PingResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        session_id: session,
    })
}

#[tauri::command]
async fn start_session(
    state: tauri::State<'_, AppState>,
    workspace_path: String,
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
    execution_mode: String,
    resume_session_id: Option<String>,
) -> Result<StartSessionResponse, String> {
    let expanded = expand_tilde(&workspace_path);
    info!(
        "start_session workspace={} (expanded={}) provider={} model={}",
        workspace_path, expanded, provider, model
    );

    // Fast path: a live runtime for this session id already exists, so we
    // return immediately without spawning. is_alive() is non-blocking — a
    // zombie entry (child exited but slot still present) drops out so the
    // spawn path below can take over.
    if let Some(sid) = resume_session_id.as_deref() {
        let live_runtime = state
            .runtimes
            .lock()
            .await
            .get(sid)
            .filter(|r| r.is_alive());
        match live_runtime {
            Some(runtime) => {
                info!("start_session reused live runtime for {}", sid);
                let context_window = runtime.context_window;
                let available_models = runtime.available_models.clone();
                *state.active_session.lock().await = Some(sid.to_string());
                return Ok(StartSessionResponse {
                    session_id: sid.to_string(),
                    workspace: expanded,
                    context_window,
                    available_models,
                });
            }
            None if state.runtimes.lock().await.contains(sid) => {
                // Pool entry survived the liveness check; the child must
                // have exited. Remove it so the new spawn doesn't collide.
                info!("start_session evicting dead runtime for {}", sid);
                state.runtimes.lock().await.remove(sid);
            }
            None => {}
        }
    }

    // Admission control. The hint token is reserved BEFORE we touch the
    // expensive ACP handshake so a surge of concurrent calls cannot all
    // burn a child process only to find the pool full on insert.
    let hint = next_spawn_hint();
    {
        let mut pool = state.runtimes.lock().await;
        if !pool.try_admit(&hint, resume_session_id.as_deref().unwrap_or("")) {
            return Err(format!(
                "并发会话已达上限（{}），全部正在执行任务，请等待其中一个完成后再试。",
                MAX_RUNTIMES
            ));
        }
    }

    // Spawn outside the lock. A spawn failure rolls the reservation back so
    // the slot is freed for the next call immediately.
    let session_id_cell: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));
    let sid_for_cb = session_id_cell.clone();
    let runtime = match GrokRuntime::spawn(
        &expanded,
        &provider,
        &model,
        SessionOptions {
            reasoning_effort,
            execution_mode,
            mcp_servers: configured_mcp_servers(&expanded).await,
            resume_session_id: resume_session_id.clone(),
        },
        Box::new(move |evt: GrokEvent| {
            if let Some(app) = APP_HANDLE.get() {
                let session_id = sid_for_cb.lock().ok().and_then(|g| g.clone());
                let payload = serde_json::json!({
                    "session_id": session_id,
                    "event": evt,
                });
                let _ = app.emit("grok:event", payload);
            }
        }),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            state.runtimes.lock().await.release_reservation(&hint);
            return Err(e.to_string());
        }
    };

    let session_id = runtime.session_id.clone();
    let context_window = runtime.context_window;
    let available_models = runtime.available_models.clone();
    if let Ok(mut cell) = session_id_cell.lock() {
        *cell = Some(session_id.clone());
    }

    // Promote the admission placeholder into a real slot.
    let evicted = state
        .runtimes
        .lock()
        .await
        .insert(session_id.clone(), runtime, &hint)?;
    *state.active_session.lock().await = Some(session_id.clone());

    // Evicted (if any) is shut down WITHOUT mark_shutting_down: this is not
    // an expected epoch replacement, so its disconnect event must reach the
    // frontend so the user sees that session ended.
    if let Some(evicted) = evicted {
        info!("pool full; evicting oldest idle runtime to make room");
        let _ = evicted.shutdown().await;
    }

    Ok(StartSessionResponse {
        session_id,
        workspace: expanded,
        context_window,
        available_models,
    })
}

/// Expand a leading `~` or `~/` to the user's home directory. Anything
/// else is returned unchanged.
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
    } else if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        format!("{}/{}", home.trim_end_matches('/'), rest)
    } else {
        path.to_string()
    }
}

#[tauri::command]
async fn stop_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Shutdown outside the pool lock: killing the child can take time and
    // must not block other sessions' commands.
    let runtime = state.runtimes.lock().await.remove(&session_id);
    if let Some(runtime) = runtime {
        runtime.mark_shutting_down();
        runtime.shutdown().await.map_err(|e| e.to_string())?;
    }
    let mut active = state.active_session.lock().await;
    if active.as_deref() == Some(session_id.as_str()) {
        *active = None;
    }
    Ok(())
}

#[tauri::command]
async fn list_active_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    Ok(state.runtimes.lock().await.active_ids())
}

#[tauri::command]
async fn check_connection(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<ConnectionCheckResponse, String> {
    let runtime = state.runtimes.lock().await.get(&session_id);
    let Some(runtime) = runtime else {
        return Ok(ConnectionCheckResponse {
            connected: false,
            session_id: None,
            detail: Some("没有活动 Agent 会话。".into()),
        });
    };
    match runtime.health_check().await {
        Ok(()) => Ok(ConnectionCheckResponse {
            connected: true,
            session_id: Some(runtime.session_id.clone()),
            detail: None,
        }),
        Err(error) => Ok(ConnectionCheckResponse {
            connected: false,
            session_id: Some(runtime.session_id.clone()),
            detail: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
async fn cancel_turn(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let runtime = state.require_runtime(&session_id).await?;
    runtime.cancel_turn().await.map_err(|e| e.to_string())
}

/// Ask the agent to compress its conversation history (`/compact` slash
/// command). Runs as a normal turn, so the frontend's regular event flow
/// (usage_update, turn_end) applies without special-casing.
#[tauri::command]
async fn compact_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let runtime = state.require_runtime(&session_id).await?;
    runtime
        .send_user_message("/compact")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    // Prompts can contain credentials or private source snippets; telemetry
    // records only their length, never their contents.
    info!("send_message session={} chars={}", session_id, text.chars().count());
    // Never hold the pool mutex while a turn is in flight. A turn may ask
    // for permission; `respond_permission` must be able to acquire the same
    // pool immediately or the GUI and agent wait on one another forever.
    let runtime = state.require_runtime(&session_id).await?;
    runtime
        .send_user_message(&text)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_model(
    state: tauri::State<'_, AppState>,
    session_id: String,
    model: String,
) -> Result<(), String> {
    let runtime = state.require_runtime(&session_id).await?;
    runtime.set_model(&model).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn respond_permission(
    state: tauri::State<'_, AppState>,
    session_id: String,
    request_id: u64,
    option_id: String,
) -> Result<(), String> {
    let runtime = state.require_runtime(&session_id).await?;
    runtime
        .respond_permission(request_id, &option_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_auto_approve(
    state: tauri::State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    let runtime = state.require_runtime(&session_id).await?;
    runtime.set_auto_approve(enabled);
    Ok(())
}

#[tauri::command]
async fn list_providers(state: tauri::State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    Ok(state.providers.lock().await.clone())
}

#[tauri::command]
async fn inspect_grok_configuration(workspace_path: String) -> Result<Value, String> {
    run_grok_json(
        vec!["inspect".into(), "--json".into()],
        Some(expand_tilde(&workspace_path)),
    )
    .await
}

#[tauri::command]
async fn list_mcp_servers(workspace_path: String) -> Result<Value, String> {
    run_grok_json(
        vec!["mcp".into(), "list".into(), "--json".into()],
        Some(expand_tilde(&workspace_path)),
    )
    .await
}

#[tauri::command]
async fn diagnose_mcp_server(name: String, workspace_path: String) -> Result<Value, String> {
    run_grok_json(
        vec!["mcp".into(), "doctor".into(), name, "--json".into()],
        Some(expand_tilde(&workspace_path)),
    )
    .await
}

#[tauri::command]
async fn upsert_mcp_server(input: McpServerInput, workspace_path: String) -> Result<Value, String> {
    if input.name.trim().is_empty() || input.command_or_url.trim().is_empty() {
        return Err("MCP 名称和命令（或 URL）不能为空。".into());
    }
    if !matches!(input.transport.as_str(), "stdio" | "http" | "sse") {
        return Err("不支持的 MCP transport。".into());
    }
    if !matches!(input.scope.as_str(), "user" | "project") {
        return Err("MCP scope 必须为 user 或 project。".into());
    }
    let mut args = vec![
        "mcp".into(),
        "add".into(),
        "--transport".into(),
        input.transport.clone(),
        "--scope".into(),
        input.scope,
        input.name,
    ];
    if input.transport == "stdio" {
        args.push("--".into());
    }
    args.push(input.command_or_url);
    args.extend(input.args);
    run_grok_success(args, Some(expand_tilde(&workspace_path))).await
}

#[tauri::command]
async fn remove_mcp_server(
    name: String,
    scope: Option<String>,
    workspace_path: String,
) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("MCP 名称不能为空。".into());
    }
    let mut args = vec!["mcp".into(), "remove".into()];
    if let Some(scope) = scope {
        if !matches!(scope.as_str(), "user" | "project") {
            return Err("MCP scope 必须为 user 或 project。".into());
        }
        args.extend(["--scope".into(), scope]);
    }
    args.push(name);
    run_grok_success(args, Some(expand_tilde(&workspace_path))).await
}

/// ACP requires each MCP server to be supplied at session creation. Grok's
/// CLI configuration uses a compact shape, so translate it into ACP's actual
/// stdio/HTTP shapes rather than starting every session with `mcpServers: []`.
async fn configured_mcp_servers(workspace_path: &str) -> Vec<Value> {
    let configured = match run_grok_json(
        vec!["mcp".into(), "list".into(), "--json".into()],
        Some(workspace_path.to_string()),
    )
    .await
    {
        Ok(configured) => configured,
        Err(error) => {
            warn!(
                "MCP discovery failed; starting session without MCP servers: {}",
                error
            );
            return Vec::new();
        }
    };
    mcp_servers_from_list(&configured)
}

fn mcp_servers_from_list(configured: &Value) -> Vec<Value> {
    let servers = if let Some(servers) = configured.as_array() {
        servers.clone()
    } else if let Some(servers) = configured
        .get("servers")
        .or_else(|| configured.get("mcpServers"))
        .and_then(Value::as_array)
    {
        servers.clone()
    } else {
        warn!("MCP discovery returned a non-array value; starting session without MCP servers");
        return Vec::new();
    };
    let mut result = Vec::new();
    for server in &servers {
        if server.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(name) = server.get("name").and_then(Value::as_str) else {
            warn!("Skipping MCP configuration without a name");
            continue;
        };
        if let Some(command) = server.get("command").and_then(Value::as_str) {
            let args = server
                .get("args")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            // ACP specifies env as an array of { name, value } entries.
            // `grok mcp list` deliberately does not expose configured secrets,
            // so credentials remain in the CLI-owned config rather than being
            // copied into the GUI process or its persisted UI state.
            result.push(json!({
                "name": name,
                "command": command,
                "args": args,
                "env": [],
            }));
        } else if let Some(url) = server.get("url").and_then(Value::as_str) {
            result.push(json!({ "name": name, "url": url, "headers": [] }));
        } else {
            warn!("Skipping malformed MCP configuration: {}", name);
        }
    }
    result
}

async fn run_grok_json(args: Vec<String>, cwd: Option<String>) -> Result<Value, String> {
    let mut command = Command::new(resolve_grok_bin()?);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.output().await.map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Grok 返回了非 JSON 输出：{}", error))
}

async fn run_grok_success(args: Vec<String>, cwd: Option<String>) -> Result<Value, String> {
    let mut command = Command::new(resolve_grok_bin()?);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.output().await.map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(Value::Null)
}

#[tauri::command]
async fn set_keep_awake(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let mut guard = state.keep_awake.lock().await;
    if enabled {
        if guard.is_some() {
            return Ok(());
        }
        let child = Command::new("caffeinate")
            .args(["-dims"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法启动 caffeinate：{}", e))?;
        *guard = Some(child);
    } else if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
    Ok(())
}

#[tauri::command]
async fn workspace_overview(
    workspace_path: String,
) -> Result<workspace::WorkspaceOverview, String> {
    workspace::overview(&expand_tilde(&workspace_path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_file(
    workspace_path: String,
    relative_path: String,
) -> Result<workspace::WorkspaceText, String> {
    workspace::read_text(&expand_tilde(&workspace_path), &relative_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_diff(
    workspace_path: String,
    relative_path: String,
) -> Result<workspace::WorkspaceText, String> {
    workspace::diff(&expand_tilde(&workspace_path), &relative_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_list_dir(
    workspace_path: String,
    relative_dir: String,
) -> Result<Vec<workspace::WorkspaceDirEntry>, String> {
    workspace::list_dir(&expand_tilde(&workspace_path), &relative_dir).map_err(|e| e.to_string())
}

/// Content search walks (and reads) every candidate file synchronously, so it
/// runs on a blocking-pool thread rather than the async runtime — otherwise a
/// large repo scan would stall every other webview IPC call in flight.
#[tauri::command]
async fn workspace_search(
    workspace_path: String,
    query: String,
    max_results: usize,
) -> Result<Vec<workspace::WorkspaceSearchMatch>, String> {
    let workspace_path = expand_tilde(&workspace_path);
    tauri::async_runtime::spawn_blocking(move || {
        workspace::search_content(&workspace_path, &query, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_clipboard_image(
    workspace_path: Option<String>,
    filename: String,
    base64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    // ~14MB of base64 ≈ 10MB of image data; refuse unbounded clipboard dumps.
    if base64.len() > 14 * 1024 * 1024 {
        return Err("图片超过 10MB 大小限制。".into());
    }
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "clipboard.png".to_string());
    let ws = workspace_path.unwrap_or_else(|| "~".to_string());
    let expanded = expand_tilde(&ws);
    let dir = std::path::Path::new(&expanded).join(".grok-gui-paste");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("无法创建粘贴目录：{}", e))?;
    let requested = std::path::Path::new(&safe_name);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("clipboard");
    let extension = requested.extension().and_then(|value| value.to_str());
    let mut path = dir.join(&safe_name);
    while path.exists() {
        let name = match extension {
            Some(extension) => format!("{}-{}.{}", stem, uuid::Uuid::new_v4(), extension),
            None => format!("{}-{}", stem, uuid::Uuid::new_v4()),
        };
        path = dir.join(name);
    }
    let image_data = base64::engine::general_purpose::STANDARD
        .decode(&base64)
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    tokio::fs::write(&path, image_data)
        .await
        .map_err(|e| format!("保存图片失败：{}", e))?;
    Ok(path.to_string_lossy().to_string())
}

fn is_previewable_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "heic" | "heif" | "ico")
    )
}

/// Grant the asset protocol access to one user-selected image. This keeps the
/// static scope narrow while allowing previews for images on external volumes.
#[tauri::command]
async fn allow_image_preview(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let requested = expand_tilde(&path);
    let canonical = tokio::fs::canonicalize(&requested)
        .await
        .map_err(|error| format!("无法读取图片：{}", error))?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| format!("无法读取图片：{}", error))?;
    if !metadata.is_file() || !is_previewable_image(&canonical) {
        return Err("只能预览受支持的图片文件。".into());
    }
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| format!("无法授权图片预览：{}", error))
}

#[tauri::command]
async fn show_in_finder(path: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
    let metadata = tokio::fs::metadata(&expanded)
        .await
        .map_err(|e| format!("无法访问路径：{}", e))?;
    let target = if metadata.is_dir() {
        expanded.clone()
    } else {
        std::path::Path::new(&expanded)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(expanded.clone())
    };
    let mut cmd = std::process::Command::new("open");
    cmd.arg(&target);
    let status = cmd
        .status()
        .map_err(|e| format!("无法启动 Finder：{}", e))?;
    if !status.success() {
        return Err(format!("Finder 打开失败：{:?}", status.code()));
    }
    Ok(())
}

#[tauri::command]
async fn open_session_window(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    let session_prefix = session_id.chars().take(8).collect::<String>();
    let label = format!("session-{}", session_prefix);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    // `WebviewUrl::App` takes an app-relative filesystem path, not an absolute
    // tauri:// URL. Build a real local URL so the query reaches App.tsx.
    let mut url = tauri::Url::parse("tauri://localhost/")
        .map_err(|error| format!("无法构造会话链接：{}", error))?;
    url.query_pairs_mut().append_pair("session", &session_id);
    let _ = WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(format!("Grok GUI Lite · {}", session_prefix))
        .inner_size(1100.0, 720.0)
        .build()
        .map_err(|e| format!("无法创建窗口：{}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            detect_grok_cli,
            install_official_grok_cli,
            login_grok_oauth,
            login_grok_device_code,
            save_xai_api_key,
            get_auth_mode,
            check_connection,
            start_session,
            stop_session,
            list_active_sessions,
            cancel_turn,
            compact_session,
            send_message,
            set_model,
            respond_permission,
            set_auto_approve,
            list_providers,
            inspect_grok_configuration,
            list_mcp_servers,
            diagnose_mcp_server,
            upsert_mcp_server,
            remove_mcp_server,
            workspace_overview,
            workspace_file,
            workspace_diff,
            workspace_list_dir,
            workspace_search,
            show_in_finder,
            open_session_window,
            save_clipboard_image,
            allow_image_preview,
            set_keep_awake,
        ])
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            info!("Grok GUI Lite started (v{})", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Grok GUI Lite");
}

#[cfg(test)]
mod session_pool_tests {
    use super::{lru_oldest, SessionPool};
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    #[test]
    fn lru_oldest_returns_none_for_empty() {
        let map: HashMap<String, Instant> = HashMap::new();
        assert!(lru_oldest(&map).is_none());
    }

    #[test]
    fn lru_oldest_picks_the_earliest_timestamp() {
        let base = Instant::now();
        let mut map = HashMap::new();
        map.insert("a".to_string(), base - Duration::from_millis(100));
        map.insert("b".to_string(), base - Duration::from_millis(10));
        map.insert("c".to_string(), base - Duration::from_millis(50));
        // "a" has the oldest (smallest) timestamp -> evicted first.
        assert_eq!(lru_oldest(&map).as_deref(), Some("a"));
    }

    #[test]
    fn lru_oldest_handles_a_single_entry() {
        let base = Instant::now();
        let mut map = HashMap::new();
        map.insert("only".to_string(), base);
        assert_eq!(lru_oldest(&map).as_deref(), Some("only"));
    }

    #[test]
    fn empty_pool_reports_no_active_sessions() {
        let pool = SessionPool::new();
        assert!(pool.active_ids().is_empty());
        assert_eq!(pool.len(), 0);
        assert!(!pool.contains("anything"));
    }

    #[test]
    fn empty_pool_remove_returns_none() {
        let mut pool = SessionPool::new();
        assert!(pool.remove("missing").is_none());
    }

    #[test]
    fn try_admit_records_placeholder_for_a_new_key() {
        let mut pool = SessionPool::new();
        assert!(pool.try_admit("hint-a", "new-session"));
        assert_eq!(pool.in_flight.len(), 1);
    }

    #[test]
    fn try_admit_is_free_for_a_resumed_session_id() {
        let mut pool = SessionPool::new();
        assert!(pool.try_admit("hint-a", "already-running"));
        pool.release_reservation("hint-a");
        assert!(pool.try_admit("hint-b", "new-session"));
        pool.release_reservation("hint-b");
    }

    #[test]
    fn try_admit_rejects_when_pool_is_full() {
        let mut pool = SessionPool::new();
        // Saturate the admission gate with MAX_RUNTIMES placeholders.
        for i in 0..super::MAX_RUNTIMES {
            let hint = format!("hint-{i}");
            assert!(
                pool.try_admit(&hint, "unused"),
                "expected hint {hint} to be admitted while capacity remains"
            );
        }
        // Next spawn must be refused.
        assert!(!pool.try_admit("hint-overflow", "unused"));
        // Releasing one slot must let the next call back in.
        pool.release_reservation("hint-0");
        assert!(pool.try_admit("hint-recovered", "unused"));
    }

    #[test]
    fn release_reservation_is_idempotent() {
        let mut pool = SessionPool::new();
        pool.release_reservation("never-admitted");
        assert!(pool.in_flight.is_empty());
        pool.try_admit("hint", "unused");
        pool.release_reservation("hint");
        pool.release_reservation("hint"); // double release is safe.
        assert!(!pool.in_flight.contains("hint"));
    }

    #[test]
    fn in_flight_total_plus_runtimes_never_exceeds_cap_when_filling_via_admit() {
        let mut pool = SessionPool::new();
        for i in 0..super::MAX_RUNTIMES {
            assert!(pool.try_admit(&format!("hint-{i}"), "rt"));
        }
        assert!(!pool.try_admit("spawn-blocked", "rt"));
    }
}

#[cfg(test)]
mod cli_resolution_tests {
    use super::{
        is_previewable_image, mcp_servers_from_list, official_installer_script,
        resolve_grok_bin_for, save_clipboard_image, validate_api_key,
    };
    use base64::Engine as _;
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn finds_the_installer_cli_without_inheriting_a_terminal_path() {
        let root = std::env::temp_dir().join(format!("grok-gui-cli-test-{}", std::process::id()));
        let bin = root.join(".grok/bin/grok");
        std::fs::create_dir_all(bin.parent().expect("bin parent"))
            .expect("create test cli directory");
        std::fs::write(&bin, b"test cli").expect("create test cli");

        let resolved =
            resolve_grok_bin_for(None, Some(&root), None).expect("resolve installer CLI");
        assert_eq!(resolved, bin);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn official_installer_is_the_documented_xai_command() {
        assert_eq!(
            official_installer_script(),
            "curl -fsSL https://x.ai/cli/install.sh | bash"
        );
    }

    #[test]
    fn rejects_blank_or_multiline_api_keys() {
        assert!(validate_api_key(" ").is_err());
        assert!(validate_api_key("xai-one\ntwo").is_err());
        assert_eq!(
            validate_api_key("  xai-valid  ").expect("valid key"),
            "xai-valid"
        );
    }

    #[tokio::test]
    async fn saves_a_pasted_image_inside_the_workspace_and_sanitizes_its_name() {
        let root =
            std::env::temp_dir().join(format!("grok-gui-image-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temporary workspace");
        let bytes = [137, 80, 78, 71, 13, 10, 26, 10];
        let payload = base64::engine::general_purpose::STANDARD.encode(bytes);

        let saved = save_clipboard_image(
            Some(root.to_string_lossy().to_string()),
            "../clipboard.png".to_string(),
            payload,
        )
        .await
        .expect("save clipboard image");

        let path = std::path::Path::new(&saved);
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("clipboard.png")
        );
        assert_eq!(path.parent(), Some(root.join(".grok-gui-paste").as_path()));
        assert_eq!(std::fs::read(path).expect("saved image bytes"), bytes);

        let second = save_clipboard_image(
            Some(root.to_string_lossy().to_string()),
            "clipboard.png".to_string(),
            base64::engine::general_purpose::STANDARD.encode([1, 2, 3]),
        )
        .await
        .expect("avoid overwriting an existing pasted image");
        assert_ne!(saved, second);
        assert_eq!(
            std::fs::read(second).expect("second image bytes"),
            [1, 2, 3]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn permits_only_supported_image_extensions_for_preview() {
        assert!(is_previewable_image(Path::new("/Volumes/work/image.WEBP")));
        assert!(is_previewable_image(Path::new("/Volumes/work/photo.jpeg")));
        assert!(!is_previewable_image(Path::new("/Volumes/work/readme.md")));
        assert!(!is_previewable_image(Path::new(
            "/Volumes/work/no-extension"
        )));
    }

    #[test]
    fn mcp_mapping_skips_bad_entries_without_blocking_a_session() {
        let mapped = mcp_servers_from_list(&json!([
            { "name": "valid", "command": "node", "args": ["server.js"], "enabled": true },
            { "command": "missing-name", "enabled": true },
            { "name": "disabled", "command": "ignored", "enabled": false },
            { "name": "broken", "enabled": true }
        ]));

        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["name"], "valid");
        assert_eq!(mapped[0]["command"], "node");
    }

    #[test]
    fn mcp_mapping_tolerates_an_unexpected_cli_json_shape() {
        assert!(mcp_servers_from_list(&json!({ "servers": [] })).is_empty());
    }

    #[test]
    fn mcp_mapping_accepts_a_wrapped_cli_server_list() {
        let mapped = mcp_servers_from_list(&json!({
            "servers": [{ "name": "wrapped", "command": "node", "args": ["server.js"] }]
        }));
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["name"], "wrapped");
    }
}
