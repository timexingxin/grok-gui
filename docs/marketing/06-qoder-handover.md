# Grok GUI — Qoder handover prompt

> **What this is**: A self-contained brief for taking over the
> [grok-gui](https://github.com/timexingxin/grok-gui) project. The
> product is a native macOS/Windows desktop GUI for xAI's open-source
> [grok-build](https://github.com/xai-org/grok-build) coding agent.
> Version v0.1.0 shipped 2026-07-21. We're in the launch-prep phase —
> the build pipeline is green, the install paths work, the launch
> copy is drafted. What we need now is content production (1 video,
> 1 blog post) and then the launch sequence itself (Show HN, Twitter,
> Reddit).
>
> **How to use this document**: Read once top-to-bottom before doing
> anything. Then work the prioritized task list in order. Every claim
> below is verifiable from the linked files; if something looks wrong,
> the linked file is the source of truth.

---

## 1. Current state of the repo

**Repo**: `github.com/timexingxin/grok-gui` (MIT)

**Branch state** (`git log --oneline -10`):

```
52946a4 docs(marketing): launch copy drafts (Show HN, Twitter thread, Reddit)
d55ad0c docs: README rewrite with demo GIF + cross-platform install + comparison table
47d3bda fix(electron): track electron-version/build/ icons so Windows CI has icon.ico
14e28f2 ci: make Windows builds work (afterSign platform-gate + Tauri --bundles nsis)
c709c8a ci: add Windows Tauri build alongside Electron Windows build
0f17d76 fix(tauri): allow clippy::too_many_arguments on start_session
f89fab0 fix(electron): sync locale plumbing to nested packages/core copy
081eae5 fix(electron): forward UI locale to grok agent runtime via LANG/LC_ALL
0b26978 fix(agent): forward UI locale to grok agent runtime via LANG/LC_ALL
```

**CI**: 8 jobs, all green on `main`. Latest run 29963798428.
- `rust-lint` × 2 (ubuntu + macos), `frontend` × 2 (node 20 + 22), `electron-build-macos`, `electron-build-windows`, `tauri-build-macos`, `tauri-build-windows`

**Release**: `v0.1.0` published, 5 attachments, all 200:
- `Grok-GUI-Lite-0.1.0-Apple-Silicon.dmg`, `...-Intel.dmg` (Tauri, ~8 MB each)
- `Grok-GUI-0.1.0-Electron-Apple-Silicon.dmg`, `...-Intel.dmg` (Electron, ~150 MB each)
- `First-Run-Open-Me.command` (quarantine-clear helper)
- **Linux: not packaged**. Works in dev but no CI/release pipeline for it.

**Local installs** (verified, both work):
- `/Applications/Grok GUI Lite.app` (9.5 MB)
- `/Applications/Grok GUI.app` (432 MB)
- Both codesign valid.

---

## 2. Project structure (what lives where)

```
grok-gui/
├── apps/desktop/                      Tauri 2 app (the main one)
│   ├── src/                           React frontend (Sidebar, ChatArea, InputBar, ...)
│   ├── src-tauri/                     Rust side (grok_runtime.rs, tauri commands, lib.rs)
│   ├── scripts/                       (legacy — moved to electron-version/scripts)
│   ├── tauri.conf.json                Bundle config, signing identity '-', updater
│   └── package.json                   "tauri:dev", "tauri:build" scripts
│
├── electron-version/                  Electron alternative runtime
│   ├── electron/
│   │   ├── main.ts                    Electron entry
│   │   ├── grok-runtime.ts            Node.js equivalent of Rust grok_runtime.rs
│   │   ├── commands.ts                IPC handlers (startSession etc.)
│   │   └── preload.ts
│   ├── src/                           Electron-specific React entry (uses same packages/)
│   ├── packages/core/src/stores/      ⚠️ NESTED COPY of packages/core — must stay in sync
│   └── scripts/afterSign.js           macOS-only codesign re-sign hook
│
├── packages/                          Shared (used by both Tauri + Electron)
│   ├── ui/                            Shared React components
│   ├── core/                          Types + Zustand store + utils
│   ├── provider/                      Provider catalog
│   └── acp-bridge/                    JSON-RPC 2.0 client helpers
│
├── docs/
│   ├── demo-frames/                   Hero GIF + 4 PNG frames for README (committed)
│   └── marketing/                     Launch prep materials (committed)
│       ├── 01-show-hn.md              Show HN post draft (title + body + notes)
│       ├── 02-twitter-thread.md        8-tweet thread with engagement plan
│       ├── 03-reddit-localllama.md     r/LocalLLaMA post draft
│       ├── 04-architecture-blog.md     Architecture deep-dive blog post (publishable)
│       ├── 05-tutorial-video-script.md  5-min setup video script with shot list
│       └── 06-qoder-handover.md        This file
│
├── packaging/homebrew/Casks/         brew cask source files
│
├── .github/workflows/ci.yml           8-job CI workflow
└── AGENTS.md                          Repo-local AI agent conventions
```

---

## 3. Critical decisions (the ones you MUST not undo)

These are recent decisions made for specific reasons. If Qoder proposes
changing any of these, check the linked commit message first.

### 3.1 Locale fix (LANG/LC_ALL propagation)

The `startSession` call now takes a `language?: UiLanguage` parameter
that gets passed through Tauri command → SessionOptions → `Command::spawn`
env vars (`LANG`, `LC_ALL`). Commits:
`0b26978` (Tauri), `081eae5` (Electron), `f89fab0` (nested copy sync),
`0f17d76` (`#[allow(clippy::too_many_arguments)]`).

**Why this matters**: without it, the agent responds in the host
locale, not the UI locale. Workspace-level `AGENTS.md` still overrides —
that's intentional (more specific rule wins).

**The mapping** in `grok_runtime.rs::locale_env_value`:
- `"en-US"` / `"en"` → `"en_US.UTF-8"`
- `"zh-CN"` / `"zh"` → `"zh_CN.UTF-8"`
- generic `xx-YY` → `xx_YY.UTF-8` (so future locales work without code change)

### 3.2 Two runtimes: Tauri + Electron

The project ships TWO runtime targets because users asked for both:
- **Tauri (~8 MB)**: preferred for size + native feel. Default.
- **Electron (~150 MB)**: more portable, easier to debug for web devs.

They share the same React frontend (`packages/`) and the same store API.
The two runtimes are parallel implementations (`apps/desktop/src-tauri/src/grok_runtime.rs`
vs `electron-version/electron/grok-runtime.ts`).

**Don't** merge them or pick one over the other. They serve different
audiences. The CI builds both.

### 3.3 Nested `electron-version/packages/core/` duplication

`electron-version` vendors a copy of `packages/core/src/stores/app-store.ts`
at `electron-version/packages/core/src/stores/app-store.ts` so it can
build independently of the Tauri app. **Every time you change the
store, you must sync both copies.** Qoder: be extra careful here.

A pre-commit hook to auto-detect drift was discussed but not implemented.
The user's last decision: "现在不加" (skip for now). If you propose to
add it, get user approval first.

### 3.4 macOS ad-hoc signing

Both runtimes are ad-hoc signed (`signingIdentity: "-"`,
`codesign --force --deep --sign -`). This means:
- First install triggers Gatekeeper "unidentified developer" prompt
- `First-Run-Open-Me.command` (committed to repo) clears quarantine
- Apple Developer ID + notarization is NOT in place

The user explicitly decided to ship ad-hoc rather than pay $99/year for
a Developer ID. If you propose to add Developer ID signing, get user
approval first.

### 3.5 Windows build: NSIS only (no MSI)

Tauri Windows CI passes `--bundles nsis` to `tauri build`. The MSI
target uses WiX 3.14's `light.exe` which crashes on github-actions
windows-latest with a known .NET dependency issue. Don't try to "fix"
this by switching to MSI; the workaround stays.

### 3.6 Show HN / Twitter / Reddit drafts are PR-ready

The drafts in `docs/marketing/0{1,2,3}-*.md` are not outlines — they're
post-ready copy. The Show HN body has the title (72 chars, within HN's
80-char limit) and a full post. The Twitter thread is 8 numbered
tweets ready to paste. **Do not "polish" them** without user approval —
they were written deliberately.

---

## 4. Immediate priorities (numbered)

Each task references the relevant deliverable + how to verify done.

### P0 — Block on launch

**P0.1 · Record the 5-min tutorial video per script**
- Script: `docs/marketing/05-tutorial-video-script.md`
- Output target: `/docs/marketing/05-tutorial-video.mp4` (or commit as
  `docs/marketing/05-tutorial-video.md` with link to YouTube once uploaded)
- Verify done: video file present + uploaded to YouTube + link committed
- Owner effort: ~2 hours (recording 45 min + editing 1.5h)
- **Blocked on**: user has recording equipment / willing to be on camera

**P0.2 · Publish architecture blog post**
- Post: `docs/marketing/04-architecture-blog.md`
- Targets: dev.to, Medium, Hashnode, and as a `docs/blog/01-architecture.md`
  in the repo for the GitHub Pages site
- Verify done: 3+ URLs live + links added to README
- Owner effort: ~30 min (copy-paste + format per platform)
- **Not blocked**

### P1 — Launch sequence (post P0)

**P1.1 · Show HN post**
- Draft: `docs/marketing/01-show-hn.md`
- Post time: **Monday 9:00 AM PT** (HN peak traffic)
- Steps:
  1. Read `01-show-hn.md` "Notes for the author" appendix
  2. Submit via news.ycombinator.com/submit (select "Show HN")
  3. **Be ready to respond in the first 60 minutes** — that's where
     ranking gets cemented
  4. **Do not edit the post** for at least 2 hours; HN penalizes edits
- Verify done: HN thread URL captured, post is live

**P1.2 · Twitter thread**
- Draft: `docs/marketing/02-twitter-thread.md`
- Post time: same Monday morning as HN (or up to 4 hours before, to
  prime the thread for the HN traffic)
- Steps:
  1. Read `02-twitter-thread.md` end-to-end
  2. Open Twitter/X composer, paste tweet 1 as a regular tweet, then
     reply chain for tweets 2-8
  3. Quote-tweet the 30s promo video separately
  4. Tag relevant accounts (per `02-twitter-thread.md` Engagement Plan)
- Verify done: thread URL captured, all 8 tweets live

**P1.3 · Reddit r/LocalLLaMA post**
- Draft: `docs/marketing/03-reddit-localllama.md`
- Post time: Tuesday morning (after HN dies down, give it a day)
- Steps:
  1. Read `03-reddit-locallama.md`
  2. Go to reddit.com/r/LocalLLaMA/submit
  3. Title: "I built a native desktop GUI for the Grok Build coding agent — Tauri 2, ACP/JSON-RPC, multi-provider, MIT"
  4. Body: full markdown from draft
- Verify done: post URL captured, upvote ratio monitored for 24h

### P2 — Sustained (week 2-4)

**P2.1 · Personal Homebrew tap**
The user previously decided to skip this for now. **Re-evaluate after
launch** when GitHub stars > 200. Until then, users install via
downloading DMGs from release page or via `brew install --cask
timexingxin/grok-gui/grok-gui-lite` (which works because we defined
the tap inline).

**P2.2 · Newsletter pitches**
Pitch to TLDR AI, Ben's Bites, The Rundown AI. Use the architecture
blog post as the link target.

**P2.3 · YouTube upload**
If the 5-min video gets good reception, pitch it to AI/ML YouTubers
(Matt Wolfe, Theoretically Media, Two Minute Papers) with a short note.

### P3 — Polish (post-launch, lower priority)

**P3.1 · Linux release pipeline**
Currently works in dev (`cargo tauri build` on Linux) but not in CI
nor packaged as deb/appimage. Add when there's user demand.

**P3.2 · Apple Developer ID signing**
$99/year + ~1 day of integration (notarization, entitlements).
Skip unless launch metrics show distribution friction is killing adoption.

**P3.3 · Lazy-load Monaco in Electron**
The 23-second splash delay is from `electron-vite` pulling in
`monaco-editor` (~30 MB) even when the user isn't on a code session.
Deferred to v0.2.0.

---

## 5. Operational notes (how the build / CI / release work)

### 5.1 Build matrix

| Job | Runner | Output | Upload |
|---|---|---|---|
| `rust-lint` × 2 | ubuntu-latest, macos-latest | `cargo clippy --all-targets -- -D warnings` + `cargo test` | (none — gates downstream) |
| `frontend` × 2 | ubuntu-latest (Node 20 + 22) | `npm run lint / typecheck / test / build` + uploads `apps/desktop/dist` | artifact: `desktop-dist-node-{N}` |
| `electron-build-macos` | macos-latest | `npm run dist -- --publish never` (in `electron-version/`) | artifact: `grok-gui-electron-macos` |
| `electron-build-windows` | windows-latest | same with `--win` flag | artifact: `grok-gui-electron-windows` |
| `tauri-build-macos` | macos-latest | `npx tauri build` + `codesign --force --deep --sign -` | artifact: `grok-gui-macos` |
| `tauri-build-windows` | windows-latest | `npm run tauri build -- --bundles nsis` | artifact: `grok-gui-windows` |

All jobs gate on `frontend`. macOS jobs additionally gate on
`rust-lint`.

### 5.2 The afterSign hook (Electron)

`electron-version/scripts/afterSign.js` runs after electron-builder
signs the bundle, before packaging. On macOS it re-signs the .app
with ad-hoc identity (`codesign --force --deep --sign -`). On Windows
and Linux it returns early (`if (process.platform !== "darwin") return;`)
because the codesign binary doesn't exist on those platforms.

This is wired via `electron-builder.yml`'s top-level `afterSign` key.

### 5.3 Release process

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`
2. Build with `TAURI_SIGNING_PRIVATE_KEY` env var (currently unset; only
   needed once we have a real Developer ID)
3. Locally test the DMGs/NSIS
4. `gh release create v0.x.y` with the 5 artifacts (DMGs + NSIS installers + the command helper)
5. Upload brew cask files to `timexingxin/homebrew-grok-gui` tap repo
6. Update release notes (the `gh release edit --notes-file` flow)

---

## 6. Reference: all deliverable files (links)

| Path | What |
|---|---|
| `README.md` | Hero + demo GIF + install table + comparison table |
| `docs/demo-frames/demo.gif` | 8s hero GIF (palette-quantized, 65 KB) |
| `docs/demo-frames/t{1,6,14,26}s.png` | Key frames for static use |
| `docs/marketing/01-show-hn.md` | Show HN post (title + body + author notes) |
| `docs/marketing/02-twitter-thread.md` | 8-tweet thread + pre-thread + engagement plan |
| `docs/marketing/03-reddit-localllama.md` | r/LocalLLaMA post |
| `docs/marketing/04-architecture-blog.md` | Architecture blog post (publishable) |
| `docs/marketing/05-tutorial-video-script.md` | 5-min video script + shot list |
| `docs/marketing/06-qoder-handover.md` | This file |

Plus the locally-available Windows binaries (NOT in repo):
- `/Users/timexingxin/.minimax-agent/projects/grok-gui/outputs/windows/grok-gui-electron/Grok GUI Setup 0.1.0.exe`
- `/Users/timexingxin/.minimax-agent/projects/grok-gui/outputs/windows/grok-gui-tauri/Grok GUI Lite_0.1.0_x64-setup.exe`

Plus the promo video (NOT in repo, large):
- `/Users/timexingxin/Documents/Codex/2026-07-18/opencode-bug-5/outputs/grok-gui-promo/grok-gui-promo-X-subtitled.mp4`

---

## 7. Guardrails (what Qoder should NOT do without user approval)

1. **Don't merge Tauri + Electron runtimes** — they serve different
   audiences (§3.2)
2. **Don't sync the nested packages/core/ without the rest of the
   fix** — when changing the store, always update all four locations:
   root, electron-version nested, plus any tsc / tests that touch the
   type (§3.3)
3. **Don't change macOS signing** from ad-hoc without user approval (§3.4)
4. **Don't add Windows MSI target** to Tauri build — known broken (§3.5)
5. **Don't "polish" the marketing drafts** in `docs/marketing/0{1,2,3}-*.md`
   — they were written deliberately, changes need user review (§3.6)
6. **Don't add Linux release pipeline** without user approval (§4 P3.1)
7. **Don't buy / configure an Apple Developer ID** without explicit user
   approval (§4 P3.2)
8. **Don't enable auto-publish in CI** — the build is set to
   `--publish never`. The release is a manual `gh release upload` step.
9. **Don't remove `AGENTS.md`** — it's read by every AI agent that opens
   this repo (including Qoder). If you disagree with a rule in it,
   propose changes to the user.
10. **Don't bump versions / cut releases** without explicit user approval.
    The release process is a multi-step manual flow (§5.3).

---

## 8. Success metrics (track post-launch)

| Metric | Day-7 target | Month-1 target |
|---|---|---|
| GitHub stars | 200 | 1,000 |
| Show HN ranking | Top 50 | n/a |
| Twitter impressions | 30K | 100K |
| Reddit r/LocalLLaMA upvotes | 100 | 300 |
| brew install analytics | 50 | 300 |
| Issues opened (real bugs) | 5 | 20 |
| PRs received | 1 | 5 |

If month-1 falls short of 1,000 stars, revisit positioning. The product
is real, but the "Grok Build" upstream isn't yet famous enough for
generic curiosity to find this — promotion effort matters.

---

## 9. Open questions / decisions needed from user

If Qoder hits any of these, stop and ask the user:

1. **Should we add a Linux release pipeline?** Currently dev works
   but no CI for it. Cost: ~half a day.
2. **Should we buy an Apple Developer ID ($99/yr)?** Removes the
   Gatekeeper friction but costs money + 1 day integration.
3. **Should we add a personal Homebrew tap repo?** Better install UX
   but another repo to maintain.
4. **When to ship v0.2.0?** Feature list TBD. Likely includes:
   - Lazy-load Monaco (Electron 23s splash fix)
   - Better permission UX
   - macOS Apple Silicon code-signed builds
5. **Discord/community presence?** If yes, which server (xAI official,
   OpenCode, Tauri, AI tooling)? Or self-host?

Don't make any of these decisions unilaterally — list them, get user
sign-off, then act.

---

## 10. TL;DR for the rushed reader

1. **Build is done, install paths work, all 8 CI jobs green.** Don't
   redo the build pipeline; verify it's still green and move on.
2. **Two deliverables left to create**: a 5-min YouTube video
   (P0.1, blocked on user recording) and a published architecture
   blog (P0.2, ready to copy-paste to dev.to/Medium/Hashnode).
3. **Three channels to post to**: Show HN (Monday), Twitter
   (same Monday), Reddit r/LocalLLaMA (Tuesday).
4. **All launch copy is already drafted** in `docs/marketing/0{1,2,3}-*.md`.
   Don't rewrite — paste.
5. **Read sections 3 (critical decisions) and 7 (guardrails) before
   doing anything.** Most of the "what could go wrong" is covered
   there.

Welcome aboard. Ship it.
