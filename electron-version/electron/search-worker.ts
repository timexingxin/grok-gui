// Content search for the workspace panel, translated from
// apps/desktop/src-tauri/src/workspace.rs (`search_content`).
//
// Unlike Tauri (where an async command already runs off the webview's IPC
// thread), Electron's main process is single-threaded: a synchronous or
// long-running scan in an `ipcMain.handle` stalls every window's IPC while
// it runs. This module is dual-purpose so the same file can be both the
// worker_threads entry point and a plain, unit-testable function:
//
//   - `runSearch` is the actual search logic. It has no worker_threads
//     dependency and can be called directly from tests or from the main
//     thread if ever needed.
//   - The `isMainThread` guard at the bottom is the entry point Node runs
//     when this file is spawned via `new Worker(...)`: it reads the request
//     from `workerData` and posts the result back through `parentPort`.

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const execFileAsync = promisify(execFile);

const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_CANDIDATES = 20_000;
const MAX_SEARCH_RESULTS = 500;

// Kept in sync with `SKIP_ENTRY_NAMES` in apps/desktop/src-tauri/src/workspace.rs.
const SKIP_ENTRY_NAMES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "out",
  "release",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  ".DS_Store",
]);

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchRequest {
  workspace: string;
  query: string;
  maxResults: number;
}

export async function runSearch(request: SearchRequest): Promise<SearchMatch[]> {
  const root = await fs.promises.realpath(request.workspace);
  const query = request.query.trim();
  if (!query) return [];
  const maxResults = Math.min(Math.max(Math.trunc(request.maxResults) || 1, 1), MAX_SEARCH_RESULTS);
  const needle = query.toLowerCase();

  const matches: SearchMatch[] = [];
  for (const relative of await searchCandidates(root)) {
    if (matches.length >= maxResults) break;
    if (shouldSkipPath(relative)) continue;

    const full = path.join(root, relative);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;
    if (await isProbablyBinary(full)) continue;

    const matchedInFile = await searchFile(full, relative, needle, maxResults - matches.length);
    matches.push(...matchedInFile);
  }
  return matches;
}

async function searchFile(full: string, relative: string, needle: string, limit: number): Promise<SearchMatch[]> {
  const found: SearchMatch[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(full, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line.toLowerCase().includes(needle)) {
      found.push({ path: relative, line: lineNumber, text: line.length > 300 ? line.slice(0, 300) : line });
      if (found.length >= limit) {
        rl.close();
        break;
      }
    }
  }
  return found;
}

function shouldSkipPath(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => SKIP_ENTRY_NAMES.has(segment));
}

async function isProbablyBinary(file: string): Promise<boolean> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Relative file paths to search, respecting `.gitignore` via `git ls-files`
 * when the workspace is a Git repository; a bounded manual walk (still
 * skipping `SKIP_ENTRY_NAMES`) covers non-Git directories. */
async function searchCandidates(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((entry) => entry.length > 0);
  } catch {
    // Not a Git repository, or git is unavailable: fall back to a bounded walk.
    const out: string[] = [];
    await walkCandidates(root, root, out);
    return out;
  }
}

async function walkCandidates(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_SEARCH_CANDIDATES) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_SEARCH_CANDIDATES) break;
    if (SKIP_ENTRY_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCandidates(root, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full));
    }
  }
}

interface WorkerResponse {
  ok: boolean;
  matches?: SearchMatch[];
  error?: string;
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  runSearch(workerData as SearchRequest)
    .then((matches) => port.postMessage({ ok: true, matches } satisfies WorkerResponse))
    .catch((error: unknown) =>
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse),
    );
}
