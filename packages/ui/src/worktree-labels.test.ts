import { describe, expect, it } from "vitest";
import type { WorkspaceWorktree } from "@grok-gui/core";
import { worktreeLabel, worktreeStatus } from "./worktree-labels";

const current: WorkspaceWorktree = {
  path: "/repo",
  branch: "main",
  detached: false,
  isCurrent: true,
  dirty: false,
};

describe("worktree labels", () => {
  it("labels a current branch without exposing its full path", () => {
    expect(worktreeLabel(current)).toBe("main · 当前");
  });

  it("describes detached and dirty worktrees", () => {
    expect(worktreeLabel({ ...current, path: "/repo-fix", branch: null, detached: true, isCurrent: false })).toBe("detached HEAD");
    expect(worktreeStatus({ ...current, dirty: true })).toBe("有改动");
  });
});
