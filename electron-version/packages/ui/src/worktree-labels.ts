import type { WorkspaceWorktree } from "@grok-gui/core";

export function worktreeLabel(worktree: WorkspaceWorktree, language: "zh-CN" | "en-US" = "zh-CN"): string {
  const name = worktree.detached ? "detached HEAD" : worktree.branch || (language === "en-US" ? "unknown branch" : "未知分支");
  return worktree.isCurrent ? `${name} · ${language === "en-US" ? "current" : "当前"}` : name;
}

export function worktreeStatus(worktree: WorkspaceWorktree, language: "zh-CN" | "en-US" = "zh-CN"): string {
  return worktree.dirty ? (language === "en-US" ? "Changes" : "有改动") : (language === "en-US" ? "Clean" : "干净");
}
