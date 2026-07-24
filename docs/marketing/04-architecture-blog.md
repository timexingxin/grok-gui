# Building a desktop client for an AI coding agent

*Lessons from wrapping grok-build — the architecture, the traps, and why we picked Tauri over Electron.*

---

## TL;DR

`grok-build` is xAI's open-source Rust coding agent. It ships as a TUI. We
wrote a native desktop client for it — Tauri 2 (~8 MB binary), React
frontend, Rust runtime that spawns the CLI as a child process and talks
to it over ACP/JSON-RPC 2.0. This post is the architecture deep-dive:
how the pieces fit together, what surprised us, and the parts we'd
build differently next time.

The full source is at [github.com/timexingxin/grok-gui](https://github.com/timexingxin/grok-gui).
MIT-licensed. Demo GIF in the README.

---

## The problem

`grok-build` is genuinely good at code work — comparable to Claude Code
for my workflow. But it ships as a Rust TUI. After six months of
`cmd+tab` between the terminal and my browser tabs, I wanted a real
desktop UX without losing what makes the CLI good.

The naive options all had problems:

- **Wrap it as a tmux session in a webview.** Doesn't help — you're
  still reading scrollback.
- **Use a community-built web wrapper.** They all wrap the OpenAI
  Chat Completions API directly. They don't talk to the actual
  agent runtime, so they miss tool calls, plan updates, permission
  requests, and the streaming event surface that makes coding agents
  feel responsive.
- **Write a desktop GUI from scratch.** Means re-implementing the
  agent loop, the model integration, the tool calling. Six months of
  work, plus the resulting client would always lag the upstream.

The right answer was staring at me: `grok-build` already has a
**JSON-RPC 2.0 over stdio** interface called the Agent Client Protocol
(ACP). That's the protocol I should be a client of. My job is just to
write the client.

---

## What is ACP?

[ACP](https://agentclientprotocol.com/) is a JSON-RPC 2.0 protocol that
coding-agent CLIs expose over their stdin/stdout. The agent emits
notifications (text deltas, tool calls, plan updates, permission
requests, session lifecycle); the client sends requests (user prompts,
permission responses, model switches, session loads).

If your agent speaks ACP, you can write a client without re-implementing
the agent loop. You just connect to the stdio, parse the JSON frames,
and render.

```
┌──────────────────────────────────────────┐
│  Desktop Shell (Tauri 2, ~8 MB)          │   React + Vite + Tailwind
└──────────────┬───────────────────────────┘
               │ Tauri commands + events (typed)
               ▼
┌──────────────────────────────────────────┐
│  Rust bridge (apps/desktop/src-tauri/src/grok_runtime.rs)
│  - spawns `grok agent stdio` as a child │
│  - JSON-RPC 2.0 over its stdin/stdout   │
│  - LANG/LC_ALL forwarded for locale     │
│  - manages a pool of live runtimes      │
└──────────────┬───────────────────────────┘
               │ subprocess stdin/stdout
               ▼
┌──────────────────────────────────────────┐
│  Grok Build runtime (xai-org/grok-build) │   upstream, Apache-2.0
│  Agent loop, tools, context, MCP, skills │
└──────────────────────────────────────────┘
```

The Rust bridge is the interesting part. It manages the lifecycle:
spawn the child, do the initialize handshake (where the agent tells
us its version and supported features), do a session/new or
session/load, stream every event into the frontend. The frontend just
listens for typed events and renders.

---

## Why Tauri, not Electron

I considered both. The decision matrix:

|  | Tauri 2 | Electron |
|---|---|---|
| **Binary size** | ~8 MB | ~150 MB |
| **Memory (idle)** | ~80 MB | ~300 MB |
| **Webview** | OS-native WebKit / WebView2 | Bundled Chromium |
| **Native feel** | Closer (real OS widgets) | Web app |
| **Backend language** | Rust | Node.js |
| **IPC overhead** | Function call (typed structs) | JSON-over-IPC |

Tauri won for three reasons:

1. **The backend was already going to be Rust.** `grok-build` is
   Rust, the ACP client had to be Rust to spawn and talk to it
   properly, and Rust is a good fit for the long-running
   process-pool pattern. Electron would have meant Rust + Node.js in
   the same project.

2. **8 MB vs 150 MB matters for distribution.** A coding tool
   installer shouldn't be larger than the Electron runtime itself
   is on disk. The 150 MB Electron app feels heavy on a MacBook
   where the rest of the system is small native binaries.

3. **OS-native webview feels right.** WebKit on macOS renders
   identically to Safari, which means the React app looks like a
   Mac app, not a Windows-95 webpage. The title-bar-style="hiddenInset"
   + trafficLightPosition settings give us native window controls
   without the visible title bar.

The tradeoff: Tauri requires the MSVC build tools on Windows. But
`windows-latest` GitHub Actions runners have those preinstalled, so
the CI cost is the same.

---

## Multi-session parallel

The killer feature for me is having multiple conversations going at
once. If I'm asking Grok to refactor one file while waiting on a
different task, I don't want to lose the first turn's stream when I
switch.

Naive implementation: spawn N CLI processes on app startup. Wasteful
for users who only have one session going.

What I built: a **pool of live runtimes**, LRU-evicted on idle.

```rust
// pseudocode
struct RuntimePool {
    runtimes: HashMap<SessionId, GrokRuntime>,
    capacity: usize,
}

fn acquire(pool: &mut RuntimePool, session_id: SessionId) -> GrokRuntime {
    if let Some(rt) = pool.runtimes.remove(&session_id) {
        // LRU hit: re-use the existing process. No spawn cost.
        return rt;
    }
    if pool.runtimes.len() >= pool.capacity {
        // Evict the least-recently-used idle runtime.
        let (victim_id, victim_rt) = pool.runtimes.pop_lru();
        victim_rt.shutdown();
    }
    // Spawn a new CLI subprocess.
    GrokRuntime::spawn(...)
}
```

When a user starts a new session, the pool looks up an existing live
runtime for that session id. If found, it reuses it — no spawn cost,
no handshake re-init. If the pool is at capacity, it shuts down the
least-recently-used idle runtime (a graceful kill, waiting up to 5s for
the agent to settle). Otherwise it spawns a new CLI.

The LRU eviction is critical because `grok agent stdio` can hold
hundreds of MB of context in memory. Without eviction, opening a few
sessions would have eaten all available RAM. With eviction, idle
sessions are cleaned up and the user's working set stays bounded.

The "background turn keeps streaming" behavior — the bit I'm most
proud of — comes for free from this design. A session that the user
isn't currently looking at still has its `GrokRuntime` alive in the
pool, which means the child process is still running, which means the
agent is still streaming events. When the user switches back, they
see the latest state, not a blank panel that has to catch up.

---

## Multi-provider abstraction

`grok-build` defaults to xAI. We didn't want to be a single-vendor
client — that's a strategic dead-end.

The protocol makes this easy. The agent's `initialize` handshake
returns its `availableModels` list, and the `session/set_model`
request switches between them. The CLI handles the provider-specific
plumbing (API keys, request shapes, streaming formats); we just tell
it which model to use.

Frontend side: a `useActiveModel()` Zustand selector reads from the
handshake's `availableModels`. Switching models is a single IPC call.

```typescript
// store layer
const resp = await tauri.invoke("start_session", {
  workspacePath: workspace,
  provider: get().activeModel?.providerId ?? "xai",
  model: get().activeModel?.id ?? "grok-4.5",
  // ...
  locale: language ?? get().settings.language,
});
```

```rust
// rust bridge — the model is passed verbatim to the CLI
let mut cmd = Command::new(&grok_bin);
cmd.env("XAI_API_KEY", api_key);
// ...
cmd.args(["agent", "stdio"]);
cmd.args(["--model", model]);  // or via `session/set_model` post-init
```

The upshot: the same UI works against xAI, OpenAI, Anthropic, Google,
DeepSeek, OpenRouter, Ollama, and any OpenAI-compatible endpoint. As
long as the agent runtime supports a model, the picker shows it.

---

## The LANG/LC_ALL bug (and why it matters more than you'd think)

The most embarrassing bug I shipped was this: the UI language
picker stored the user's choice ("English" / "简体中文"), but I never
threaded it through to the spawned `grok agent stdio` process. The
process inherited the system locale — zh_CN on my Mac — and replied in
Chinese no matter what the UI said.

The fix is one-liner, but the principle is bigger:

```rust
if let Some(lang_value) = locale_env_value(options.locale.as_deref()) {
    cmd.env("LANG", &lang_value);
    cmd.env("LC_ALL", &lang_value);
}
```

`LANG` is the de-facto standard locale env var. `LC_ALL` is the
override (some CLIs check it before `LANG`). Setting both is belt-and-
suspenders. The mapping handles the two picker values explicitly:

```rust
fn locale_env_value(locale: Option<&str>) -> Option<String> {
    let tag = locale?;
    let posix = match tag {
        "en-US" | "en" => "en_US.UTF-8".to_string(),
        "zh-CN" | "zh" => "zh_CN.UTF-8".to_string(),
        other if other.contains('-') => other.replacen('-', "_", 1),
        other => other.to_string(),
    };
    Some(format!("{}.UTF-8", posix))
}
```

The generic `'-' -> '_'` fallthrough means a future `fr-FR` picker
just works without code changes.

The principle: **if your spawned subprocess has any user-facing
output that touches language, the system locale isn't good enough**.
The user's UI choice is the only thing that's actually under their
control. Thread it through explicitly.

---

## Permission modes: Ask / Plan / Build

`grok-build` has three sandbox modes — read-only, read-only + no shell,
full access. I mapped them to Codex-style Ask / Plan / Build pickers
in the UI:

| Picker | Sandbox | Shell | File writes | Network |
|---|---|---|---|---|
| **Ask** | strict | ❌ | ❌ | ✅ |
| **Plan** | read-only | ❌ | ❌ | ✅ |
| **Build** | off | ✅ | ✅ | ✅ |

The non-obvious bit: when the user switches modes, **the agent has to
be restarted**. The sandbox is set at process-creation time (it's an
argv flag `--sandbox`), so an in-flight runtime can't have its
permissions downgraded.

```rust
// On mode change in the UI:
fn switch_mode(session_id: SessionId, new_mode: String) {
    let old_rt = pool.runtimes.remove(&session_id);
    old_rt.shutdown();          // graceful kill
    let new_rt = GrokRuntime::spawn(/* ...with new_mode... */);
    pool.insert(session_id, new_rt);
}
```

This is annoying in practice — a 2-3 second stall when switching —
but the alternative is the UI lying about what's safe. We chose the
honest version.

---

## Signing & distribution: the parts that aren't in the docs

Things nobody tells you until you're shipping:

**macOS ad-hoc signing is not "real" signing.** A signed-with-`-`
.app bundle is unsigned from Gatekeeper's perspective — first install
triggers the "unidentified developer" prompt. The workaround is
right-click → Open, or our `First-Run-Open-Me.command` script that
clears the `com.apple.quarantine` xattr. To get out of this you need
a real Apple Developer ID ($99/year) and a notarized build through
`xcrun notarytool`. We don't have either.

**The Electron placeholder signature is broken.** Out of the box,
electron-builder produces a Windows .exe whose Authenticode signature
is broken in a specific way: the linker signs the binary as
`Identifier=Electron`, then electron-builder renames the executable
to your product name, and the CodeDirectory says "no sealed resources"
but the bundle has resources. Windows code-signing tools will reject
this. macOS Sequoia Gatekeeper also rejects it with "damaged, can't be
opened."

The fix: a post-build `codesign --force --deep --sign -` hook that
re-signs the .app bundle with an ad-hoc identity after electron-builder
finishes. We wire this via `electron-builder.yml`'s `afterSign` hook,
which calls `scripts/afterSign.js` (with `process.platform` check to
skip on non-darwin).

**Code-signing on Windows CI is a 5-minute job.** Tauri Windows uses
WiX 3.14's `light.exe`, which crashes on github-actions windows-latest
with "failed to run ...\WixTools314\light.exe" (a known .NET Framework
dependency issue). We work around it by passing `--bundles nsis` to
`tauri build`, which skips the MSI target and only builds the NSIS
installer (which uses `makensis`, bundled with the Tauri CLI, no
dependency hell).

**The nested `packages/core/` duplication is a maintenance hazard.**
The Tauri and Electron runtimes are separate projects in the same
repo. The Electron one vendors a copy of `packages/core/src/stores/`
into `electron-version/packages/core/src/` so it can build
independently. Every time the store changes (e.g., the new `locale`
parameter), you have to sync the nested copy. We don't yet have a
pre-commit hook for this.

---

## What we'd build differently

1. **Stream the agent's plan/permission requests into a separate
   notification surface.** Right now they're inline tool-call cards
   in the conversation. They should be push notifications so the user
   can act on them while looking at another tab.

2. **Cache `grok agent stdio`'s initialization.** Every session spawn
   re-does the JSON-RPC initialize handshake, which costs ~300ms.
   With enough workspace-state fingerprinting, we could skip the
   handshake for "this is the same workspace I just talked to" cases.

3. **Open the multi-runtime pool to other backends.** Right now the
   pool is hard-coded to `grok agent stdio`. Other ACP servers
   (OpenCode, Claude Code, Continue) could share the same pool
   infrastructure.

4. **Make `AGENTS.md` aware.** Workspace-level rules override the
   UI language picker today (correctly — they're more specific). But
   the user has to discover this. A small badge in the chat header
   when an AGENTS.md is in play would help.

---

## Try it

```bash
brew install --cask timexingxin/grok-gui/grok-gui-lite
```

Or grab the macOS DMG / Windows .exe from the
[releases page](https://github.com/timexingxin/grok-gui/releases/latest).
Source at
[github.com/timexingxin/grok-gui](https://github.com/timexingxin/grok-gui).
MIT-licensed. The wrapped `grok-build` runtime is Apache-2.0 from
[xai-org/grok-build](https://github.com/xai-org/grok-build).

If you write a desktop client for an AI agent and hit any of these
patterns, I'd love to compare notes — open an issue or hit me up on
Twitter [@timexingxin](https://twitter.com/timexingxin).
