# Show HN: Grok GUI — A native desktop GUI for the Grok Build coding agent

## Title (HN limits to 80 chars; "Show HN:" prefix doesn't count)

**Show HN: I wrapped Grok's TUI coding agent in a real desktop shell**

(72 chars — within limit)

## URL

https://github.com/timexingxin/grok-gui

## Text body

> I use `grok-build` (xAI's open-source Rust coding agent) daily. It's
> genuinely good — comparable to Claude Code for actual code work — but
> it ships as a TUI. After 6 months of `cmd+tab` between the terminal and
> my browser tabs, I built a native macOS/Windows GUI for it.
>
> **What's in the box:**
>
> - A Tauri 2 desktop shell (~8 MB) that spawns `grok agent stdio` as a
>   child process and talks to it over ACP/JSON-RPC 2.0. Every event the
>   agent emits (text deltas, tool calls, plan updates, permission
>   requests) renders as a real GUI element — not a terminal escape code.
> - Multi-session parallel. Run several conversations side by side, switch
>   without interrupting the running turn.
> - Ask / Plan / Build permission modes, mapped to Grok's three
>   sandboxes. Read-only → read-only + no shell → full disk + shell access.
>   The mode switch actually re-spawns the agent, so the sandbox
>   policy always matches what the UI says.
> - Multi-provider. xAI, OpenAI, Anthropic, Google, DeepSeek, OpenRouter,
>   Ollama, and any OpenAI-compatible endpoint. The model catalogue shown
>   in the picker comes from the agent's live handshake, so newly
>   released models appear without a GUI update.
> - First-run language picker. Pick English or 简体中文 once, the choice
>   is forwarded to the agent runtime via `LANG`/`LC_ALL` so the agent
>   speaks the same language as the UI (workspace-level `AGENTS.md` still
>   overrides — that's intentional).
> - Codex-style sidebar + composer, tool-call cards, plan view, live
>   token / cost / context-window in the topbar.
>
> **Why not just use Cursor / Claude Code?**
>
> - Cursor is great but closed-source and Anthropic/OpenAI-only.
> - Claude Code is terminal-only and Anthropic-only.
> - Grok's own models (Grok 4.5 with reasoning effort) deserve a
>   first-class client.
> - The underlying `grok-build` runtime is open-source (Apache-2.0), so
>   this can be a community-maintained GUI the way nvim is for vim.
>
> **Stack:**
>
> - Rust runtime (apps/desktop/src-tauri/src/grok_runtime.rs) — spawns
>   the CLI, manages a pool of live runtimes, handles the JSON-RPC
>   session/permission/tool-call protocol.
> - React + Vite + Tailwind + shadcn/ui frontend.
> - Zustand state with persist middleware for transcripts.
> - Tauri 2 (so the binary is ~8 MB, not 150 MB Electron).
> - Apple Silicon + Intel + Windows x64. Linux works in dev but the
>   release pipeline doesn't package it yet.
>
> **One-line install:**
>
>     brew install --cask timexingxin/grok-gui/grok-gui-lite
>
> Or download the macOS DMG / Windows .exe from the release page.
>
> **Known caveats I'm being upfront about:**
>
> - The DMGs are ad-hoc-signed (no Apple Developer ID). Right-click the
>   app → Open on first install, or use the included `First-Run-Open-Me.command`
>   to clear the quarantine attribute.
> - `grok-build` was open-sourced after a security researcher
>   documented it silently uploading repos (including .env files) to xAI
>   servers. The Rust side here only spawns the process with explicit args
>   — we add zero network calls of our own. Audit the upstream runtime
>   before running on real code.
> - xAI doesn't accept external PRs to `grok-build`. This GUI is the
>   layer where the community can iterate. If upstream deletes the repo,
>   Apache-2.0 still gives you the right to fork.
>
> Repo: https://github.com/timexingxin/grok-gui
> Demo: https://github.com/timexingxin/grok-gui/blob/main/docs/demo-frames/demo.gif
>
> Would love feedback on the permission-mode UX, the multi-session
> parallelism model (we keep a pool of LRU-evicted live runtimes so
> background turns keep streaming), and whether anyone wants me to
> prioritize a Linux release pipeline.

## Notes for the author

- **Posting time**: Monday 9:00 AM PT (HN peak)
- **Be ready to respond** in the first 60 minutes; that's where the
  ranking gets cemented
- **Don't edit the post** for at least 2 hours; HN penalizes edits
- **Have a demo link** that works without signup (GitHub README does)
- **Anticipated first questions**:
  - "Why not just use [Cursor/Claude Code]?" — answered in the body
  - "Is this affiliated with xAI?" — No, this is an independent OSS
    project that wraps their open-source agent
  - "How does it compare to [other coding agent GUIs]?" — link the
    comparison table in README
