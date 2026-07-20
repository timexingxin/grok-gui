# Contributing

Thanks for your interest in Grok GUI! This is a Tauri 2 + React + Rust
monorepo. The Rust side talks to the `grok` CLI as a child process over
JSON-RPC 2.0 (ACP); the React side renders the agent event stream.

## Development setup

Prerequisites:

- **Node.js 20+**
- **Rust 1.77+** (`rustup default stable`)
- **macOS 12+** for `npm run tauri:dev` and `npm run tauri:build`.
  Linux/Windows builds work in principle but are not exercised by CI yet.

Clone and install:

```bash
git clone https://github.com/timexingxin/grok-gui.git grok-gui
cd grok-gui
npm install
```

## Daily workflow

| Command | What it does |
|---|---|
| `npm run tauri:dev` | Hot-reload the React side, recompile Rust on change. Requires a working `grok` CLI on `PATH` (or set `GROK_BIN`). |
| `npm run lint` | ESLint across all four workspaces. Must be clean. |
| `npm run typecheck` | `tsc --noEmit` per workspace. Must be clean. |
| `npm run test` | Vitest suites (Core + UI + Provider). |
| `npm run build` | Production frontend build into `apps/desktop/dist/`. |
| `cargo test` (in `apps/desktop/src-tauri`) | Rust unit + integration tests. |
| `cargo clippy -- -D warnings` (in `apps/desktop/src-tauri`) | Lints that must be clean. |
| `npm run tauri:build` | Full release DMG (and `.app.tar.gz` updater artifact on Linux). |

Before opening a PR, all of these must pass locally:

```bash
npm run lint && npm run typecheck && npm run test && npm run build
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
```

## Repo layout

```
apps/desktop/                Tauri 2 app shell
  src/                        React frontend
  src-tauri/                  Rust side (grok_runtime, tauri commands, SessionPool)
packages/
  core/                       Types, Zustand store, event routing
  ui/                         Shared React components (Sidebar, ChatArea, InputBar, …)
  provider/                   Provider catalog (built-in xai oauth / apiKey)
```

Rust code that talks to the `grok` child process lives in
`apps/desktop/src-tauri/src/grok_runtime.rs`. The session pool that
backs multi-session parallelism is in
`apps/desktop/src-tauri/src/lib.rs` (`SessionPool`).

## Coding style

- TypeScript: `strict: true`, no `any` in committed code, exhaustive
  `match` for `evt.type` in the event reducer.
- React: functional components only, hooks in custom form must
  document the closure semantics they rely on.
- Rust: `cargo clippy -- -D warnings` clean. Prefer `Arc<Mutex<…>>` for
  shared state; the pool is the only state that crosses the Tauri
  command boundary.
- Comments: explain *why*, not *what*. If the code is unclear, rewrite
  it; don't add a memo.

## Commit messages

Use the imperative mood ("Add pool admission control", not "Added").
One logical change per commit. Squash fixups before review.

## Releasing a new version

1. Bump `version` in `apps/desktop/src-tauri/Cargo.toml`,
   `apps/desktop/src-tauri/tauri.conf.json`, and `package.json` (keep
   them in lockstep).
2. Update `CHANGELOG.md` with a short, user-visible summary.
3. `npm run tauri:build` — verify DMG + codesign + lint + tests all pass.
4. Tag `vX.Y.Z` and push. The GitHub Actions release workflow attaches
   the DMG and the updater `.app.tar.gz` + `.sig`.

## Reporting bugs

Open an issue with:

- What you did (commands, click sequence)
- What you expected
- What happened (screenshots help)
- `Grok GUI` version + macOS version + `grok --version`

For security issues, **do not** open a public issue — see
[SECURITY.md](./SECURITY.md).
