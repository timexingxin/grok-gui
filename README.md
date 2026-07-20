# Grok GUI

A cross-platform desktop GUI for [Grok Build](https://github.com/xai-org/grok-build) — a beautiful, multi-provider AI coding & writing agent.

> **Status: working ACP client.** Talks to a real `grok agent stdio` child process over JSON-RPC 2.0: live streaming, tool-call cards, plan view, permission levels, workspace workbench, transcripts, and a light/dark Codex-style UI.

[![CI](https://github.com/timexingxin/grok-gui/actions/workflows/ci.yml/badge.svg)](https://github.com/timexingxin/grok-gui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://tauri.app)

## Features

- **Multi-session parallel** — run several Grok Build conversations in parallel; switch without interrupting the running turn. The Rust side keeps a pool of live runtimes (LRU-evicted, idle-only) so background tasks keep streaming.
- **Two auth paths** — sign in with your `grok.com` account (OAuth), or paste an xAI API key. The picker shows the right model catalogue for each (Groks 3, 4, 4.5, 4-fast reasoning) and swaps the env when you switch.
- **Ask / Plan / Build** — Codex-style permission levels mapped to Grok's three sandboxes. Ask is read-only, Plan is read-only + no shell, Build is full access. Changes restart the agent so the sandbox policy always matches the picker.
- **First-run language picker** — English / 简体中文. Once chosen the choice persists in localStorage; the next launcher skips the picker.
- **Tool-call cards, plan view, workspace browser, transcripts** — the whole agent event surface rendered in a real GUI, not a terminal.
- **In-message ⋮ menu** — edit/quote-resend, interrupt-and-send, delete. Queued messages sit in an inline card above the composer.
- **Live token / cost / context-window** in the topbar.

## Inspiration

| Reference | What we borrowed |
|---|---|
| [OpenCode](https://github.com/sst/opencode) | Client-server architecture, multi-provider registry, event-driven design |
| [Codex](https://github.com/openai/codex) | macOS-style sidebar + composer, token / cost display, first-run picker |
| [DeepSeek GUI](https://github.com/KunAgent/Kun) (formerly XingYu-Zhong/DeepSeek-GUI) | Mode tabs (Code/Write), project pinning |
| [xai-org/grok-build](https://github.com/xai-org/grok-build) | The actual agent runtime (Rust TUI) we wrap |

## Why

Grok Build is open source, but it's a **TUI** (terminal UI). This project wraps it with a polished desktop shell that:

- Runs on **macOS, Windows, Linux** (via Tauri 2 — small binary, no Electron)
- Lets you **switch providers and models** on the fly (xAI, OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Ollama, and any OpenAI-compatible endpoint)
- Adds a real **Code / Write** mode toggle
- Renders **tool calls, file diffs, plan updates** in a real GUI
- Streams **token usage, cost, cache hit %** live in the topbar

## Architecture

```
┌──────────────────────────────────────────┐
│  Desktop Shell (Tauri 2)                 │   ← this repo
│  React + Vite + Tailwind + shadcn/ui     │
│  Zustand state, markdown rendering       │
└──────────────┬───────────────────────────┘
               │ Tauri commands + events (typed)
               ▼
┌──────────────────────────────────────────┐
│  Rust bridge (apps/desktop/src-tauri)    │   ← this repo
│  - spawns `grok` CLI as child process    │
│  - JSON-RPC 2.0 over stdio (ACP)         │
│  - emits GrokEvent → frontend            │
└──────────────┬───────────────────────────┘
               │ subprocess stdin/stdout
               ▼
┌──────────────────────────────────────────┐
│  Grok Build runtime (xai-org/grok-build) │   ← upstream, Apache-2.0
│  Agent loop, tools, context, MCP, skills │
└──────────────────────────────────────────┘
```

## Repo layout

```
grok-gui/
├── apps/
│   └── desktop/                 Tauri 2 app (Rust + React)
│       ├── src/                 React frontend
│       └── src-tauri/           Rust side (grok_runtime, tauri commands)
├── packages/
│   ├── ui/                      Shared React components (Sidebar, ChatArea, …)
│   ├── core/                    Types, Zustand store, utils (cn, formatTokens)
│   ├── provider/                Provider catalog (models.dev integration)
│   └── acp-bridge/              JSON-RPC 2.0 client for Grok Build
├── package.json                 npm workspaces
├── turbo.json                   Turborepo pipeline
└── tsconfig.base.json
```

## Quick start

```bash
# 1. Install deps (Node 20+, Rust 1.77+)
cd grok-gui
npm install

# 2. Run dev (Tauri hot-reloads the React side; Rust rebuilds on change)
npm run tauri:dev
```

The app requires the [Grok Build CLI](https://x.ai) on the host. If it is
missing, the app shows an onboarding screen with the one-line installer:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Set `GROK_BIN` to point at a non-default CLI location.

## Distribution (macOS)

```bash
npm run tauri:build
# → apps/desktop/src-tauri/target/release/bundle/dmg/Grok Build_0.1.0_aarch64.dmg
```

Share the `.dmg` directly: drag-to-Applications install, no other deps on the
target Mac (the grok CLI itself is still required and is offered by the
onboarding screen).

### Auto-update

The bundle ships `tauri-plugin-updater` with a minisign keypair generated at
`~/.tauri/grok-gui.key(.pub)`. To publish an update:

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`.
2. Build with the signing key in env:
   `TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/grok-gui.key) npm run tauri:build`
3. Upload the updater artifacts (`*.app.tar.gz` + `*.sig`) to your release
   host together with a `latest.json` pointing at them.
4. Replace the placeholder endpoint in `tauri.conf.json → plugins.updater.endpoints`
   with your real `latest.json` URL (GitHub Releases works fine).

In-app: Settings → 常规 → 应用更新 → 检查更新.

## Roadmap

| Phase | Status | What ships |
|---|---|---|
| **P0 scaffold** | ✅ | Three-pane layout, model selector, shadcn/ui theme |
| **P1 ACP bridge** | ✅ | Spawns `grok agent stdio`, real streaming, JSON-RPC frames |
| **P2 provider switching** | ✅ | Model picker fed by the live ACP `availableModels` handshake |
| **P3 tool visualization** | ✅ | Tool-call cards, command output, plan view, workspace changes/files |
| **P4 modes + settings** | ✅ | Ask/Plan/Build permission levels, Skills/MCP manager, settings page, light/dark themes |
| **P5 polish + ship** | ⏳ | Auto-update, crash reporting, macOS/Windows/Linux packages, docs |

## Known limitations

1. **Ad-hoc signing on macOS** — the bundled DMGs are signed with the
   `-` identity (ad-hoc) because no Apple Developer ID certificate is
   available in the build environment. First install will trigger the
   Gatekeeper "unidentified developer" prompt; right-click the app → Open
   to bypass, or sign with your own Developer ID before distribution.
2. **Upstream data-handling concerns** — `grok-build` was open-sourced
   after a security researcher documented it silently uploading
   repositories (including `.env` files) to xAI servers. The Rust side
   here only spawns the process with explicit args; **we do not add any
   extra network calls.** Before running on real code, audit
   `crates/runtime/` and `crates/codegen/xai-grok-tools/` in the
   upstream repo.
3. **xAI does not accept external PRs** to `grok-build`. This GUI is
   the layer where you can iterate freely. If upstream deletes the repo,
   Apache-2.0 still gives you the right to fork.
4. **Auto-update endpoint points at this repo but is not yet signed** —
   `plugins.updater.endpoints` in `tauri.conf.json` now resolves to
   `timexingxin/grok-gui`, but no `latest.json` is published and no
   `TAURI_SIGNING_PRIVATE_KEY` is set in the build env, so "Check for
   updates" will report no update available until you generate a minisign
   keypair and attach `latest.json` + `*.sig` to a release.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test commands,
and the release flow. Bug reports and PRs are welcome; for security
issues see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) for this repo. The wrapped `grok-build` runtime is
Apache-2.0 from [xai-org/grok-build](https://github.com/xai-org/grok-build).
