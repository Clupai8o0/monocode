//! Fork: one turn's changes, and putting the workspace back as it was before it.
//!
//! Upstream's card only ever shows the latest turn, but it saves every finished
//! turn in `<session dir>/turns/<id>.json` with Git snapshots either side. This
//! reads those. Restore only touches files this session's turns changed, and
//! saves the current state to a ref first, so nothing it overwrites is lost.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedTurn {
    id: String,
    before: Option<String>,
    after: Option<String>,
    head: Option<String>,
    #[serde(default)]
    shared: bool,
    #[serde(default)]
    edited: BTreeSet<String>,
}

#[derive(Clone, Deserialize)]
struct SavedTurn {
    cwd: String,
    turn: RecordedTurn,
}

#[derive(Deserialize)]
struct SavedReview {
    #[serde(default)]
    cwd: String,
    active: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFile {
    pub relative: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    pub files: Vec<TurnFile>,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFileDiff {
    pub relative: String,
    pub status: String,
    pub original: String,
    pub current: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFile {
    pub relative: String,
    /// "restore" puts an older version back; "remove" deletes a file the turn added.
    pub action: String,
    /// The file changed after this session last wrote it, so the restore would
    /// overwrite someone else's edit.
    pub edited_since: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub files: Vec<RestoreFile>,
    /// Why restoring isn't possible right now, in words for the person.
    pub blocked: Option<String>,
    /// Commits were made since the turn. They stay; files just show as changed.
    pub head_moved: bool,
}

fn run(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("PATH", crate::harness::cached_gui_search_path())
        .output()
        .map_err(|e| e.to_string())
}

fn git_bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = run(root, args)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&git_bytes(root, args)?)
        .trim()
        .to_string())
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid turn id".into());
    }
    Ok(())
}

fn load_turn(dir: &Path, id: &str) -> Result<SavedTurn, String> {
    valid_id(id)?;
    let path = dir.join("turns").join(format!("{id}.json"));
    let bytes = std::fs::read(path).map_err(|_| "This turn has no recorded changes".to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn load_all_turns(dir: &Path) -> Vec<SavedTurn> {
    let Ok(entries) = std::fs::read_dir(dir.join("turns")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect()
}

fn snapshots(turn: &RecordedTurn) -> Result<(&str, &str), String> {
    match (turn.before.as_deref(), turn.after.as_deref()) {
        (Some(before), Some(after)) => Ok((before, after)),
        _ => Err("This turn's snapshots are incomplete".into()),
    }
}

/// One side of a file in a snapshot: its mode and blob, when it exists there.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Change {
    relative: String,
    before: Option<(String, String)>,
    after: Option<(String, String)>,
    status: String,
    additions: u64,
    deletions: u64,
}

fn diff_args<'a>(extra: &'a str, before: &'a str, after: &'a str) -> [&'a str; 12] {
    [
        "diff",
        "--relative",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-abbrev",
        "-z",
        extra,
        before,
        after,
        "--",
        ".",
    ]
}

/// Paths are relative to the session's folder, which can be below the Git root.
fn changes_between(root: &Path, before: &str, after: &str) -> Result<Vec<Change>, String> {
    let raw = git_bytes(root, &diff_args("--raw", before, after))?;
    let numstat = git_bytes(root, &diff_args("--numstat", before, after))?;
    let mut stats = BTreeMap::new();
    for row in numstat
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let mut fields = row.splitn(3, |byte| *byte == b'\t');
        let count = |field: Option<&[u8]>| {
            field
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .and_then(|text| text.parse::<u64>().ok())
                .unwrap_or(0)
        };
        let additions = count(fields.next());
        let deletions = count(fields.next());
        if let Some(path) = fields.next() {
            stats.insert(path.to_vec(), (additions, deletions));
        }
    }
    let mut records = raw.split(|byte| *byte == 0).filter(|row| !row.is_empty());
    let mut out = Vec::new();
    while let Some(header) = records.next() {
        let path = records.next().ok_or("Invalid checkpoint path")?;
        let header = std::str::from_utf8(header).map_err(|e| e.to_string())?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 5 || !fields[0].starts_with(':') {
            return Err("Invalid checkpoint file status".into());
        }
        let side =
            |mode: &str, oid: &str| (mode != "000000").then(|| (mode.to_string(), oid.to_string()));
        let (additions, deletions) = stats.remove(path).unwrap_or((0, 0));
        out.push(Change {
            relative: String::from_utf8(path.to_vec()).map_err(|e| e.to_string())?,
            before: side(&fields[0][1..], fields[2]),
            after: side(fields[1], fields[3]),
            status: match fields[4] {
                "A" => "added",
                "D" => "deleted",
                _ => "modified",
            }
            .into(),
            additions,
            deletions,
        });
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

/// A shared checkout's snapshots can hold another session's writes, so only
/// files with edit evidence from this session count as this turn's.
fn own_changes(root: &Path, turn: &RecordedTurn) -> Result<Vec<Change>, String> {
    let (before, after) = snapshots(turn)?;
    Ok(changes_between(root, before, after)?
        .into_iter()
        .filter(|change| !turn.shared || turn.edited.contains(&change.relative))
        .collect())
}

pub fn turn_changes(dir: &Path, id: &str) -> Result<TurnChanges, String> {
    let saved = load_turn(dir, id)?;
    let files: Vec<TurnFile> = own_changes(Path::new(&saved.cwd), &saved.turn)?
        .into_iter()
        .map(|change| TurnFile {
            relative: change.relative,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
        })
        .collect();
    Ok(TurnChanges {
        additions: files.iter().map(|file| file.additions).sum(),
        deletions: files.iter().map(|file| file.deletions).sum(),
        files,
    })
}

fn read_side(root: &Path, side: Option<&(String, String)>) -> Result<(String, bool, bool), String> {
    let Some((_, oid)) = side else {
        return Ok((String::new(), false, false));
    };
    let size: u64 = git(root, &["cat-file", "-s", oid])?
        .parse()
        .unwrap_or(u64::MAX);
    if size > MAX_DIFF_BYTES {
        return Ok((String::new(), false, true));
    }
    let bytes = git_bytes(root, &["cat-file", "blob", oid])?;
    if bytes.contains(&0) {
        return Ok((String::new(), true, false));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, false, false)),
        Err(_) => Ok((String::new(), true, false)),
    }
}

pub fn turn_file_diff(dir: &Path, id: &str, relative: &str) -> Result<TurnFileDiff, String> {
    let saved = load_turn(dir, id)?;
    let root = Path::new(&saved.cwd);
    let change = own_changes(root, &saved.turn)?
        .into_iter()
        .find(|change| change.relative == relative)
        .ok_or("This file did not change in this turn")?;
    let (original, old_binary, old_large) = read_side(root, change.before.as_ref())?;
    let (current, new_binary, new_large) = read_side(root, change.after.as_ref())?;
    let binary = old_binary || new_binary;
    let too_large = old_large || new_large;
    let hide = binary || too_large;
    Ok(TurnFileDiff {
        relative: change.relative,
        status: change.status,
        original: if hide { String::new() } else { original },
        current: if hide { String::new() } else { current },
        binary,
        too_large,
    })
}

/// When a turn finished: its record is written then. A snapshot's commit time
/// only has whole seconds, which can't order two quick turns.
fn finished_at(dir: &Path, id: &str) -> Option<SystemTime> {
    std::fs::metadata(dir.join("turns").join(format!("{id}.json")))
        .ok()?
        .modified()
        .ok()
}

/// Why a restore has to wait: a turn in progress here, or in another session
/// working in the same checkout.
fn busy_reason(dir: &Path, cwd: &str) -> Option<String> {
    let reads = |path: PathBuf| -> Option<SavedReview> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    };
    if reads(dir.join("turn-review.json")).is_some_and(|review| review.active.is_some()) {
        return Some("This session is still working. Wait for it to finish.".into());
    }
    let parent = dir.parent()?;
    for entry in std::fs::read_dir(parent).ok()?.flatten() {
        if entry.path() == dir {
            continue;
        }
        if reads(entry.path().join("turn-review.json"))
            .is_some_and(|review| review.active.is_some() && review.cwd == cwd)
        {
            return Some(
                "Another session is working in this checkout. Wait for it to finish.".into(),
            );
        }
    }
    None
}

fn parent_is_symlink(root: &Path, relative: &str) -> bool {
    let mut path = root.to_path_buf();
    let parts: Vec<_> = Path::new(relative).components().collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        path.push(part);
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return true;
        }
    }
    false
}

/// A file's mode and blob on disk right now, or None when it's missing.
fn disk_state(root: &Path, relative: &str) -> Option<(String, String)> {
    let path = root.join(relative);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() {
        return Some(("0".into(), "not-a-file".into()));
    }
    let oid = git(
        root,
        &["hash-object", &format!("--path={relative}"), "--", relative],
    )
    .ok()?;
    Some((file_mode(&meta), oid))
}

#[cfg(unix)]
fn file_mode(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    if meta.permissions().mode() & 0o111 != 0 {
        "100755".into()
    } else {
        "100644".into()
    }
}

// Without an executable bit on disk, only the content can be compared.
#[cfg(not(unix))]
fn file_mode(_meta: &std::fs::Metadata) -> String {
    "100644".into()
}

fn same_state(now: &Option<(String, String)>, then: &Option<(String, String)>) -> bool {
    match (now, then) {
        (Some(now), Some(then)) => now.1 == then.1 && (cfg!(not(unix)) || now.0 == then.0),
        (None, None) => true,
        _ => false,
    }
}

struct RestorePlan {
    saved: SavedTurn,
    files: Vec<(RestoreFile, Option<(String, String)>)>,
    blocked: Option<String>,
    head_moved: bool,
}

fn plan_restore(dir: &Path, id: &str) -> Result<RestorePlan, String> {
    let saved = load_turn(dir, id)?;
    let root = PathBuf::from(&saved.cwd);
    let (before, _) = snapshots(&saved.turn)?;
    let since = finished_at(dir, id).ok_or("This turn has no recorded changes")?;
    // Every later turn of this session, oldest first: the last one to write a
    // file says what it should still look like.
    let mut later: Vec<(SystemTime, SavedTurn)> = load_all_turns(dir)
        .into_iter()
        .filter(|turn| turn.cwd == saved.cwd && turn.turn.after.is_some())
        .filter_map(|turn| {
            let at = finished_at(dir, &turn.turn.id)?;
            (at >= since).then_some((at, turn))
        })
        .collect();
    later.sort_by_key(|(at, _)| *at);
    let mut last_written: BTreeMap<String, Option<(String, String)>> = BTreeMap::new();
    for (_, turn) in &later {
        for change in own_changes(&root, &turn.turn)? {
            last_written.insert(change.relative, change.after);
        }
    }
    let mut files = Vec::new();
    let mut unsafe_file = None;
    for (relative, wrote) in last_written {
        let then = git(&root, &["ls-tree", before, "--", &relative])
            .ok()
            .and_then(|line| {
                let mut fields = line.split_whitespace();
                let mode = fields.next()?.to_string();
                let _kind = fields.next()?;
                Some((mode, fields.next()?.to_string()))
            });
        let now = disk_state(&root, &relative);
        // Already as it was: nothing to do for this file.
        if same_state(&now, &then) {
            continue;
        }
        if parent_is_symlink(&root, &relative)
            || now.as_ref().is_some_and(|(_, oid)| oid == "not-a-file")
            || then
                .as_ref()
                .is_some_and(|(mode, _)| mode != "100644" && mode != "100755")
        {
            unsafe_file.get_or_insert(relative.clone());
        }
        files.push((
            RestoreFile {
                action: if then.is_some() { "restore" } else { "remove" }.into(),
                edited_since: !same_state(&now, &wrote),
                relative,
            },
            then,
        ));
    }
    let blocked = if saved.turn.shared {
        Some(
            "Another session was working here during this turn, so restoring could undo its work."
                .to_string(),
        )
    } else if let Some(file) = unsafe_file {
        Some(format!(
            "{file} is a link or special file, so it can't be restored safely."
        ))
    } else {
        busy_reason(dir, &saved.cwd)
    };
    let head = git(&root, &["rev-parse", "--verify", "HEAD"]).ok();
    Ok(RestorePlan {
        head_moved: head != saved.turn.head,
        saved,
        files,
        blocked,
    })
}

pub fn restore_preview(dir: &Path, id: &str) -> Result<RestorePreview, String> {
    let plan = plan_restore(dir, id)?;
    Ok(RestorePreview {
        files: plan.files.into_iter().map(|(file, _)| file).collect(),
        blocked: plan.blocked,
        head_moved: plan.head_moved,
    })
}

/// Saves every file about to be overwritten, using a private index so the
/// person's staged changes are left alone.
fn save_current_state(
    root: &Path,
    session: &str,
    id: &str,
    planned: &[&str],
) -> Result<(), String> {
    static NEXT_INDEX: AtomicU64 = AtomicU64::new(0);
    let index = std::env::temp_dir().join(format!(
        "monocode-restore-{}-{}",
        std::process::id(),
        NEXT_INDEX.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let run_private = |args: &[&str]| -> Result<String, String> {
            let mut command = Command::new("git");
            crate::hide_window_console(&mut command);
            let output = command
                .arg("-C")
                .arg(root)
                .args(args)
                .env("GIT_INDEX_FILE", &index)
                .env("GIT_AUTHOR_NAME", "MonoCode")
                .env("GIT_AUTHOR_EMAIL", "checkpoint@monocode.local")
                .env("GIT_COMMITTER_NAME", "MonoCode")
                .env("GIT_COMMITTER_EMAIL", "checkpoint@monocode.local")
                .env("PATH", crate::harness::cached_gui_search_path())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        };
        if git(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
            run_private(&["read-tree", "HEAD"])?;
        } else {
            run_private(&["read-tree", "--empty"])?;
        }
        run_private(&["add", "-A", "--", "."])?;
        // A planned file can have become ignored since; it's still saved.
        for path in planned {
            if root.join(path).exists() {
                run_private(&["add", "--force", "--", path])?;
            }
        }
        let tree = run_private(&["write-tree"])?;
        let commit = run_private(&["commit-tree", &tree, "-m", "Before restoring a turn"])?;
        let reference = format!("refs/monocode/checkpoints/{session}/{id}/before-restore");
        run_private(&["update-ref", &reference, &commit])?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&index);
    result
}

pub fn restore_turn(dir: &Path, session: &str, id: &str) -> Result<RestorePreview, String> {
    let plan = plan_restore(dir, id)?;
    if let Some(reason) = plan.blocked {
        return Err(reason);
    }
    let root = PathBuf::from(&plan.saved.cwd);
    let (before, _) = snapshots(&plan.saved.turn)?;
    if !plan.files.is_empty() {
        let planned: Vec<&str> = plan
            .files
            .iter()
            .map(|(file, _)| file.relative.as_str())
            .collect();
        save_current_state(&root, session, id, &planned)?;
    }
    for (file, then) in &plan.files {
        if then.is_some() {
            git(
                &root,
                &[
                    "restore",
                    "--source",
                    before,
                    "--worktree",
                    "--",
                    &file.relative,
                ],
            )?;
        } else {
            match std::fs::remove_file(root.join(&file.relative)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    restore_preview(dir, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU32;

    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct Repo {
        base: PathBuf,
        root: PathBuf,
        dir: PathBuf,
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn sh(root: &Path, args: &[&str]) -> String {
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
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repo() -> Repo {
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("mc-turn-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("repo");
        let dir = base.join("sessions").join("s1");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(dir.join("turns")).unwrap();
        sh(&root, &["init", "-q", "-b", "main"]);
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        sh(&root, &["add", "-A"]);
        sh(&root, &["commit", "-qm", "start"]);
        Repo { base, root, dir }
    }

    fn snapshot(repo: &Repo) -> String {
        save_current_state(&repo.root, "snap", "x", &[]).unwrap();
        sh(
            &repo.root,
            &[
                "rev-parse",
                "refs/monocode/checkpoints/snap/x/before-restore",
            ],
        )
    }

    fn head(repo: &Repo) -> String {
        sh(&repo.root, &["rev-parse", "HEAD"])
    }

    fn save(repo: &Repo, id: &str, before: &str, after: &str, shared: bool, edited: &[&str]) {
        let root = fs::canonicalize(&repo.root).unwrap();
        let json = serde_json::json!({
            "cwd": root.to_string_lossy(),
            "repo": root.to_string_lossy(),
            "turn": {
                "id": id,
                "before": before,
                "after": after,
                "head": head(repo),
                "shared": shared,
                "error": null,
                "dismissed": [],
                "edited": edited,
            }
        });
        fs::write(
            repo.dir.join("turns").join(format!("{id}.json")),
            json.to_string(),
        )
        .unwrap();
    }

    fn write_review(dir: &Path, cwd: &Path, active: bool) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("turn-review.json"),
            serde_json::json!({
                "cwd": fs::canonicalize(cwd).unwrap().to_string_lossy(),
                "active": if active { serde_json::json!({"id": "t"}) } else { serde_json::Value::Null },
            })
            .to_string(),
        )
        .unwrap();
    }

    /// Records a turn that edits a.txt and adds new.txt.
    fn one_turn(repo: &Repo) -> (String, String) {
        let before = snapshot(repo);
        fs::write(repo.root.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        fs::write(repo.root.join("new.txt"), "fresh\n").unwrap();
        let after = snapshot(repo);
        save(repo, "t1", &before, &after, false, &[]);
        (before, after)
    }

    #[test]
    fn lists_one_turns_files_and_totals() {
        let repo = repo();
        one_turn(&repo);
        let changes = turn_changes(&repo.dir, "t1").unwrap();
        assert_eq!(changes.files.len(), 2);
        assert_eq!(changes.files[0].relative, "a.txt");
        assert_eq!(changes.files[0].status, "modified");
        assert_eq!(changes.files[1].status, "added");
        assert_eq!((changes.additions, changes.deletions), (3, 1));
    }

    #[test]
    fn a_shared_turn_only_lists_files_it_edited() {
        let repo = repo();
        let before = snapshot(&repo);
        fs::write(repo.root.join("mine.txt"), "m\n").unwrap();
        fs::write(repo.root.join("theirs.txt"), "t\n").unwrap();
        let after = snapshot(&repo);
        save(&repo, "t1", &before, &after, true, &["mine.txt"]);
        let changes = turn_changes(&repo.dir, "t1").unwrap();
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].relative, "mine.txt");
    }

    #[test]
    fn reads_both_sides_of_a_file() {
        let repo = repo();
        one_turn(&repo);
        let diff = turn_file_diff(&repo.dir, "t1", "a.txt").unwrap();
        assert_eq!(diff.original, "one\ntwo\n");
        assert_eq!(diff.current, "one\nTWO\nthree\n");
        assert!(!diff.binary && !diff.too_large);
        assert!(turn_file_diff(&repo.dir, "t1", "other.txt").is_err());
    }

    #[test]
    fn binary_and_huge_files_show_no_text() {
        let repo = repo();
        let before = snapshot(&repo);
        fs::write(repo.root.join("b.bin"), [0u8, 1, 2]).unwrap();
        fs::write(repo.root.join("big.txt"), "x".repeat(3 * 1024 * 1024)).unwrap();
        let after = snapshot(&repo);
        save(&repo, "t1", &before, &after, false, &[]);
        let binary = turn_file_diff(&repo.dir, "t1", "b.bin").unwrap();
        assert!(binary.binary);
        assert_eq!(binary.current, "");
        let big = turn_file_diff(&repo.dir, "t1", "big.txt").unwrap();
        assert!(big.too_large);
        assert_eq!(big.current, "");
    }

    #[test]
    fn rejects_a_turn_id_that_walks_out_of_the_folder() {
        let repo = repo();
        assert!(turn_changes(&repo.dir, "../../etc").is_err());
    }

    #[test]
    fn preview_lists_files_without_changing_anything() {
        let repo = repo();
        one_turn(&repo);
        let preview = restore_preview(&repo.dir, "t1").unwrap();
        assert_eq!(preview.blocked, None);
        assert_eq!(preview.files.len(), 2);
        assert_eq!(preview.files[0].action, "restore");
        assert_eq!(preview.files[1].action, "remove");
        assert!(!preview.files[0].edited_since);
        assert!(repo.root.join("new.txt").exists());
    }

    #[test]
    fn restore_puts_back_edits_and_removes_added_files() {
        let repo = repo();
        one_turn(&repo);
        let after = restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert!(after.files.is_empty());
        assert_eq!(
            fs::read_to_string(repo.root.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
        assert!(!repo.root.join("new.txt").exists());
    }

    #[test]
    fn restore_saves_what_it_overwrites_and_leaves_the_index_alone() {
        let repo = repo();
        one_turn(&repo);
        sh(&repo.root, &["add", "new.txt"]);
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        let saved = sh(
            &repo.root,
            &[
                "show",
                "refs/monocode/checkpoints/s1/t1/before-restore:a.txt",
            ],
        );
        assert_eq!(saved, "one\nTWO\nthree");
        assert!(sh(&repo.root, &["diff", "--cached", "--name-only"]).contains("new.txt"));
    }

    #[test]
    fn restore_never_touches_files_from_outside_the_session() {
        let repo = repo();
        one_turn(&repo);
        fs::write(repo.root.join("other.txt"), "mine\n").unwrap();
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert_eq!(
            fs::read_to_string(repo.root.join("other.txt")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn a_later_outside_edit_is_flagged_in_the_preview() {
        let repo = repo();
        one_turn(&repo);
        fs::write(repo.root.join("a.txt"), "someone else\n").unwrap();
        let preview = restore_preview(&repo.dir, "t1").unwrap();
        let file = preview
            .files
            .iter()
            .find(|file| file.relative == "a.txt")
            .unwrap();
        assert!(file.edited_since);
    }

    #[test]
    fn restoring_an_older_turn_includes_later_turns_files() {
        let repo = repo();
        one_turn(&repo);
        let before2 = snapshot(&repo);
        fs::write(repo.root.join("later.txt"), "later\n").unwrap();
        let after2 = snapshot(&repo);
        save(&repo, "t2", &before2, &after2, false, &[]);
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert!(!repo.root.join("later.txt").exists());
        assert!(!repo.root.join("new.txt").exists());
    }

    #[test]
    fn a_shared_turn_cannot_be_restored() {
        let repo = repo();
        let before = snapshot(&repo);
        fs::write(repo.root.join("mine.txt"), "m\n").unwrap();
        let after = snapshot(&repo);
        save(&repo, "t1", &before, &after, true, &["mine.txt"]);
        assert!(restore_preview(&repo.dir, "t1").unwrap().blocked.is_some());
        assert!(restore_turn(&repo.dir, "s1", "t1").is_err());
        assert!(repo.root.join("mine.txt").exists());
    }

    #[test]
    fn a_turn_in_progress_blocks_restore_here_and_in_other_sessions() {
        let repo = repo();
        one_turn(&repo);
        write_review(&repo.dir, &repo.root, true);
        assert!(restore_turn(&repo.dir, "s1", "t1").is_err());
        write_review(&repo.dir, &repo.root, false);
        let other = repo.dir.parent().unwrap().join("s2");
        write_review(&other, &repo.root, true);
        assert!(restore_turn(&repo.dir, "s1", "t1").is_err());
        assert!(repo.root.join("new.txt").exists());
        write_review(&other, &repo.root, false);
        assert!(restore_turn(&repo.dir, "s1", "t1").is_ok());
    }

    #[test]
    fn commits_since_the_turn_are_reported_and_kept() {
        let repo = repo();
        one_turn(&repo);
        sh(&repo.root, &["add", "-A"]);
        sh(&repo.root, &["commit", "-qm", "agent commit"]);
        let commit = head(&repo);
        let preview = restore_preview(&repo.dir, "t1").unwrap();
        // The saved head is the commit at save time, before this one.
        assert!(preview.head_moved);
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert_eq!(head(&repo), commit);
        assert_eq!(
            fs::read_to_string(repo.root.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn a_file_ignored_since_is_saved_before_it_is_removed() {
        let repo = repo();
        one_turn(&repo);
        fs::write(repo.root.join("new.txt"), "later edit\n").unwrap();
        fs::write(repo.root.join(".gitignore"), "new.txt\n").unwrap();
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert!(!repo.root.join("new.txt").exists());
        assert_eq!(
            sh(
                &repo.root,
                &[
                    "show",
                    "refs/monocode/checkpoints/s1/t1/before-restore:new.txt"
                ],
            ),
            "later edit"
        );
    }

    #[test]
    fn a_session_in_a_subfolder_restores_the_right_files() {
        let repo = repo();
        let sub = repo.root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("s.txt"), "old\n").unwrap();
        sh(&repo.root, &["add", "-A"]);
        sh(&repo.root, &["commit", "-qm", "sub"]);
        let before = snapshot(&repo);
        fs::write(sub.join("s.txt"), "new\n").unwrap();
        fs::write(repo.root.join("a.txt"), "outside the session folder\n").unwrap();
        let after = snapshot(&repo);
        let root = fs::canonicalize(&sub).unwrap();
        let json = serde_json::json!({
            "cwd": root.to_string_lossy(),
            "turn": { "id": "t1", "before": before, "after": after, "head": head(&repo) },
        });
        fs::write(repo.dir.join("turns/t1.json"), json.to_string()).unwrap();
        let changes = turn_changes(&repo.dir, "t1").unwrap();
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].relative, "s.txt");
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert_eq!(fs::read_to_string(sub.join("s.txt")).unwrap(), "old\n");
        assert_eq!(
            fs::read_to_string(repo.root.join("a.txt")).unwrap(),
            "outside the session folder\n"
        );
    }

    #[test]
    fn a_quick_earlier_turn_is_left_out_of_a_later_restore() {
        let repo = repo();
        one_turn(&repo);
        // Same second, later finish: restoring t2 must not undo t1.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let before = snapshot(&repo);
        fs::write(repo.root.join("second.txt"), "s\n").unwrap();
        let after = snapshot(&repo);
        save(&repo, "t2", &before, &after, false, &[]);
        restore_turn(&repo.dir, "s1", "t2").unwrap();
        assert!(!repo.root.join("second.txt").exists());
        assert!(repo.root.join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_change_to_only_the_executable_bit_is_restored() {
        use std::os::unix::fs::PermissionsExt;
        let repo = repo();
        let before = snapshot(&repo);
        let path = repo.root.join("a.txt");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let after = snapshot(&repo);
        save(&repo, "t1", &before, &after, false, &[]);
        assert_eq!(restore_preview(&repo.dir, "t1").unwrap().files.len(), 1);
        restore_turn(&repo.dir, "s1", "t1").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_parent_blocks_restore() {
        let repo = repo();
        let before = snapshot(&repo);
        fs::create_dir(repo.root.join("real")).unwrap();
        fs::write(repo.root.join("real/f.txt"), "x\n").unwrap();
        let after = snapshot(&repo);
        save(&repo, "t1", &before, &after, false, &[]);
        fs::remove_dir_all(repo.root.join("real")).unwrap();
        let outside = repo.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("f.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink(&outside, repo.root.join("real")).unwrap();
        assert!(restore_preview(&repo.dir, "t1").unwrap().blocked.is_some());
        assert!(restore_turn(&repo.dir, "s1", "t1").is_err());
        assert_eq!(fs::read_to_string(outside.join("f.txt")).unwrap(), "keep\n");
    }
}
