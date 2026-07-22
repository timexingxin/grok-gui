# Reddit r/LocalLLaMA post — Grok GUI

> r/LocalLLaMA is the highest-signal AI dev subreddit. Technical
> audience that values depth over hype. Post as a "Show" / "Project" with
> depth — short promotional posts get downvoted to hell.

## Title

> I built a native desktop GUI for the Grok Build coding agent — Tauri 2, ACP/JSON-RPC, multi-provider, MIT

## Body

Hey all,

I use `grok-build` (xAI's open-source Rust coding agent) daily. It's
genuinely good at code work — on par with Claude Code for my workflow.
But it ships as a TUI, and after 6 months of `cmd+tab` between the
terminal and my browser tabs I snapped. So I built a real desktop
shell for it.

**Repo:** https://github.com/timexingxin/grok-gui
**Demo GIF:** https://github.com/timexingxin/grok-gui/blob/main/docs/demo-frames/demo.gif

### Architecture (the interesting part)

It's not a web wrapper around a chat API. It's a thin client around
the actual agent runtime:

```
┌──────────────────────────────────────────┐
│  Desktop Shell (Tauri 2, ~8 MB)          │   React + Vite + Tailwind
└──────────────┬───────────────────────────┘
               │ Tauri commands + events (typed)
               ▼
┌──────────────────────────────────────────┐
│  Rust bridge (apps/desktop/src-tauri)    │
│  - spawns `grok` CLI as child process    │
│  - JSON-RPC 2.0 over stdio (ACP)         │
│  - LANG/LC_ALL forwarded for agent locale│
└──────────────┬───────────────────────────┘
               │ subprocess stdin/stdout
               ▼
┌──────────────────────────────────────────┐
│  Grok Build runtime (xai-org/grok-build) │   upstream, Apache-2.0
│  Agent loop, tools, context, MCP, skills │
└──────────────────────────────────────────┘
```

The Rust side keeps a pool of live runtimes (LRU-evicted on idle), so
you can have several conversations streaming in parallel and switch
between them without interrupting any.

### What I learned building it

1. **ACP is the right protocol boundary.** The Agent Client Protocol
   the upstream uses gives you a clean event stream: text deltas,
   tool calls, plan updates, permission requests, session lifecycle.
   No scraping the terminal, no parsing ANSI codes. If you're
   wrapping a TUI agent, ask whether it has an ACP first.

2. **Tauri 2 vs Electron for desktop AI tools.** Tauri 2 binary is
   ~8 MB vs Electron's ~150 MB, and the WebKit webview feels closer
   to a native app than Chromium. The tradeoff is the Rust dependency
   for the runtime side — fine for a tool like this where the
   runtime is already Rust (we'd be paying that cost anyway).

3. **Multi-provider abstraction matters more than I expected.**
   Most users I demoed this to were already paying for multiple
   model providers and wanted a single client that handled all of
   them. The agent handshake returns a model catalogue at runtime
   — no hardcoding needed.

4. **LANG/LC_ALL propagation is non-obvious.** The UI can be in
   English but the agent inherits the system locale and replies in
   Chinese (or whatever the host is). The fix: thread the UI's
   `settings.language` through to the spawn, and set `LANG` +
   `LC_ALL` on the child. Trivial in code, would have taken me a
   week of debugging without noticing.

### Things I'm being upfront about

- **Ad-hoc signed DMGs.** No Apple Developer ID yet. First install
  triggers the Gatekeeper "unidentified developer" prompt.
- **`grok-build` was open-sourced after a security researcher
  documented it silently uploading repos (including .env files) to
  xAI servers.** The Rust side here only spawns the process with
  explicit args; we add zero network calls of our own. Audit
  upstream before running on real code.
- **xAI doesn't accept external PRs to `grok-build`.** This GUI is
  the layer where the community can iterate.

### Try it

```bash
brew install --cask timexingxin/grok-gui/grok-gui-lite
```

Or grab the macOS DMG / Windows .exe from the release page.

Happy to answer questions about the ACP integration, the multi-runtime
pool design, or anything else.
