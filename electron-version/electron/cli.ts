// Grok Build CLI discovery + process launch helpers.
// Translated from the free functions in apps/desktop/src-tauri/src/lib.rs
// (grok_cli_candidates_for / resolve_grok_bin_for / expand_tilde / etc).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const OFFICIAL_INSTALLER_SCRIPT = "curl -fsSL https://x.ai/cli/install.sh | bash";

/** Cross-platform home directory: HOME on Unix, USERPROFILE on Windows. */
export function homeDir(): string | undefined {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/**
 * Build the complete list of CLI locations independently of a terminal
 * shell. Finder/Explorer-launched apps do not inherit the user's shell
 * PATH, so every runtime call must use this same resolver instead of a bare
 * `grok` lookup.
 */
export function grokCliCandidatesFor(custom: string | undefined, home: string | undefined, pathEnv: string | undefined): string[] {
  const candidates: string[] = [];
  if (custom && custom.trim().length > 0) {
    candidates.push(custom);
  }
  if (home) {
    candidates.push(path.join(home, ".grok/bin/grok"));
  }
  if (pathEnv) {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, "grok"));
    }
  }
  return candidates;
}

export function resolveGrokBinFor(custom: string | undefined, home: string | undefined, pathEnv: string | undefined): string {
  for (const candidate of grokCliCandidatesFor(custom, home, pathEnv)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not found, keep looking
    }
  }
  throw new Error("找不到 Grok Build CLI。请安装 Grok Build，或设置 GROK_BIN。");
}

export function resolveGrokBin(): string {
  return resolveGrokBinFor(process.env.GROK_BIN, homeDir(), process.env.PATH);
}

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandTilde(input: string): string {
  const home = process.env.HOME ?? homeDir() ?? "/";
  if (input === "~") return home;
  if (input.startsWith("~/")) {
    return `${home.replace(/\/+$/, "")}/${input.slice(2)}`;
  }
  return input;
}

export function validateApiKey(key: string): string {
  const normalized = key.trim();
  if (normalized.length === 0 || /[\n\r]/.test(normalized)) {
    throw new Error("请输入有效的单行 xAI API Key。");
  }
  return normalized;
}
