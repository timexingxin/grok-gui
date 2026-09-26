# Security

## Reporting a vulnerability

**Do not open a public issue.** Public disclosure of a working exploit
gives attackers a head start before a fix ships.

Instead, use **GitHub's private security reporting**:

1. Go to the repository's **Security** tab → **Advisories** → **New draft
   security advisory**.
2. Describe the issue, the impact, and a minimal reproduction. If you
   have a fix, propose it as a patch in the same form.
3. We will respond within **5 business days** with a triage and a
   coordinated disclosure timeline.

If you cannot use GitHub Advisories, open a **draft** PR that
deliberately omits the exploit payload, reference "security" in the
title, and we will convert it to a private advisory.

## What we will do

| Step | Target |
|---|---|
| Acknowledge receipt | 5 business days |
| Triage and decide on a fix | 15 business days |
| Patch release for a high-severity issue | 30 business days |
| Public advisory with credit | same day as the patch release |

We follow the GitHub Advisories workflow: details stay private until a
fixed version is published.

## Scope

In scope:

- The Tauri 2 shell in this repo.
- The Rust bridge (`apps/desktop/src-tauri/src/`).
- The React frontend and the Zustand store in `packages/core/`.
- Anything that ships in the `.dmg` or `.app.tar.gz` we publish.

Out of scope (file against the upstream instead):

- Bugs or malicious behaviour inside `xai-org/grok-build` itself. We
  wrap that runtime; we do not author it. Upstream report at
  <https://github.com/xai-org/grok-build/security>.
- macOS Gatekeeper / ad-hoc signing on distributed DMGs. That's a
  distribution-time concern, not a code defect. See the README "Known
  limitations" section.

## Known Security Boundaries

### Tauri Asset Protocol Filesystem Scope (`["$HOME/**", "$TEMP/**"]`)

In `apps/desktop/src-tauri/tauri.conf.json`, `assetProtocol.scope.allow` is configured with `["$HOME/**", "$TEMP/**"]`.

- **Design Rationale**: Grok GUI functions as a local coding and writing desktop assistant. Users interactively select, drag, and attach arbitrary workspace files, architectural diagrams, and screenshots located across project folders in their home directory (`$HOME/**`) or temporary directories (`$TEMP/**`). The Tauri asset protocol provides the necessary local media streaming to display thumbnail and image previews in `InputBar` and `ChatArea` via `convertFileSrc`.
- **Security Mitigations & Confinement**:
  1. **Read-Only Media Protocol**: The asset protocol strictly serves read-only file streams; it cannot execute scripts, mutate filesystem contents, or delete files.
  2. **Webview CSP Confinement**: Content Security Policy (`csp`) strictly restricts network connections to local IPC (`connect-src: ipc: http://ipc.localhost`) and prohibits outbound external socket connections from the webview context, preventing local image exfiltration by untrusted prompt text.
  3. **System Directory Isolation**: Sensitive operating system files (`/etc`, `/var`, `/System`, other user profiles) remain outside the permitted scope.

## Known data-handling caveat

The wrapped `grok-build` runtime was open-sourced after a security
researcher documented it silently uploading repositories (including
`.env` files) to xAI servers. Our Rust side only spawns the CLI with
explicit args and adds **no** extra network calls. Before running this
GUI against a real codebase, audit
`crates/runtime/` and `crates/codegen/xai-grok-tools/` in the upstream
repo.

If you want to lock the runtime down further, run it under
`--disable-web-search` and against a clean room directory until you
trust the upstream.
