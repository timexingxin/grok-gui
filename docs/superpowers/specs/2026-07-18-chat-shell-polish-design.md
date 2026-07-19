# Chat shell polish design

## Goal

Make Grok Build's chat shell predictable during session navigation, compact while tools run, full-height in Settings, and explicit about its real Grok Build connection state.

## Scope

### Workbench

- Keep the existing persisted `workbenchVisible` setting.
- Expose the same toggle in the top bar and through `Cmd+Shift+W`.
- Hiding the workbench must always remove only the right workspace panel and allow the chat column to occupy the freed width, independent of the left-sidebar state.

### Conversation order

- Opening an existing conversation must not modify its `updatedAt` value or its placement in history.
- A record moves to the top only after meaningful local content changes: a new user message, a streamed assistant part, a changed title, or changed final usage.
- Pinning remains the first sort key and archive/unread state is preserved.

### Tool and thought presentation

- Render one compact, borderless tool row in event order with disclosure arrow, icon, concise label, status, and elapsed time.
- Show arguments and output only after the user expands that row. Do not render duplicate `action_notice` text or raw JSON in the normal transcript.
- Render thought summaries as borderless disclosure rows. A live thought stays expanded and displays a live duration; a completed thought is collapsed and only exposes its text on demand.
- Preserve the existing chronological message-part model; no hidden reasoning is invented or extracted.

### Settings

- Settings owns the full application content area: its root has full width and height, its navigation remains fixed-width, and its content pane scrolls independently.
- Navigating among Settings sections cannot leave blank application-height space below the page.

### Connection lifecycle

- On launch, detect the local Grok Build CLI before spawning a session.
- Mark the app ready only after a session starts and connection state is set from the actual result.
- Missing CLI routes to onboarding. A failed session start routes to a diagnostic error with retry; it must not claim the agent is connected.
- Existing installed-and-authenticated CLI behavior remains automatic; this app does not install, authenticate, or embed the separate Grok Build CLI.

## Boundaries

- Do not delete conversations or alter the Grok configuration.
- Do not change Ask/Plan/Build sandbox semantics.
- Do not claim an installed package will connect if the target Mac lacks an installed and authenticated Grok Build CLI.

## Validation

- Unit tests cover non-reordering conversation saves, meaningful-update reordering, and ordered tool/thought rendering data.
- Run lint, TypeScript checks, frontend tests, Rust tests, Clippy, production build, and Tauri package build.
- Launch the packaged app from Finder and verify the real connection indicator or the correct onboarding/error branch.
