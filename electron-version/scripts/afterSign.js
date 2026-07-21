// electron-version/scripts/afterSign.js
//
// electron-builder afterSign hook. Runs *after* electron-builder signs the
// .app (default = nothing for ad-hoc), *before* the DMG is packaged.
//
// Why this exists:
//   The prebuilt `electron` npm package ships with a placeholder linker-signed
//   signature that says "no sealed resources". electron-builder renames the
//   executable (Electron → Grok GUI) and rewrites Info.plist without
//   re-signing, so the CodeDirectory on disk still claims there are no
//   resources — but there *are* (Info.plist, .lproj/, app.asar, etc).
//   On macOS 15 (Sequoia) this fails Gatekeeper with:
//
//     code has no resources but signature indicates they must be present
//
//   Fix: re-sign the .app bundle with an ad-hoc identity (`-`) so the
//   CodeDirectory is regenerated with the actual contents sealed. After
//   this, `codesign --verify --deep --strict` passes and Gatekeeper only
//   sees the expected `rejected` for non-notarized ad-hoc (which is what
//   `First-Run-Open-Me.command` already handles).
//
// See: /tmp/grok-gui-debug-report.md (Bl B1, B2)

const { execSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterSign(context) {
  // electron-builder 26.x: both context.appOutDir and context.packager.appOutDir
  // are set. Use whichever is present for forward/backward compat.
  const appOutDir =
    context.appOutDir ||
    (context.packager && context.packager.appOutDir);

  const productFilename =
    (context.packager &&
      context.packager.appInfo &&
      context.packager.appInfo.productFilename) ||
    (context.config && context.config.productName) ||
    "Grok GUI";

  if (!appOutDir) {
    console.warn(
      "[afterSign] No appOutDir on context; skipping re-sign. " +
        "If the .app fails Gatekeeper, this hook is the cause."
    );
    return;
  }

  const appPath = path.join(appOutDir, `${productFilename}.app`);

  console.log(`[afterSign] Re-signing ${appPath} with ad-hoc identity...`);

  // Force + deep + ad-hoc (-). This regenerates the CodeDirectory to seal
  // every nested framework/helper/asar under the actual contents.
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });

  // Verify the signature is now valid. If this fails, fail the build.
  execSync(`codesign --verify --deep --strict --verbose=2 "${appPath}"`, {
    stdio: "inherit",
  });

  console.log(`[afterSign] OK: ${appPath} re-signed and verified.`);
};
