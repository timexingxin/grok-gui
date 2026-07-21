#!/bin/bash
# First-Run-Open-Me.command
#
# First-launch helper for Grok GUI. Right-click this file in Finder ->
# Open -> click "Open" in the dialog. NO Terminal needed.
#
# What it does:
#   1. Clears macOS quarantine attribute from /Applications/Grok GUI*.app
#      so Gatekeeper stops flagging them.
#   2. Runs codesign --verify on the .app(s) and prints a clear warning if
#      the signature is structurally broken (the Electron placeholder-
#      signature bug; see .github/workflows/ci.yml for the fix on CI side).
#   3. Opens the first app found.
#
# Only needed once after install. After this, double-click the .app normally.
#
# Source of truth: https://github.com/timexingxin/grok-gui
# Debug report:    /tmp/grok-gui-debug-report.md (paths a/c/d)

set -e

LITE_APP="/Applications/Grok GUI Lite.app"
GUI_APP="/Applications/Grok GUI.app"

clear_quarantine() {
  local app="$1"
  echo "==> Clearing quarantine on $app..."
  xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
}

verify_signature() {
  local app="$1"
  echo "==> Verifying signature on $(basename "$app")..."
  if codesign --verify --deep --strict --verbose=2 "$app" 2>&1; then
    echo "    OK: signature is valid."
  else
    cat <<'WARN'

    !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    !  WARNING: signature verification FAILED.
    !
    !  This is the known Electron placeholder-signature bug:
    !    "code has no resources but signature indicates they must be present"
    !
    !  Two workarounds:
    !    (1) Try to launch anyway (macOS App Translocation sometimes lets
    !        it run despite the verify failure).
    !    (2) If it won't launch, use the Lite (Tauri) build instead — it
    !        is signed correctly.
    !
    !  Permanent fix is in flight on the CI side; see:
    !    https://github.com/timexingxin/grok-gui/blob/main/.github/workflows/ci.yml
    !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

WARN
  fi
  echo ""
}

# Process whichever app(s) are present.
for app in "$LITE_APP" "$GUI_APP"; do
  if [ -d "$app" ]; then
    clear_quarantine "$app"
    verify_signature "$app"
  fi
done

# Launch whichever we found.
if [ -d "$LITE_APP" ]; then
  echo "==> Opening $LITE_APP"
  open "$LITE_APP"
elif [ -d "$GUI_APP" ]; then
  echo "==> Opening $GUI_APP"
  open "$GUI_APP"
else
  echo "Grok GUI not found in /Applications."
  echo ""
  echo "Drag the .app out of the downloaded .dmg into /Applications, then"
  echo "re-run this script."
  read -n 1 -s -r -p "Press any key to close..."
fi
