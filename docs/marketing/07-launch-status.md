# Launch status — published URLs

Tracking where the launch content has been published. Updated by Qoder.

## P0.2 — Architecture blog (04-architecture-blog.md)

Published to all three platforms (same content, platform-native formatting):

| Platform | URL |
|---|---|
| dev.to | https://dev.to/timexingxin/building-a-desktop-client-for-an-ai-coding-agent-147n |
| Medium | https://medium.com/@timexingxin/building-a-desktop-client-for-an-ai-coding-agent-a428c8d8997e |
| Hashnode | https://timexingxin.hashnode.dev/building-a-desktop-client-for-an-ai-coding-agent |

Notes:
- dev.to: markdown + 4 tags (rust/tauri/ai/opensource) + cover image (1000:420 crop of the app screenshot).
- Medium: rich-formatted paste, 4 topics (Rust/AI/Programming/Technology).
- Hashnode: published under the `King Wan` publication (`timexingxin.hashnode.dev`), Markdown mode, SEO title/description set. Tags were not added (Hashnode's tag autocomplete only accepts predefined tags and could not be driven headlessly). The republish canonical was set to the dev.to URL but Hashnode still serves a self-referential canonical (platform behavior / CDN cache) — revisit if duplicate-content SEO matters.

## P0.1 — Tutorial video (05-tutorial-video-script.md)

- File: `outputs/grok-gui-tutorial/grok-gui-tutorial.mp4` (in the Qoder workspace, not this repo)
- Format: 1920x1080 H.264, ~55 s, 2.5 MB
- Structure: title card -> Step 1 install CLI (`grok --version`) -> Step 2 install app (`ls /Applications | grep -i grok` + empty state) -> Step 3 parallel tasks (two live agent responses + session switch) -> outro card with repo link.

Production note: the cua-driver screen recorder returned synthetic/placeholder footage (frames showed unrelated machines, future dates, and a mock "Obsidian GUI Lite" UI rather than the real screen), so a clean live screencast was not possible in this environment. The video was assembled from verified real `screencapture` screenshots of each step, with generated title cards, lower-third captions, and fade transitions. If a true live screencast is needed, record on a machine where the screen-capture path returns real frames.
