//! Safe, project-scoped filesystem and Git inspection.
//!
//! This is deliberately a deep module: callers pass a workspace root and a
//! relative path, while path validation, ignored-directory rules, Git parsing,
//! and output limits live here. Neither the webview nor the ACP adapter gets
//! unrestricted filesystem access through this module.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_FILES: usize = 240;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_DEPTH: usize = 4;

/// Directory/content-search entry points below stay off the git index for
/// speed and to bound worst-case cost on huge or non-Git projects.
const MAX_DIR_ENTRIES: usize = 1000;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SEARCH_CANDIDATES: usize = 20_000;
const MAX_SEARCH_RESULTS: usize = 500;

/// Directory names that never belong in a lazy file tree or a content
/// search, whether or not the project is a Git repository (`.gitignore`
/// coverage is best-effort and this list is the hard floor beneath it).
const SKIP_ENTRY_NAMES: &[&str] = &[
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
];

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

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
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

/// List a single directory level for the lazy file tree. Unlike `overview`'s
/// `collect_files`, this never recurses: callers expand one level at a time
/// as the user opens folders, so a huge monorepo never pays for a full walk.
pub fn list_dir(workspace: &str, relative_dir: &str) -> Result<Vec<WorkspaceDirEntry>> {
    let root = canonical_root(workspace)?;
    let dir = if relative_dir.trim().is_empty() || relative_dir == "." {
        root.clone()
    } else {
        let resolved = resolve_workspace_path(&root, relative_dir)?;
        if !resolved.is_dir() {
            return Err(anyhow!("not a directory"));
        }
        resolved
    };

    let read_dir =
        fs::read_dir(&dir).with_context(|| format!("cannot read directory {}", dir.display()))?;
    let mut entries: Vec<_> = read_dir.filter_map(|entry| entry.ok()).collect();
    entries.sort_by_key(|entry| entry.file_name());

    let ignored = git_ignored_names(&root, &entries);

    let mut out = Vec::new();
    for entry in entries {
        if out.len() >= MAX_DIR_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_ENTRY_NAMES.contains(&name.as_str()) || ignored.contains(&name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();
        let path = entry.path();
        let size = if is_dir {
            0
        } else {
            fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        out.push(WorkspaceDirEntry {
            name,
            is_dir,
            size,
            path: relative,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Ask Git which of `entries` (all direct children of the same directory)
/// are ignored, in one `check-ignore --stdin` round trip. Best-effort: a
/// non-Git workspace or a failed spawn simply yields no matches, so lazy
/// listing degrades to the hard-coded skip list instead of failing outright.
fn git_ignored_names(root: &Path, entries: &[fs::DirEntry]) -> HashSet<String> {
    let mut ignored = HashSet::new();
    if entries.is_empty() {
        return ignored;
    }
    let mut stdin_payload = String::new();
    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        stdin_payload.push_str(&relative.to_string_lossy());
        stdin_payload.push('\n');
    }
    let Ok(mut child) = Command::new("git")
        .args(["check-ignore", "--stdin"])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return ignored;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_payload.as_bytes());
    }
    let Ok(output) = child.wait_with_output() else {
        return ignored;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(name) = Path::new(line).file_name().and_then(|n| n.to_str()) {
            ignored.insert(name.to_string());
        }
    }
    ignored
}

/// Search text file contents across the workspace. Files come from `git
/// ls-files` (tracked + untracked-but-not-ignored) when the workspace is a
/// Git repository, which is how `.gitignore` coverage is honoured without a
/// dedicated ignore-file parser; a bounded manual walk is the fallback for
/// non-Git directories. Matching reads each candidate file line-by-line
/// through a `BufReader` rather than loading it whole, and both the
/// candidate count and match count are capped so a huge repo or a very
/// common query can't turn this into an unbounded scan.
pub fn search_content(workspace: &str, query: &str, max_results: usize) -> Result<Vec<WorkspaceSearchMatch>> {
    let root = canonical_root(workspace)?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let max_results = max_results.clamp(1, MAX_SEARCH_RESULTS);
    let needle = query.to_lowercase();

    let mut matches = Vec::new();
    for relative in search_candidates(&root) {
        if matches.len() >= max_results {
            break;
        }
        if should_skip_search_path(&relative) {
            continue;
        }
        let path = root.join(&relative);
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        if is_probably_binary(&path) {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let Ok(line) = line else { break };
            if line.to_lowercase().contains(&needle) {
                let mut text = line;
                if text.len() > 300 {
                    text.truncate(300);
                }
                matches.push(WorkspaceSearchMatch {
                    path: relative.clone(),
                    line: index + 1,
                    text,
                });
                if matches.len() >= max_results {
                    break;
                }
            }
        }
    }
    Ok(matches)
}

fn is_probably_binary(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return true;
    };
    let mut head = [0u8; 4096];
    let Ok(read) = file.read(&mut head) else {
        return true;
    };
    head[..read].contains(&0)
}

fn should_skip_search_path(relative: &str) -> bool {
    Path::new(relative).components().any(|component| {
        matches!(component, Component::Normal(name) if SKIP_ENTRY_NAMES.contains(&name.to_string_lossy().as_ref()))
    })
}

/// Relative file paths to search, respecting `.gitignore` via `git
/// ls-files` when available. Falls back to a bounded manual walk (still
/// skipping `SKIP_ENTRY_NAMES`) so non-Git workspaces stay searchable.
fn search_candidates(root: &Path) -> Vec<String> {
    if let Ok(output) = Command::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .current_dir(root)
        .output()
    {
        if output.status.success() {
            return String::from_utf8_lossy(&output.stdout)
                .split('\0')
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect();
        }
    }
    let mut out = Vec::new();
    let _ = walk_search_candidates(root, root, &mut out);
    out
}

fn walk_search_candidates(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
    if out.len() >= MAX_SEARCH_CANDIDATES {
        return Ok(());
    }
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Ok(());
    };
    let mut entries: Vec<_> = read_dir.filter_map(|entry| entry.ok()).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_SEARCH_CANDIDATES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_ENTRY_NAMES.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_search_candidates(root, &path, out)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            out.push(relative);
        }
    }
    Ok(())
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

    fn temp_repo(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("grok-gui-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary repository directory");
        git_ok(&root, &["init", "--initial-branch", "main"]);
        git_ok(&root, &["config", "user.email", "grok-gui-test@example.invalid"]);
        git_ok(&root, &["config", "user.name", "Grok GUI test"]);
        root
    }

    #[test]
    fn list_dir_hides_gitignored_and_hard_coded_skip_entries() {
        let root = temp_repo("list-dir");
        let result = (|| -> Result<()> {
            fs::write(root.join(".gitignore"), "ignored.txt\n")?;
            fs::write(root.join("ignored.txt"), "should not show up")?;
            fs::write(root.join("kept.txt"), "kept")?;
            fs::create_dir_all(root.join("node_modules"))?;
            fs::create_dir_all(root.join("src"))?;
            fs::write(root.join("src/lib.rs"), "fn main() {}")?;

            let entries = list_dir(root.to_str().expect("UTF-8 path"), "")?;
            let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
            assert!(names.contains(&"kept.txt"));
            assert!(names.contains(&"src"));
            assert!(names.contains(&".gitignore"));
            assert!(!names.contains(&"ignored.txt"), "gitignored file leaked: {:?}", names);
            assert!(!names.contains(&"node_modules"), "hard-coded skip name leaked: {:?}", names);
            assert!(entries.iter().find(|e| e.name == "src").expect("src entry").is_dir);

            let nested = list_dir(root.to_str().expect("UTF-8 path"), "src")?;
            assert_eq!(nested.len(), 1);
            assert_eq!(nested[0].name, "lib.rs");
            assert_eq!(nested[0].path, "src/lib.rs");
            Ok(())
        })();
        let _ = fs::remove_dir_all(&root);
        result.expect("list_dir should list one level while respecting ignore rules");
    }

    #[test]
    fn list_dir_rejects_traversal_outside_the_workspace() {
        let root = temp_repo("list-dir-traversal");
        let outcome = list_dir(root.to_str().expect("UTF-8 path"), "../etc");
        let _ = fs::remove_dir_all(&root);
        assert!(outcome.is_err());
    }

    #[test]
    fn search_content_matches_text_files_and_skips_binaries_and_ignored_paths() {
        let root = temp_repo("search-content");
        let result = (|| -> Result<()> {
            fs::write(root.join(".gitignore"), "ignored-dir/\n")?;
            fs::write(root.join("needle.txt"), "line one\nfind the NEEDLE here\nline three\n")?;
            fs::create_dir_all(root.join("ignored-dir"))?;
            fs::write(root.join("ignored-dir/needle.txt"), "needle in an ignored dir")?;
            fs::write(root.join("binary.dat"), [b'n', b'e', b'e', b'd', b'l', b'e', 0u8, 1u8, 2u8])?;

            let matches = search_content(root.to_str().expect("UTF-8 path"), "needle", 50)?;
            assert_eq!(matches.len(), 1, "expected exactly one match, got {:?}", matches);
            assert_eq!(matches[0].path, "needle.txt");
            assert_eq!(matches[0].line, 2);
            assert!(matches[0].text.to_lowercase().contains("needle"));
            Ok(())
        })();
        let _ = fs::remove_dir_all(&root);
        result.expect("search_content should find matches while skipping binaries and ignored paths");
    }

    #[test]
    fn search_content_returns_nothing_for_a_blank_query() {
        let root = temp_repo("search-content-blank");
        let outcome = search_content(root.to_str().expect("UTF-8 path"), "   ", 10);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(outcome.expect("blank query should not error"), Vec::new());
    }
}
