// Credential storage: translated from the `keyring` crate usage in
// apps/desktop/src-tauri/src/lib.rs.
//
// The Rust side used the OS keychain directly via `keyring::Entry::new(service,
// account)`. Electron's idiomatic equivalent is `safeStorage`, which also
// wraps the OS keychain (Keychain on macOS, libsecret on Linux, DPAPI on
// Windows) but only offers symmetric encrypt/decrypt of a buffer — it does
// not provide named entries. We reproduce the "service + account" addressing
// by encrypting the secret with safeStorage and persisting the ciphertext in
// a single small file under Electron's per-app userData directory, named
// after the same service/account identifiers used by the Tauri build so the
// two implementations stay conceptually interchangeable.
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { homeDir } from "./cli";

export const KEYCHAIN_SERVICE = "com.grok-gui.desktop";
export const KEYCHAIN_ACCOUNT = "xai-api-key";

function credentialFilePath(): string {
  return path.join(app.getPath("userData"), `${KEYCHAIN_SERVICE}.${KEYCHAIN_ACCOUNT}.enc`);
}

/** Persist the xAI API key, encrypted at rest via the OS keychain-backed safeStorage. */
export function saveApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("无法访问凭据存储：当前系统不支持安全存储。");
  }
  const encrypted = safeStorage.encryptString(key);
  fs.mkdirSync(path.dirname(credentialFilePath()), { recursive: true });
  fs.writeFileSync(credentialFilePath(), encrypted);
}

/** The key never crosses this Node boundary except as a child-process env var. */
export function getApiKey(): string | null {
  const file = credentialFilePath();
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("无法读取凭据存储中的 API Key：当前系统不支持安全存储。");
  }
  try {
    const encrypted = fs.readFileSync(file);
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    throw new Error(`无法读取凭据存储中的 API Key：${error}`);
  }
}

export interface AuthMode {
  /** "oauth" when ~/.grok/auth.json exists (account login); "apiKey" when a
   * key is saved via safeStorage; "none" when nothing is configured. */
  kind: "oauth" | "apiKey" | "none";
  loggedIn: boolean;
  hasApiKey: boolean;
}

/**
 * Report which authentication path Grok Build will use next:
 * 1. account login via `~/.grok/auth.json` (preferred, costs nothing extra)
 * 2. safeStorage-backed `XAI_API_KEY` (paid metered access)
 * 3. CLI auto-detects whichever is present; if both, the API key wins.
 */
export function getAuthMode(): AuthMode {
  const home = homeDir();
  const authJsonPath = home ? path.join(home, ".grok", "auth.json") : undefined;
  const loggedIn = !!authJsonPath && fs.existsSync(authJsonPath) && fs.statSync(authJsonPath).isFile();
  let hasApiKey = false;
  try {
    hasApiKey = !!getApiKey();
  } catch {
    hasApiKey = false;
  }
  const kind: AuthMode["kind"] = hasApiKey ? "apiKey" : loggedIn ? "oauth" : "none";
  return { kind, loggedIn, hasApiKey };
}
