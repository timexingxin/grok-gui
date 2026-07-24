# 5-minute setup tutorial — script + shot list

> Format: YouTube short-form tutorial. **5 minutes total.**
> Viewer goes from "never heard of Grok GUI" to "I have a working
> install and know the killer features." The promo video (30s) is the
> trailer; this is the full thing.
>
> Target: developers already familiar with the command line.
> Don't waste time on "what is a terminal."
>
> **Recording approach**: screencast with voiceover. Screen record at
> 1440×900 (Retina-friendly). Record in macOS Sequoia; if you don't
> have that exact machine, use any reasonably recent macOS — the
> Tauri Lite build is what we show, and it works on 12+.

---

## Pre-recording checklist

- [ ] **Grok Build CLI installed and authenticated.** Verify with
      `grok agent --version` + `grok auth status` (should show OAuth
      account or API key configured). If not, run the install:
      `curl -fsSL https://x.ai/cli/install.sh | bash`
- [ ] **A demo project ready.** Use
      [`github.com/timexingxin/grok-gui`](https://github.com/timexingxin/grok-gui)
      itself — it's a real Rust+TS project with multiple files, makes
      a believable demo target. Clone to `~/code/grok-gui-demo`.
- [ ] **Test message prepared.** "What does this function do? Explain
      in plain English and point out any obvious bugs." (This is
      generic enough to demo without giving away the answer, and
      almost guaranteed to produce a tool-call card.)
- [ ] **Grok GUI installed via brew** (so the demo isn't about
      download friction): `brew install --cask timexingxin/grok-gui/grok-gui-lite`
- [ ] **Grok GUI NOT running.** Quit before recording. The first
      boot needs the language picker; we want to capture that.
- [ ] **Two browsers / one IDE closed.** Desktop should be visually
      clean — only Grok GUI visible during the demo.
- [ ] **Microphone test.** 5 seconds of silence → look at waveform.
- [ ] **Lighting.** If showing your face on camera, ring light; if
      pure screencast, skip this.

---

## Section 1 — Cold open (0:00 – 0:25)

> **On screen**: `~ $` terminal prompt, blank.
> **Voiceover**: "If you use xAI's Grok Build agent from the command
> line, this video is five minutes that'll save you five hours a week."

> **Why this works**: Name the audience in 5 words. Name the value
> prop in 5 more. Skip everything else.

---

## Section 2 — Install (0:25 – 1:10)

> **On screen**: Terminal, ~1.5x font size.
> **Voiceover**: "First, install Grok Build CLI — Grok GUI is a
> client for it, you need the agent itself too."

```
$ curl -fsSL https://x.ai/cli/install.sh | bash
```

> Wait for it to complete. On screen: install script scrolling.

> **Voiceover**: "Verify it's working:"

```
$ grok agent --version
```

> Shows version output. Then:

> **Voiceover**: "Now install Grok GUI itself. One brew command:"

```
$ brew install --cask timexingxin/grok-gui/grok-gui-lite
```

> Wait for brew to finish. On screen: brew install scrolling.

> **Voiceover**: "That's it. Now launch it."

---

## Section 3 — First launch + language picker (1:10 – 1:45)

> **On screen**: macOS Launchpad → Grok GUI Lite icon → click.

> **Voiceover**: "First launch, you get a language picker. English or
> Simplified Chinese. Pick yours — this gets forwarded to the agent
> so it replies in the same language."

> Click "English".

> **On screen**: Empty Grok GUI Lite UI loads. Sidebar on the left
> (Grok GUI Lite / New task / /Users/you / Plugins / Scheduled tasks /
> Archived tasks / Search conversations), main panel with "What
> should we build?" and 4 quick-action cards (Explain this project /
> Find and fix a bug / Implement a feature / Add tests), input bar
> at the bottom.

> **Voiceover**: "This is the empty state. Four quick actions on
> the right, or you can type whatever you want in the input bar at
> the bottom."

---

## Section 4 — Pick a project (1:45 – 2:15)

> **On screen**: Click the project selector dropdown ("/Users/you").

> **Voiceover**: "First thing: pick a project. The agent runs locally
> against your codebase, so it needs to know which one."

> **On screen**: Dropdown opens, shows recent folders.

> **Voiceover**: "Recent folders show up here. Or click the chevron
> to browse."

> Click "grok-gui-demo" (the pre-cloned repo).

> **On screen**: Status bar at the bottom shows `/Users/.../grokgui-demo`
> and `git: clean` (or similar).

> **Voiceover**: "See the git status at the bottom? That's because
> this is a real git repo. If you pick a non-git folder it'll say
> 'git not detected' — that's expected for sandbox use."

---

## Section 5 — The first task (2:15 – 3:15) — KILLER MOMENT

> **On screen**: Click into the input bar at the bottom.

> Type (slowly, so viewer can read):

```
What does this function do? Explain in plain English and point out any obvious bugs.
```

> **Voiceover**: "I'm going to give it a task. Find a function, explain
> it, flag any obvious bugs."

> Press Enter.

> **On screen** (wait for response): The query gets queued in the
> sidebar as a new session. The main panel shows the user message
> bubble. After 1-3 seconds, the agent starts streaming a response —
> text appears character by character (or token by token).

> **Voiceover**: "Grok's thinking — you can see the 'Thought' expand.
> It's reading the codebase to find the function I asked about."

> **On screen**: A tool-call card appears (Grok is calling
> `read_file` or `grep` or similar). After a moment, the actual answer
> arrives in a markdown bubble with code formatting.

> **Voiceover**: "There it is — the answer, with code formatting,
> inline citations to specific files. And in the top-right corner —
> live token count. Twenty-three thousand tokens, and updating."

> Pan to top-right: "23.5k tokens" indicator.

> **Voiceover**: "Click the cost breakdown if you want to see dollars.
> Click the conversation title to rename it."

---

## Section 6 — Multi-session parallel (3:15 – 3:50) — SECOND KILLER

> **On screen**: Click "+ New task" in the sidebar.

> **Voiceover**: "Open a second task. Watch this — Grok GUI keeps
> both running. You can switch between them and neither one loses
> its stream."

> Type in the second task:

```
List all the test files in this repo and tell me which ones are missing edge case coverage.
```

> Press Enter.

> **On screen**: A second session appears in the sidebar. Click back
> and forth between the two — both are mid-stream, both continue.

> **Voiceover**: "Two concurrent tasks, both streaming. Switch freely.
> The runtime pool keeps both alive in the background — they're
> real subprocesses, not just UI state."

---

## Section 7 — Permission modes (3:50 – 4:20)

> **On screen**: Click the permission mode dropdown in the input
> bar (says "Full access" or similar).

> **Voiceover**: "Three modes. Ask is read-only — Grok can read files
> but not run shell or modify anything. Plan is read-only plus no
> shell. Build is full access. Switching modes actually restarts the
> agent because the sandbox is set at process-start. There's a
> two-second pause when you switch. That's intentional — we don't
> pretend to downgrade permissions on a running agent."

> Click "Ask" → wait 2s → "Build" → wait 2s.

---

## Section 8 — Multi-provider (4:20 – 4:45)

> **On screen**: Click the model dropdown (says "Grok 4.5").

> **Voiceover**: "Not locked to xAI. The model catalogue comes from
> the agent's own handshake — anything the CLI supports shows up here.
> OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Ollama."

> Click around the dropdown — don't actually switch, just show the list.

> **Voiceover**: "If you've authenticated with an OpenAI-compatible
> endpoint, all those models show up too."

---

## Section 9 — Outro + CTA (4:45 – 5:00)

> **On screen**: Stop the screen recording. Black screen with title
> card:

```
Grok GUI
brew install --cask timexingxin/grok-gui/grok-gui-lite
github.com/timexingxin/grok-gui
```

> **Voiceover**: "That's it. Five minutes. One brew install command. Free,
> open source, MIT. Link in the description. Subscribe if you want to
> see more coding-agent tooling videos."

---

## Post-production checklist

- [ ] Trim dead air between sections (target: 5:00 ± 10s)
- [ ] Add chapter markers (YouTube chapters): `0:00 Install` / `1:10
      First launch` / `1:45 Project` / `2:15 First task` / `3:15
      Multi-session` / `3:50 Permission modes` / `4:20 Multi-provider`
      / `4:45 Outro`
- [ ] Add end-screen with 2 related videos (e.g., "Architecture
      deep-dive" link to the blog post at
      `docs/marketing/04-architecture-blog.md`)
- [ ] Thumbnail: Grok GUI Lite window screenshot + "5 min setup"
      text overlay, high contrast
- [ ] Tags: `grok`, `xai`, `coding-agent`, `tauri`, `rust`,
      `desktop-app`, `macos`, `developer-tools`
- [ ] Description: link to GitHub, brew install command, link to
      the architecture blog, timestamps
- [ ] Pin a comment with the brew one-liner for visibility

## Upload & distribution

- **YouTube primary**: upload as "Grok GUI in 5 minutes" — unlisted
  → public after first install verifies
- **Bilibili mirror** (Chinese audience): same video, add Chinese
  subtitles (can be auto-generated then edited)
- **X/Twitter teaser**: clip 15s of the multi-session demo (Section
  6) and post with link to YouTube
- **Reddit r/LocalLLaMA**: post the YouTube link in the thread we
  drafted at `docs/marketing/03-reddit-localllama.md`

## Equipment / software

- **Screen recording**: ScreenFlow (mac), OBS (free), or Loom (easy)
- **Voiceover mic**: Audio-Technica ATR2100x or Blue Yeti; even
  AirPods Pro mic works for a 5-min video
- **Editing**: iMovie (free), Final Cut Pro, or DaVinci Resolve
- **Subtitles**: YouTube auto-captions → edit manually; or use
  whisper.cpp locally for better accuracy

## Time budget for recording + editing

- Recording: 30-45 min (multiple takes, mistakes, retakes)
- Editing: 1-2 hours (cutting, captions, thumbnail)
- Total: ~2 hours for a polished 5-min video

## Fallback: if you can't record

If video production isn't feasible, the next best thing is to convert
this script into a `docs/tutorial/01-5min-setup.md` markdown walkthrough.
The section structure transfers 1:1 — just replace each "On screen:"
block with a code block or screenshot reference. This is strictly worse
for engagement than video but better than nothing.
