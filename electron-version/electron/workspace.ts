// Safe, project-scoped filesystem and Git inspection.
//
// Translated from apps/desktop/src-tauri/src/workspace.rs. This is
// deliberately a deep module: callers pass a workspace root and a relative
// path, while path validation, ignored-directory rules, Git parsing, and
// output limits live here. Neither the renderer nor the ACP adapter gets
// unrestricted filesystem access through this module.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const MAX_FILES = 240;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 4;

export interface WorkspaceOverview {
  root: string;
  name: string;
  branch: string | null;
  worktrees: WorkspaceWorktree[];
  changes: WorkspaceChange[];
  files: WorkspaceFile[];
}

export interface WorkspaceWorktree {
  path: string;
  branch: string | null;
  detached: boolean;
  isCurrent: boolean;
  dirty: boolean;
}

export interface WorkspaceChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface WorkspaceFile {
  path: string;
  depth: number;
  isDir: boolean;
}

export interface WorkspaceText {
  path: string;
  content: string;
}

export async function overview(workspace: string): Promise<WorkspaceOverview> {
  const root = await canonicalRoot(workspace);
  const files = await collectFiles(root);
  return {
    name: path.basename(root) || root,
    root,
    branch: await gitStdout(root, ["branch", "--show-current"]),
    worktrees: await gitWorktrees(root),
    changes: await gitChanges(root),
    files,
  };
}

export async function readText(workspace: string, relativePath: string): Promise<WorkspaceText> {
  const root = await canonicalRoot(workspace);
  const target = await resolveExisting(root, relativePath);
  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024} KiB`);
  }
  const content = await fs.readFile(target, "utf-8");
  return { path: relativePath, content };
}

export async function diff(workspace: string, relativePath: string): Promise<WorkspaceText> {
  const root = await canonicalRoot(workspace);
  // Resolve before invoking Git; this rejects traversal and symlink escapes.
  await resolveExisting(root, relativePath);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-ext-diff", "--", relativePath],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return { path: relativePath, content: stdout };
  } catch (error: any) {
    const stderr = (error?.stderr ?? "").toString().trim();
    throw new Error(`git diff failed: ${stderr || error}`);
  }
}

/**
 * Resolve an ACP filesystem path inside `root`, including files which do not
 * yet exist. Shared by the read/write request handlers in grok-runtime.ts.
 */
export async function resolveWorkspacePath(root: string, requested: string): Promise<string> {
  const isAbsolute = path.isAbsolute(requested);
  const candidate = isAbsolute ? requested : path.join(root, requested);

  // Reject `..` traversal outright, mirroring the Rust component walk.
  const segments = requested.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error("path must stay inside the selected workspace");
  }

  if (fsSync.existsSync(candidate)) {
    const canonical = await fs.realpath(candidate);
    if (isInside(root, canonical)) return canonical;
    throw new Error("path resolves outside the selected workspace");
  }

  // New files can have new intermediate directories. Validate the nearest
  // existing ancestor instead of requiring the immediate parent to exist.
  let ancestor = candidate;
  while (!fsSync.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("path has no existing ancestor");
    ancestor = parent;
  }
  const parentReal = await fs.realpath(ancestor);
  if (!isInside(root, parentReal)) {
    throw new Error("path resolves outside the selected workspace");
  }
  return candidate;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function canonicalRoot(workspace: string): Promise<string> {
  let root: string;
  try {
    root = await fs.realpath(workspace);
  } catch (error) {
    throw new Error(`cannot open workspace ${workspace}: ${error}`);
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("workspace is not a directory");
  return root;
}

async function resolveExisting(root: string, relativePath: string): Promise<string> {
  const resolved = await resolveWorkspacePath(root, relativePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("not a regular file");
  return resolved;
}

async function collectFiles(root: string): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = [];
  await collectFilesInner(root, root, 0, out);
  return out;
}

const IGNORED_NAMES = new Set([".git", "node_modules", "target", "dist", ".DS_Store"]);

async function collectFilesInner(root: string, dir: string, depth: number, out: WorkspaceFile[]): Promise<void> {
  if (depth >= MAX_DEPTH || out.length >= MAX_FILES) return;
  // A selected project can contain protected build artefacts or mounted
  // folders. They are not a reason to fail the entire project workbench.
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (IGNORED_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    const relative = path.relative(root, full) || full;
    out.push({ path: relative, depth, isDir });
    if (isDir) {
      await collectFilesInner(root, full, depth + 1, out);
    }
  }
}

async function gitStdout(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function gitChanges(root: string): Promise<WorkspaceChange[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return parseGitChanges(stdout);
  } catch {
    return [];
  }
}

export function parseGitChanges(output: string): WorkspaceChange[] {
  const records = output.split("\0").filter((record) => record.length > 0);
  const changes: WorkspaceChange[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    // Porcelain v1 -z represents rename/copy as `XY new-path\0old-path\0`.
    // The second path has no status prefix and must not become a phantom row.
    if (record.length < 4) continue;
    const indexStatus = record.slice(0, 1);
    const worktreeStatus = record.slice(1, 2);
    const changePath = record.slice(3);
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      i += 1; // skip the old-path record that follows a rename/copy
    }
    changes.push({ indexStatus, worktreeStatus, path: changePath });
  }
  return changes;
}

async function gitWorktrees(root: string): Promise<WorkspaceWorktree[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root }));
  } catch {
    return [];
  }
  const worktrees = parseWorktreeList(stdout, root);
  for (const worktree of worktrees) {
    worktree.dirty = (await gitChanges(worktree.path)).length > 0;
  }
  return worktrees;
}

export function parseWorktreeList(output: string, currentRoot: string): WorkspaceWorktree[] {
  const result: WorkspaceWorktree[] = [];
  for (const block of output.split("\n\n")) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    let detached = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        detached = true;
      }
    }
    if (!wtPath) continue;
    let canonical = wtPath;
    try {
      canonical = fsSync.realpathSync(wtPath);
    } catch {
      // Non-existent worktree path; keep the raw value.
    }
    result.push({
      path: canonical,
      branch,
      detached,
      isCurrent: canonical === currentRoot,
      dirty: false,
    });
  }
  return result;
}
