# Twitter / X thread — Grok GUI launch

> Total: 8 tweets + 1 video tweet. All under 280 chars. Post Monday 9am PT
> for peak engagement. The video tweet (tweet 5) is the hero — everything
> else is supporting copy.

## Pre-thread (pinned to your profile, separate from the thread)

> I built a native macOS/Windows GUI for the @xai Grok Build coding agent.
>
> Same client/server split as @opencode_oss, but with a Codex-style native
> UX instead of a terminal.
>
> Free, open source, multi-provider. Thread ↓

(Quote-tweet this with the 30s promo video as the body.)

---

## The thread (8 tweets, reply chain)

### Tweet 1 / 8 — Problem
> I use @xai's `grok-build` daily. It's genuinely good.
>
> But it ships as a TUI. After 6 months of `cmd+tab` between my terminal
> and browser tabs, I snapped.
>
> Built a native GUI for it. Free, MIT, ~8MB Tauri 2. ↓

(94 chars)

### Tweet 2 / 8 — What it is
> Grok GUI wraps `grok agent stdio` in a real desktop shell.
>
> - Spawns the CLI as a child process
> - Talks to it over ACP / JSON-RPC 2.0
> - Streams every event (text deltas, tool calls, plan updates, permissions) into React
>
> No re-implementation. Same engine, better seat.

(229 chars)

### Tweet 3 / 8 — Features
> What you get that the TUI doesn't have:
>
> • Multi-session parallel w/ live runtime pool
> • Ask / Plan / Build sandbox modes (re-spawns agent to actually enforce)
> • Live token / cost / context-window
> • Tool-call cards, plan view, workspace browser
> • OAuth OR API key, picker swaps env

(220 chars)

### Tweet 4 / 8 — Multi-provider
> Not locked to xAI. Same UI runs against:
>
> xAI · OpenAI · Anthropic · Google · DeepSeek · OpenRouter · Ollama · any OpenAI-compatible endpoint
>
> Model catalogue comes from the agent's live handshake — new models appear without a GUI update.

(184 chars)

### Tweet 5 / 8 — THE VIDEO (hero tweet)
> [VIDEO: 30s demo — `grok-gui-promo-X-subtitled.mp4`]
>
> Shot from a real session, not mockups. Shows the Codex-style UI,
> Grok actually answering a Python typing question, 23.5k tokens live
> in the topbar.

(144 chars + video)

### Tweet 6 / 8 — The data-handling caveat (transparency wins trust)
> Two things I'm upfront about:
>
> 1. Ad-hoc signed DMGs (no Apple Developer ID yet). First install
>    triggers Gatekeeper — right-click → Open, or use the included
>    First-Run-Open-Me.command.
>
> 2. `grok-build` was open-sourced after a security researcher
>    documented it silently uploading .env files. We add ZERO
>    network calls of our own. Audit upstream before running on
>    real code.

(279 chars)

### Tweet 7 / 8 — One-line install
> Install:
>
> `brew install --cask timexingxin/grok-gui/grok-gui-lite`
>
> Or grab the macOS DMG / Windows .exe from the release page:
>
> github.com/timexingxin/grok-gui/releases/latest
>
> Source, issues, and architecture diagrams in the repo.

(229 chars)

### Tweet 8 / 8 — Call for collaboration
> What I'd love feedback on:
>
> - The permission-mode UX (sandbox switch forces re-spawn — is that
>   right or annoying?)
> - The multi-session pool (LRU on idle runtimes — is "background
>   turn keeps streaming" the right default?)
> - Linux release pipeline (works in dev, not packaged)
>
> Repo in next tweet ↓

(234 chars)

## Engagement plan after posting

- **First 30 min**: respond to every comment, even short ones. HN-style
  engagement matters for reach
- **Pin a reply** linking to the GitHub repo with the most-detailed install
  instructions
- **Quote-tweet the video** separately so the video has its own
  impression count
- **Tag relevant accounts** in the first tweet's replies (not the tweet
  itself — that reads as desperate):
  - `@xai` (they've been supportive of the open-source ecosystem)
  - `@sstpress` (OpenCode creator, adjacent space)
  - `@alexalbert__` (former OpenAI Codex, similar UI inspirations)
  - `@mntruell` (Tauri founder, might be interested in the use case)

## Hashtags (use sparingly, max 1-2 per tweet)

`#buildinpublic` on tweet 1
`#tauri` on tweet 2 (Tauri founder follows this tag)

Avoid: #AI #opensource #ChatGPT — too noisy, looks spammy
