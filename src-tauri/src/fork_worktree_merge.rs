//! Fork: merge a session's worktree back into the branch it came from.
//!
//! The base is remembered in `branch.<name>.monocodeBase` when the worktree is
//! created, so it follows `git branch -m` and survives restarts. Conflicts are
//! found with `git merge-tree` first, so the base checkout is never left in a
//! half-merged state.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

use crate::fs::expand_home;

const BASE_KEY: &str = "monocodeBase";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStatus {
    pub branch: String,
    pub base: String,
    /// The checkout that has the base branch open, when one does.
    pub base_checkout: Option<String>,
    /// That checkout is part way through a merge, rebase or cherry-pick.
    pub base_busy: bool,
    pub ahead: u64,
    pub behind: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
    /// Uncommitted paths in the worktree. They would not be merged.
    pub uncommitted: u64,
    pub conflicts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// "fast-forward", "merged", "up-to-date" or "conflict".
    pub kind: String,
    pub conflicts: Vec<String>,
}

fn run(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("PATH", crate::harness::cached_gui_search_path())
        .output()
        .map_err(|e| e.to_string())
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = run(root, args)?;
    if !output.status.success() {
        return Err(failure_text(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn failure_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        return stderr.trim().to_string();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn has_branch(root: &Path, branch: &str) -> bool {
    run(
        root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map(|output| output.status.success())
    .unwrap_or(false)
}

/// The main checkout comes first, as in `git worktree list`.
fn trees(root: &Path) -> Result<Vec<(PathBuf, Option<String>)>, String> {
    let text = git(root, &["worktree", "list", "--porcelain"])?;
    let mut found: Vec<(PathBuf, Option<String>)> = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            found.push((PathBuf::from(path), None));
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(last) = found.last_mut() {
                last.1 = Some(branch.to_string());
            }
        }
    }
    // Git lists a checkout that stopped mid-rebase as detached, but it still
    // owns its branch.
    for (tree, branch) in &mut found {
        if branch.is_none() {
            *branch = rebasing_branch(tree);
        }
    }
    Ok(found)
}

fn git_path(checkout: &Path, name: &str) -> Option<PathBuf> {
    let path = git(checkout, &["rev-parse", "--git-path", name]).ok()?;
    let path = PathBuf::from(path);
    Some(if path.is_absolute() {
        path
    } else {
        checkout.join(path)
    })
}

fn git_path_exists(checkout: &Path, name: &str) -> bool {
    git_path(checkout, name).is_some_and(|path| path.exists())
}

fn rebasing_branch(checkout: &Path) -> Option<String> {
    ["rebase-merge/head-name", "rebase-apply/head-name"]
        .iter()
        .find_map(|name| {
            let text = std::fs::read_to_string(git_path(checkout, name)?).ok()?;
            text.trim().strip_prefix("refs/heads/").map(str::to_string)
        })
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Called when a worktree is created. Bases that are not local branches, such
/// as a remote ref, are left out and fall back to the main checkout's branch.
pub fn remember_base(root: &Path, branch: &str, base: &str) {
    let base = base.trim();
    let target = if base == "HEAD" {
        match git(root, &["symbolic-ref", "--short", "-q", "HEAD"]) {
            Ok(name) => name,
            Err(_) => return,
        }
    } else {
        base.strip_prefix("refs/heads/").unwrap_or(base).to_string()
    };
    if target == branch || !has_branch(root, &target) {
        return;
    }
    let key = format!("branch.{branch}.{BASE_KEY}");
    if let Err(error) = git(root, &["config", &key, &target]) {
        eprintln!("Could not remember the worktree's base branch: {error}");
    }
}

fn resolve_base(
    root: &Path,
    branch: &str,
    all: &[(PathBuf, Option<String>)],
) -> Result<String, String> {
    let key = format!("branch.{branch}.{BASE_KEY}");
    let saved = git(root, &["config", "--get", &key]).unwrap_or_default();
    if !saved.is_empty() && saved != branch && has_branch(root, &saved) {
        return Ok(saved);
    }
    match all.first().and_then(|(_, name)| name.clone()) {
        Some(main) if main != branch => Ok(main),
        _ => Err("This worktree has no branch to merge back into".into()),
    }
}

fn in_progress(checkout: &Path) -> bool {
    [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "rebase-merge",
        "rebase-apply",
    ]
    .iter()
    .any(|name| git_path_exists(checkout, name))
}

/// The files a merge would conflict on. Unknown (old Git) reads as none; the
/// real merge below still aborts cleanly when it finds some.
fn predicted_conflicts(root: &Path, base: &str, branch: &str) -> Result<Vec<String>, String> {
    let base = format!("refs/heads/{base}");
    let branch = format!("refs/heads/{branch}");
    let output = run(
        root,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            &base,
            &branch,
        ],
    )?;
    if output.status.code() != Some(1) {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .take_while(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn parse_numstat(text: &str) -> (u64, u64, u64) {
    let (mut additions, mut deletions, mut files) = (0, 0, 0);
    for line in text.lines() {
        let mut parts = line.split('\t');
        // Binary files count as a file, with "-" for their line counts.
        let added = parts.next().and_then(|value| value.parse::<u64>().ok());
        let removed = parts.next().and_then(|value| value.parse::<u64>().ok());
        additions += added.unwrap_or(0);
        deletions += removed.unwrap_or(0);
        files += 1;
    }
    (additions, deletions, files)
}

pub fn status(root: &Path, path: &Path) -> Result<MergeStatus, String> {
    let all = trees(root)?;
    let index = all
        .iter()
        .position(|(tree, _)| same_path(tree, path))
        .ok_or("This path is not a worktree of this repository")?;
    if index == 0 {
        return Err("The main checkout has nothing to merge back into".into());
    }
    let branch = all[index].1.clone().ok_or("The worktree is detached")?;
    let base = resolve_base(root, &branch, &all)?;
    let base_checkout = all
        .iter()
        .find(|(_, name)| name.as_deref() == Some(base.as_str()))
        .map(|(tree, _)| tree.clone());
    let range = format!("refs/heads/{base}...refs/heads/{branch}");
    let counts = git(root, &["rev-list", "--left-right", "--count", &range])?;
    let mut counts = counts.split_whitespace();
    let behind = counts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let ahead = counts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let (additions, deletions, files) = parse_numstat(&git(root, &["diff", "--numstat", &range])?);
    let uncommitted = git(path, &["status", "--porcelain", "--untracked-files=normal"])?
        .lines()
        .count() as u64;
    let conflicts = if ahead > 0 && behind > 0 {
        predicted_conflicts(root, &base, &branch)?
    } else {
        Vec::new()
    };
    Ok(MergeStatus {
        base_busy: base_checkout.as_deref().is_some_and(in_progress),
        base_checkout: base_checkout.map(|tree| tree.to_string_lossy().into_owned()),
        branch,
        base,
        ahead,
        behind,
        additions,
        deletions,
        files,
        uncommitted,
        conflicts,
    })
}

fn outcome(kind: &str, conflicts: Vec<String>) -> MergeOutcome {
    MergeOutcome {
        kind: kind.to_string(),
        conflicts,
    }
}

fn is_ancestor(root: &Path, older: &str, newer: &str) -> Result<bool, String> {
    Ok(run(root, &["merge-base", "--is-ancestor", older, newer])?
        .status
        .success())
}

/// The base branch has no checkout: move its ref without touching any files.
/// Every step uses the commits read here, so `update-ref` refuses to move the
/// base if anything else moved it first.
fn merge_without_checkout(root: &Path, state: &MergeStatus) -> Result<MergeOutcome, String> {
    let base_ref = format!("refs/heads/{}", state.base);
    let branch_ref = format!("refs/heads/{}", state.branch);
    let old = git(root, &["rev-parse", "--verify", &base_ref])?;
    let tip = git(root, &["rev-parse", "--verify", &branch_ref])?;
    let reason = format!("Merge back {}", state.branch);
    if is_ancestor(root, &tip, &old)? {
        return Ok(outcome("up-to-date", Vec::new()));
    }
    if is_ancestor(root, &old, &tip)? {
        git(root, &["update-ref", "-m", &reason, &base_ref, &tip, &old])?;
        return Ok(outcome("fast-forward", Vec::new()));
    }
    let tree = git(root, &["merge-tree", "--write-tree", &old, &tip])?;
    let message = format!("Merge branch '{}' into {}", state.branch, state.base);
    let commit = git(
        root,
        &["commit-tree", &tree, "-p", &old, "-p", &tip, "-m", &message],
    )?;
    git(
        root,
        &["update-ref", "-m", &reason, &base_ref, &commit, &old],
    )?;
    Ok(outcome("merged", Vec::new()))
}

fn merge_in_checkout(checkout: &Path, state: &MergeStatus) -> Result<MergeOutcome, String> {
    let branch_ref = format!("refs/heads/{}", state.branch);
    let tip = git(checkout, &["rev-parse", "--verify", &branch_ref])?;
    // The checkout may have moved on since the status was read.
    let current = git(checkout, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default();
    if current != state.base {
        return Err(format!(
            "The base checkout is no longer on {}. Check it and try again.",
            state.base
        ));
    }
    let ours = || {
        git(checkout, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok_and(|head| head == tip)
    };
    // Explicit, so a merge setting can't leave a half-done merge or reapply
    // stashed edits on top of it.
    let output = run(
        checkout,
        &[
            "merge",
            "--commit",
            "--no-squash",
            "--no-autostash",
            "--no-edit",
            &branch_ref,
        ],
    )?;
    if output.status.success() {
        if ours() {
            git(checkout, &["merge", "--abort"])?;
            return Err("Git did not finish the merge, so it was undone".into());
        }
        let kind = if state.behind == 0 {
            "fast-forward"
        } else {
            "merged"
        };
        return Ok(outcome(kind, Vec::new()));
    }
    // A refused hook or signature also stops mid-merge. Only a merge of this
    // branch is ours to undo; another session's stays as it is.
    if !ours() {
        return Err(failure_text(&output));
    }
    let conflicts: Vec<String> = git(checkout, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
    git(checkout, &["merge", "--abort"])?;
    if conflicts.is_empty() {
        return Err(failure_text(&output));
    }
    Ok(outcome("conflict", conflicts))
}

pub fn merge_back(root: &Path, path: &Path) -> Result<MergeOutcome, String> {
    let state = status(root, path)?;
    if state.uncommitted > 0 {
        return Err("Commit the worktree's changes first, or they would be left behind".into());
    }
    if in_progress(path) {
        return Err(
            "This worktree is part way through a merge or rebase. Finish that first.".into(),
        );
    }
    if state.ahead == 0 {
        return Ok(outcome("up-to-date", Vec::new()));
    }
    if !state.conflicts.is_empty() {
        return Ok(outcome("conflict", state.conflicts));
    }
    if state.base_busy {
        return Err(format!(
            "{} is part way through a merge or rebase. Finish that first.",
            state.base
        ));
    }
    match state.base_checkout.as_deref() {
        Some(checkout) => merge_in_checkout(Path::new(checkout), &state),
        None => merge_without_checkout(root, &state),
    }
}

/// Only ever deletes a branch the base already contains, once nothing has it
/// open. The delete names the commit that was checked, so a branch that moves
/// in between is kept.
pub fn delete_merged_branch(root: &Path, branch: &str, base: &str) -> Result<(), String> {
    let branch_ref = format!("refs/heads/{branch}");
    let base_ref = format!("refs/heads/{base}");
    let tip = git(root, &["rev-parse", "--verify", &branch_ref])?;
    let base_tip = git(root, &["rev-parse", "--verify", &base_ref])?;
    if trees(root)?
        .iter()
        .any(|(_, name)| name.as_deref() == Some(branch))
    {
        return Err("This branch is still open in a worktree".into());
    }
    if !is_ancestor(root, &tip, &base_tip)? {
        return Err(format!("{branch} is not fully merged into {base}"));
    }
    git(root, &["update-ref", "-d", &branch_ref, &tip])?;
    // Its saved settings would otherwise wait for a later branch of this name.
    let _ = git(
        root,
        &["config", "--remove-section", &format!("branch.{branch}")],
    );
    Ok(())
}

#[tauri::command(async)]
pub fn fork_worktree_merge_status(cwd: String, path: String) -> Result<MergeStatus, String> {
    status(&expand_home(&cwd), &expand_home(&path))
}

#[tauri::command(async)]
pub fn fork_worktree_merge_back(cwd: String, path: String) -> Result<MergeOutcome, String> {
    merge_back(&expand_home(&cwd), &expand_home(&path))
}

#[tauri::command(async)]
pub fn fork_worktree_delete_merged_branch(
    cwd: String,
    branch: String,
    base: String,
) -> Result<(), String> {
    delete_merged_branch(&expand_home(&cwd), &branch, &base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct Repo {
        dir: PathBuf,
        main: PathBuf,
        tree: PathBuf,
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn sh(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit(root: &Path, file: &str, text: &str) {
        fs::write(root.join(file), text).unwrap();
        sh(root, &["add", "-A"]);
        sh(root, &["commit", "-qm", file]);
    }

    /// `base` on the main checkout, with `mc/work` open in a worktree.
    fn repo() -> Repo {
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("mc-merge-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let main = dir.join("main");
        fs::create_dir_all(&main).unwrap();
        sh(&main, &["init", "-q", "-b", "base"]);
        sh(&main, &["config", "user.name", "T"]);
        sh(&main, &["config", "user.email", "t@example.com"]);
        commit(&main, "a.txt", "one\n");
        let tree = dir.join("tree");
        sh(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "mc/work",
                tree.to_str().unwrap(),
            ],
        );
        remember_base(&main, "mc/work", "HEAD");
        Repo { dir, main, tree }
    }

    fn base_has(repo: &Repo, file: &str) -> bool {
        run(&repo.main, &["cat-file", "-e", &format!("base:{file}")])
            .unwrap()
            .status
            .success()
    }

    #[test]
    fn counts_stats_and_uncommitted() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\ny\n");
        fs::write(repo.tree.join("loose.txt"), "z").unwrap();
        let state = status(&repo.main, &repo.tree).unwrap();
        assert_eq!(state.branch, "mc/work");
        assert_eq!(state.base, "base");
        assert_eq!((state.ahead, state.behind), (1, 0));
        assert_eq!((state.additions, state.deletions, state.files), (2, 0, 1));
        assert_eq!(state.uncommitted, 1);
        assert!(merge_back(&repo.main, &repo.tree).is_err());
        assert!(!base_has(&repo, "b.txt"));
    }

    #[test]
    fn remembered_base_follows_a_branch_rename() {
        let repo = repo();
        sh(&repo.main, &["branch", "other"]);
        sh(
            &repo.main,
            &["config", "branch.mc/work.monocodeBase", "other"],
        );
        sh(&repo.tree, &["branch", "-m", "mc/renamed"]);
        assert_eq!(status(&repo.main, &repo.tree).unwrap().base, "other");
    }

    #[test]
    fn missing_config_falls_back_to_the_main_branch() {
        let repo = repo();
        sh(
            &repo.main,
            &["config", "--unset", "branch.mc/work.monocodeBase"],
        );
        assert_eq!(status(&repo.main, &repo.tree).unwrap().base, "base");
    }

    #[test]
    fn nothing_to_merge_is_up_to_date() {
        let repo = repo();
        assert_eq!(
            merge_back(&repo.main, &repo.tree).unwrap().kind,
            "up-to-date"
        );
    }

    #[test]
    fn fast_forwards_when_the_base_has_not_moved() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        assert_eq!(
            merge_back(&repo.main, &repo.tree).unwrap().kind,
            "fast-forward"
        );
        assert!(repo.main.join("b.txt").exists());
    }

    #[test]
    fn merges_when_both_sides_moved() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        commit(&repo.main, "c.txt", "y\n");
        let state = status(&repo.main, &repo.tree).unwrap();
        assert_eq!((state.ahead, state.behind), (1, 1));
        assert!(state.conflicts.is_empty());
        assert_eq!(merge_back(&repo.main, &repo.tree).unwrap().kind, "merged");
        assert!(repo.main.join("b.txt").exists());
        assert!(repo.main.join("c.txt").exists());
    }

    #[test]
    fn conflict_leaves_the_base_checkout_clean() {
        let repo = repo();
        commit(&repo.tree, "a.txt", "tree\n");
        commit(&repo.main, "a.txt", "main\n");
        let state = status(&repo.main, &repo.tree).unwrap();
        assert_eq!(state.conflicts, vec!["a.txt".to_string()]);
        let merged = merge_back(&repo.main, &repo.tree).unwrap();
        assert_eq!(merged.kind, "conflict");
        assert_eq!(merged.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(
            fs::read_to_string(repo.main.join("a.txt")).unwrap(),
            "main\n"
        );
        assert!(!in_progress(&repo.main));
        assert_eq!(git(&repo.main, &["status", "--porcelain"]).unwrap(), "");
    }

    #[test]
    fn overlapping_uncommitted_base_changes_refuse_and_keep_the_work() {
        let repo = repo();
        commit(&repo.tree, "a.txt", "tree\n");
        fs::write(repo.main.join("a.txt"), "unsaved\n").unwrap();
        assert!(merge_back(&repo.main, &repo.tree).is_err());
        assert_eq!(
            fs::read_to_string(repo.main.join("a.txt")).unwrap(),
            "unsaved\n"
        );
    }

    #[test]
    fn a_base_with_no_checkout_moves_by_ref() {
        let repo = repo();
        sh(&repo.main, &["checkout", "-q", "-b", "elsewhere"]);
        commit(&repo.tree, "b.txt", "x\n");
        assert_eq!(
            merge_back(&repo.main, &repo.tree).unwrap().kind,
            "fast-forward"
        );
        assert!(base_has(&repo, "b.txt"));
        assert!(!repo.main.join("b.txt").exists());

        commit(&repo.tree, "c.txt", "x\n");
        sh(&repo.main, &["checkout", "-q", "base"]);
        commit(&repo.main, "d.txt", "y\n");
        sh(&repo.main, &["checkout", "-q", "elsewhere"]);
        assert_eq!(merge_back(&repo.main, &repo.tree).unwrap().kind, "merged");
        assert!(base_has(&repo, "c.txt"));
        assert!(base_has(&repo, "d.txt"));
    }

    #[test]
    fn a_base_mid_merge_is_reported_busy_and_refused() {
        let repo = repo();
        sh(&repo.main, &["branch", "side"]);
        commit(&repo.main, "a.txt", "main\n");
        sh(&repo.main, &["checkout", "-q", "side"]);
        commit(&repo.main, "a.txt", "side\n");
        sh(&repo.main, &["checkout", "-q", "base"]);
        assert!(!run(&repo.main, &["merge", "side"])
            .unwrap()
            .status
            .success());
        commit(&repo.tree, "b.txt", "x\n");
        assert!(status(&repo.main, &repo.tree).unwrap().base_busy);
        assert!(merge_back(&repo.main, &repo.tree).is_err());
    }

    #[test]
    fn a_base_stopped_in_a_rebase_counts_as_busy() {
        let repo = repo();
        sh(&repo.main, &["branch", "onto"]);
        commit(&repo.main, "a.txt", "main\n");
        sh(&repo.main, &["checkout", "-q", "onto"]);
        commit(&repo.main, "a.txt", "onto\n");
        sh(&repo.main, &["checkout", "-q", "base"]);
        assert!(!run(&repo.main, &["rebase", "onto"])
            .unwrap()
            .status
            .success());
        commit(&repo.tree, "b.txt", "x\n");
        let state = status(&repo.main, &repo.tree).unwrap();
        assert_eq!(state.base, "base");
        assert!(state.base_busy);
        assert!(state.base_checkout.is_some());
        assert!(merge_back(&repo.main, &repo.tree).is_err());
        assert!(!base_has(&repo, "b.txt"));
    }

    #[test]
    fn a_worktree_mid_rebase_cannot_merge_back() {
        let repo = repo();
        sh(&repo.tree, &["branch", "wt-onto"]);
        commit(&repo.tree, "a.txt", "tree\n");
        sh(&repo.tree, &["checkout", "-q", "wt-onto"]);
        commit(&repo.tree, "a.txt", "onto\n");
        sh(&repo.tree, &["checkout", "-q", "mc/work"]);
        assert!(!run(&repo.tree, &["rebase", "wt-onto"])
            .unwrap()
            .status
            .success());
        assert!(merge_back(&repo.main, &repo.tree).is_err());
        assert!(!base_has(&repo, "b.txt"));
    }

    #[test]
    fn a_no_commit_merge_option_cannot_leave_a_half_merge() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        commit(&repo.main, "c.txt", "y\n");
        sh(
            &repo.main,
            &["config", "branch.base.mergeOptions", "--no-commit"],
        );
        assert_eq!(merge_back(&repo.main, &repo.tree).unwrap().kind, "merged");
        assert!(!in_progress(&repo.main));
        assert!(base_has(&repo, "b.txt"));
    }

    #[test]
    fn autostash_cannot_reapply_edits_onto_a_merge() {
        let repo = repo();
        commit(&repo.tree, "a.txt", "tree\n");
        sh(&repo.main, &["config", "merge.autostash", "true"]);
        fs::write(repo.main.join("a.txt"), "unsaved\n").unwrap();
        assert!(merge_back(&repo.main, &repo.tree).is_err());
        assert_eq!(
            fs::read_to_string(repo.main.join("a.txt")).unwrap(),
            "unsaved\n"
        );
        assert!(!in_progress(&repo.main));
    }

    #[test]
    fn another_sessions_merge_is_never_aborted() {
        let repo = repo();
        sh(&repo.main, &["branch", "side"]);
        commit(&repo.main, "a.txt", "main\n");
        sh(&repo.main, &["checkout", "-q", "side"]);
        commit(&repo.main, "a.txt", "side\n");
        sh(&repo.main, &["checkout", "-q", "base"]);
        commit(&repo.tree, "b.txt", "x\n");
        let state = status(&repo.main, &repo.tree).unwrap();
        assert!(!run(&repo.main, &["merge", "side"])
            .unwrap()
            .status
            .success());
        assert!(merge_in_checkout(&repo.main, &state).is_err());
        assert!(in_progress(&repo.main));
    }

    #[test]
    fn a_checkout_that_changed_branch_is_left_alone() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        let state = status(&repo.main, &repo.tree).unwrap();
        sh(&repo.main, &["checkout", "-q", "-b", "elsewhere"]);
        assert!(merge_in_checkout(&repo.main, &state).is_err());
        assert!(!repo.main.join("b.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_merge_hook_is_undone() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        commit(&repo.main, "c.txt", "y\n");
        let hooks = repo.main.join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-merge-commit");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        let mut mode = fs::metadata(&hook).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
        fs::set_permissions(&hook, mode).unwrap();
        assert!(merge_back(&repo.main, &repo.tree).is_err());
        assert!(!in_progress(&repo.main));
        assert_eq!(git(&repo.main, &["status", "--porcelain"]).unwrap(), "");
    }

    #[test]
    fn deleting_a_merged_branch_clears_its_saved_base() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        merge_back(&repo.main, &repo.tree).unwrap();
        sh(
            &repo.main,
            &["worktree", "remove", repo.tree.to_str().unwrap()],
        );
        delete_merged_branch(&repo.main, "mc/work", "base").unwrap();
        assert!(git(
            &repo.main,
            &["config", "--get", "branch.mc/work.monocodeBase"]
        )
        .is_err());
    }

    #[test]
    fn deletes_only_a_merged_branch_with_no_checkout() {
        let repo = repo();
        commit(&repo.tree, "b.txt", "x\n");
        assert!(delete_merged_branch(&repo.main, "mc/work", "base").is_err());
        sh(
            &repo.main,
            &["worktree", "remove", repo.tree.to_str().unwrap()],
        );
        assert!(delete_merged_branch(&repo.main, "mc/work", "base").is_err());
        sh(&repo.main, &["merge", "-q", "--no-edit", "mc/work"]);
        delete_merged_branch(&repo.main, "mc/work", "base").unwrap();
        assert!(!has_branch(&repo.main, "mc/work"));
    }

    #[test]
    fn the_main_checkout_cannot_merge_back() {
        let repo = repo();
        assert!(status(&repo.main, &repo.main).is_err());
    }
}
