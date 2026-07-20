//! Safe, project-scoped filesystem and Git inspection.
//!
//! This is deliberately a deep module: callers pass a workspace root and a
//! relative path, while path validation, ignored-directory rules, Git parsing,
//! and output limits live here. Neither the webview nor the ACP adapter gets
//! unrestricted filesystem access through this module.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_FILES: usize = 240;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_DEPTH: usize = 4;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverview {
    pub root: String,
    pub name: String,
    pub branch: Option<String>,
    pub worktrees: Vec<WorkspaceWorktree>,
    pub changes: Vec<WorkspaceChange>,
    pub files: Vec<WorkspaceFile>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub is_current: bool,
    pub dirty: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub depth: usize,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceText {
    pub path: String,
    pub content: String,
}

pub fn overview(workspace: &str) -> Result<WorkspaceOverview> {
    let root = canonical_root(workspace)?;
    let files = collect_files(&root)?;
    Ok(WorkspaceOverview {
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .unwrap_or_else(|| root.to_string_lossy().to_string()),
        root: root.to_string_lossy().to_string(),
        branch: git_stdout(&root, &["branch", "--show-current"]),
        worktrees: git_worktrees(&root),
        changes: git_changes(&root),
        files,
    })
}

pub fn read_text(workspace: &str, relative_path: &str) -> Result<WorkspaceText> {
    let root = canonical_root(workspace)?;
    let path = resolve_existing(&root, relative_path)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err(anyhow!("file is larger than {} KiB", MAX_FILE_BYTES / 1024));
    }
    let content = fs::read_to_string(&path).context("file is not valid UTF-8 text")?;
    Ok(WorkspaceText {
        path: relative_path.to_string(),
        content,
    })
}

pub fn diff(workspace: &str, relative_path: &str) -> Result<WorkspaceText> {
    let root = canonical_root(workspace)?;
    // Resolve before invoking Git; this rejects traversal and symlink escapes.
    let _ = resolve_existing(&root, relative_path)?;
    let output = Command::new("git")
        .args(["diff", "--no-ext-diff", "--", relative_path])
        .current_dir(&root)
        .output()
        .context("failed to run git diff")?;
    if !output.status.success() {
        return Err(anyhow!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(WorkspaceText {
        path: relative_path.to_string(),
        content: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

/// Resolve an ACP filesystem path inside `root`, including files which do not
/// yet exist. This is shared by read/write request handlers in `grok_runtime`.
pub fn resolve_workspace_path(root: &Path, requested: &str) -> Result<PathBuf> {
    let requested = Path::new(requested);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    for component in requested.components() {
        if matches!(component, Component::ParentDir)
            || (!requested.is_absolute()
                && matches!(component, Component::RootDir | Component::Prefix(_)))
        {
            return Err(anyhow!("path must stay inside the selected workspace"));
        }
    }

    if candidate.exists() {
        let canonical = candidate.canonicalize()?;
        if canonical.starts_with(root) {
            return Ok(canonical);
        }
        return Err(anyhow!("path resolves outside the selected workspace"));
    }

    // New files can have new intermediate directories. Validate the nearest
    // existing ancestor instead of requiring the immediate parent to exist.
    let mut ancestor = candidate.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| anyhow!("path has no existing ancestor"))?;
    }
    let parent = ancestor.canonicalize()?;
    if !parent.starts_with(root) {
        return Err(anyhow!("path resolves outside the selected workspace"));
    }
    Ok(candidate)
}

fn canonical_root(workspace: &str) -> Result<PathBuf> {
    let root = Path::new(workspace)
        .canonicalize()
        .with_context(|| format!("cannot open workspace {workspace}"))?;
    if !root.is_dir() {
        return Err(anyhow!("workspace is not a directory"));
    }
    Ok(root)
}

fn resolve_existing(root: &Path, relative_path: &str) -> Result<PathBuf> {
    let path = resolve_workspace_path(root, relative_path)?;
    if !path.is_file() {
        return Err(anyhow!("not a regular file"));
    }
    Ok(path)
}

fn collect_files(root: &Path) -> Result<Vec<WorkspaceFile>> {
    let mut result = Vec::new();
    collect_files_inner(root, root, 0, &mut result)?;
    Ok(result)
}

fn collect_files_inner(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<WorkspaceFile>,
) -> Result<()> {
    if depth >= MAX_DEPTH || out.len() >= MAX_FILES {
        return Ok(());
    }
    // A selected project can contain protected build artefacts or mounted
    // folders. They are not a reason to fail the entire project workbench.
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Ok(());
    };
    let mut entries = read_dir.filter_map(|entry| entry.ok()).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_FILES {
            break;
        }
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if matches!(
            name_text.as_ref(),
            ".git" | "node_modules" | "target" | "dist" | ".DS_Store"
        ) {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        out.push(WorkspaceFile {
            path: relative,
            depth,
            is_dir,
        });
        if is_dir {
            collect_files_inner(root, &path, depth + 1, out)?;
        }
    }
    Ok(())
}

fn git_stdout(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_changes(root: &Path) -> Vec<WorkspaceChange> {
    let Some(output) = Command::new("git")
        .args(["status", "--porcelain=v1", "-z"])
        .current_dir(root)
        .output()
        .ok()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_git_changes(&String::from_utf8_lossy(&output.stdout))
}

fn parse_git_changes(output: &str) -> Vec<WorkspaceChange> {
    let mut records = output.split('\0').filter(|record| !record.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        // Porcelain v1 -z represents rename/copy as `XY new-path\0old-path\0`.
        // The second path has no status prefix and must not become a phantom row.
        if record.len() < 4 {
            continue;
        }
        let index_status = record[0..1].to_string();
        let worktree_status = record[1..2].to_string();
        let path = record[3..].to_string();
        if matches!(index_status.as_str(), "R" | "C")
            || matches!(worktree_status.as_str(), "R" | "C")
        {
            let _ = records.next();
        }
        changes.push(WorkspaceChange {
            index_status,
            worktree_status,
            path,
        });
    }
    changes
}

fn git_worktrees(root: &Path) -> Vec<WorkspaceWorktree> {
    let Some(output) = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(root)
        .output()
        .ok()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let mut worktrees = parse_worktree_list(&String::from_utf8_lossy(&output.stdout), root);
    for worktree in &mut worktrees {
        worktree.dirty = !git_changes(Path::new(&worktree.path)).is_empty();
    }
    worktrees
}

fn parse_worktree_list(output: &str, current_root: &Path) -> Vec<WorkspaceWorktree> {
    output
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            let mut detached = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(value.to_string());
                } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(value.to_string());
                } else if line == "detached" {
                    detached = true;
                }
            }
            let path = path?;
            let canonical = Path::new(&path)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(&path));
            Some(WorkspaceWorktree {
                path: canonical.to_string_lossy().to_string(),
                branch,
                detached,
                is_current: canonical == current_root,
                dirty: false,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_ok(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn rejects_parent_traversal_before_touching_disk() {
        let root = Path::new("/tmp");
        assert!(resolve_workspace_path(root, "../private.txt").is_err());
        assert!(resolve_workspace_path(root, "/etc/hosts").is_err());
    }

    #[test]
    fn parses_porcelain_worktrees_and_marks_the_selected_path() {
        let records = parse_worktree_list(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-fix\nHEAD def\ndetached\n\n",
            Path::new("/repo"),
        );

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].path, "/repo");
        assert_eq!(records[0].branch.as_deref(), Some("main"));
        assert!(records[0].is_current);
        assert!(!records[0].detached);
        assert!(records[1].detached);
    }

    #[test]
    fn parses_renames_without_creating_a_phantom_change() {
        let records = parse_git_changes("R  new-name.txt\0old-name.txt\0 M kept.txt\0");

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].index_status, "R");
        assert_eq!(records[0].worktree_status, " ");
        assert_eq!(records[0].path, "new-name.txt");
        assert_eq!(records[1].path, "kept.txt");
    }

    #[test]
    fn overview_discovers_real_git_worktrees_and_dirty_state() {
        let root = std::env::temp_dir().join(format!("grok-gui-worktree-{}", uuid::Uuid::new_v4()));
        let checkout = root.with_file_name(format!(
            "{}-preview",
            root.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("worktree")
        ));
        fs::create_dir_all(&root).expect("temporary repository directory");

        let result = (|| -> Result<()> {
            git_ok(&root, &["init", "--initial-branch", "main"]);
            git_ok(
                &root,
                &["config", "user.email", "grok-gui-test@example.invalid"],
            );
            git_ok(&root, &["config", "user.name", "Grok GUI test"]);
            git_ok(&root, &["commit", "--allow-empty", "-m", "initial"]);
            git_ok(
                &root,
                &[
                    "worktree",
                    "add",
                    "-b",
                    "preview",
                    checkout.to_str().expect("UTF-8 path"),
                ],
            );
            fs::write(checkout.join("uncommitted.txt"), "preview change")?;

            let snapshot = overview(root.to_str().expect("UTF-8 path"))?;
            assert_eq!(snapshot.branch.as_deref(), Some("main"));
            assert_eq!(snapshot.worktrees.len(), 2);
            assert!(snapshot
                .worktrees
                .iter()
                .any(|tree| tree.is_current && !tree.dirty));
            assert!(snapshot.worktrees.iter().any(|tree| {
                tree.branch.as_deref() == Some("preview") && !tree.is_current && tree.dirty
            }));
            Ok(())
        })();

        let _ = Command::new("git")
            .args([
                "worktree",
                "remove",
                "--force",
                checkout.to_str().unwrap_or_default(),
            ])
            .current_dir(&root)
            .output();
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&checkout);
        result.expect("real worktree should be represented in workspace overview");
    }
}
