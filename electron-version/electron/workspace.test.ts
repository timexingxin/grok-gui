// Translated from `mod tests` in apps/desktop/src-tauri/src/workspace.rs.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { overview, parseGitChanges, parseWorktreeList, resolveWorkspacePath } from "./workspace";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("resolveWorkspacePath", () => {
  it("rejects parent traversal before touching disk", async () => {
    await expect(resolveWorkspacePath("/tmp", "../private.txt")).rejects.toThrow();
    await expect(resolveWorkspacePath("/tmp", "/etc/hosts")).rejects.toThrow();
  });
});

describe("parseWorktreeList", () => {
  it("parses porcelain worktrees and marks the selected path", () => {
    const records = parseWorktreeList(
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-fix\nHEAD def\ndetached\n\n",
      "/repo",
    );
    expect(records).toHaveLength(2);
    expect(records[0].path).toBe("/repo");
    expect(records[0].branch).toBe("main");
    expect(records[0].isCurrent).toBe(true);
    expect(records[0].detached).toBe(false);
    expect(records[1].detached).toBe(true);
  });
});

describe("parseGitChanges", () => {
  it("parses renames without creating a phantom change", () => {
    const records = parseGitChanges("R  new-name.txt\0old-name.txt\0 M kept.txt\0");
    expect(records).toHaveLength(2);
    expect(records[0].indexStatus).toBe("R");
    expect(records[0].worktreeStatus).toBe(" ");
    expect(records[0].path).toBe("new-name.txt");
    expect(records[1].path).toBe("kept.txt");
  });
});

describe("overview", () => {
  it("discovers real git worktrees and dirty state", async () => {
    const root = path.join(os.tmpdir(), `grok-gui-worktree-${randomUUID()}`);
    const checkout = `${root}-preview`;
    fs.mkdirSync(root, { recursive: true });

    try {
      git(root, ["init", "--initial-branch", "main"]);
      git(root, ["config", "user.email", "grok-gui-test@example.invalid"]);
      git(root, ["config", "user.name", "Grok GUI test"]);
      git(root, ["commit", "--allow-empty", "-m", "initial"]);
      git(root, ["worktree", "add", "-b", "preview", checkout]);
      fs.writeFileSync(path.join(checkout, "uncommitted.txt"), "preview change");

      const snapshot = await overview(root);
      expect(snapshot.branch).toBe("main");
      expect(snapshot.worktrees).toHaveLength(2);
      expect(snapshot.worktrees.some((tree) => tree.isCurrent && !tree.dirty)).toBe(true);
      expect(
        snapshot.worktrees.some((tree) => tree.branch === "preview" && !tree.isCurrent && tree.dirty),
      ).toBe(true);
    } finally {
      try {
        git(root, ["worktree", "remove", "--force", checkout]);
      } catch {
        // best-effort cleanup
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });
});
