//! Fork feature: moving a session between machines, the Mac's half. The rules
//! and shapes are in src/fork/sessionMove/sessionMoveProtocol.ts, and
//! host/session-move.ts does the same on a host, so a pack made by either
//! unpacks on the other. The source's worktree and transcript are only read,
//! and never deleted. The app stops and starts a Mac tab itself, so this has no
//! state, stop, start, confirm or restart.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

const CHUNK_BYTES: usize = 3 * 1024 * 1024;
const WRITE_MAX_BASE64: usize = 8 * 1024 * 1024;
const PACK_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const IGNORED_MAX: usize = 100;
const PROJECT_KEY_MAX: usize = 200;
const STALE: Duration = Duration::from_secs(24 * 60 * 60);
const GIT_TIME: Duration = Duration::from_secs(30);
const GIT_LONG_TIME: Duration = Duration::from_secs(10 * 60);
const ACCOUNT_DIRS: [&str; 3] = [".claude", ".claude-exec", ".claude-cx"];
const SEARCH_DEPTH: usize = 3;
const SEARCH_MAX: usize = 400;
const BUNDLE_FILE: &str = "commits.bundle";
const PATCH_FILE: &str = "changes.patch";
const UNTRACKED_DIR: &str = "untracked";
const CONVO_DIR: &str = "convo";
const SEARCH_SKIP: [&str; 7] = [
    "node_modules",
    ".git",
    ".claude",
    "target",
    "dist",
    "build",
    "vendor",
];
const CLIENT: &str = "Client work stays on the Mac";
const NOT_THERE: &str = "This repository is not on that machine";
const NO_REMOTE: &str = "This repository has no remote to match on the other machine";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PackFile {
    path: String,
    size: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    executable: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PackLink {
    path: String,
    target: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    session_id: String,
    head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    source_path: String,
    files: Vec<PackFile>,
    links: Vec<PackLink>,
    #[serde(default)]
    ignored: Vec<String>,
    #[serde(default)]
    ignored_more: u64,
}

/// What this machine made for a move, so a failure can remove just that.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Made {
    repo: Option<String>,
    session_id: Option<String>,
    worktree: Option<String>,
    branch: Option<String>,
    /// Saved before `git worktree add`; it is only this move's if the add worked.
    pending: Option<Pending>,
    account_home: Option<String>,
    /// Files that did not exist before.
    files: Vec<String>,
    /// Files replaced, with where the old copy waits.
    replaced: Vec<Replaced>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Pending {
    worktree: String,
    branch: String,
    head: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct Replaced {
    path: String,
    backup: String,
}

struct Env {
    home: PathBuf,
    staging_root: PathBuf,
    account_home: PathBuf,
}

#[tauri::command]
pub async fn fork_session_move(
    app: tauri::AppHandle,
    op: String,
    params: Value,
) -> Result<Value, String> {
    let account = params
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let account_home =
        crate::provider_session_transfer::provider_home(&app, "claude", account.as_deref())?;
    let staging_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("session-move");
    let home = PathBuf::from(crate::dirs_home().ok_or("Could not find the home folder")?);
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env {
            home,
            staging_root,
            account_home,
        };
        handle(&env, &op, &params)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn handle(env: &Env, op: &str, params: &Value) -> Result<Value, String> {
    match op {
        "inspect" => inspect(env, params),
        "pack" => pack(env, params),
        "read" => read_piece(env, params),
        "check" => check(env, params),
        "write" => write_piece(env, params),
        "unpackCode" => unpack_code(env, params),
        "unpackConversation" => unpack_conversation(env, params),
        "undo" => undo(env, params),
        "done" => done(env, params),
        _ => Err("Unsupported session move step".into()),
    }
}

// ---- the protocol's checks ----

/// Case-insensitive like the Mac's disk: upwork work other than Panoptic.
fn is_client_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let lower = lower.trim_end_matches('/');
    let marker = "/projects/upwork";
    let mut from = 0;
    while let Some(at) = lower[from..].find(marker) {
        let rest = &lower[from + at + marker.len()..];
        if rest.is_empty() {
            return true;
        }
        if let Some(rest) = rest.strip_prefix('/') {
            if !(rest == "panoptic" || rest.starts_with("panoptic/")) {
                return true;
            }
        }
        from += at + marker.len();
    }
    false
}

/// `git@github.com:a/b.git`, `https://github.com/a/b` and `ssh://...` as one.
fn normalize_remote_url(url: &str) -> String {
    let text = url.trim().trim_end_matches('/');
    let end = text.len().saturating_sub(4);
    let text = match text.get(end..) {
        Some(tail) if tail.eq_ignore_ascii_case(".git") => &text[..end],
        _ => text,
    };
    if let Some((scheme, rest)) = text.split_once("://") {
        let good = scheme.starts_with(|c: char| c.is_ascii_alphabetic());
        if let (true, Some((authority, path))) = (good, rest.split_once('/')) {
            let host = authority.rsplit('@').next().unwrap_or(authority);
            let host = match host.rsplit_once(':') {
                Some((name, port)) if port.bytes().all(|b| b.is_ascii_digit()) => name,
                _ => host,
            };
            return format!("{}/{}", host.to_ascii_lowercase(), path);
        }
        return text.to_string();
    }
    if let Some((before, path)) = text.split_once(':') {
        if !before.contains('/') {
            let host = before.rsplit('@').next().unwrap_or(before);
            return format!(
                "{}/{}",
                host.to_ascii_lowercase(),
                path.trim_start_matches('/')
            );
        }
    }
    text.to_string()
}

fn segments_ok(segments: &[&str]) -> bool {
    !segments.is_empty()
        && segments.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && !part.eq_ignore_ascii_case(".git")
                && !part.contains('\\')
                && !part.contains('\0')
        })
}

/// A path inside a pack, for this session only.
fn pack_path_ok(path: &str, session_id: &str) -> bool {
    if path.starts_with('/') {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if !segments_ok(&segments) {
        return false;
    }
    if path == BUNDLE_FILE || path == PATCH_FILE {
        return true;
    }
    if segments[0] == UNTRACKED_DIR {
        return segments.len() > 1;
    }
    if segments[0] != CONVO_DIR || segments.len() < 3 {
        return false;
    }
    if segments[1] == "session" {
        return (segments.len() == 3 && segments[2] == format!("{session_id}.jsonl"))
            || (segments.len() > 3 && segments[2] == session_id);
    }
    segments[1] == "history" && segments.len() > 3 && segments[2] == session_id
}

fn session_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn commit_ok(head: &str) -> bool {
    (head.len() == 40 || head.len() == 64)
        && head
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_manifest(value: Option<&Value>) -> Result<Manifest, String> {
    let bad = "The move's file list is not one this machine reads";
    let manifest: Manifest =
        serde_json::from_value(value.cloned().ok_or(bad)?).map_err(|_| bad.to_string())?;
    if manifest.version != 1 {
        return Err(bad.into());
    }
    if !session_id_ok(&manifest.session_id) {
        return Err("Invalid session id".into());
    }
    if !commit_ok(&manifest.head) {
        return Err("Invalid commit id".into());
    }
    for file in &manifest.files {
        let sha_ok = file.sha256.len() == 64 && file.sha256.bytes().all(|b| b.is_ascii_hexdigit());
        if !pack_path_ok(&file.path, &manifest.session_id) || !sha_ok {
            return Err(format!("Refused a file in the move: {}", file.path));
        }
    }
    for link in &manifest.links {
        if !link.path.starts_with("untracked/") || !pack_path_ok(&link.path, &manifest.session_id) {
            return Err(format!("Refused a link in the move: {}", link.path));
        }
    }
    Ok(manifest)
}

// ---- small helpers ----

fn text_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {name}"))
}

fn session_param(params: &Value) -> Result<String, String> {
    let id = text_param(params, "sessionId")?;
    if !session_id_ok(id) {
        return Err("Invalid session id".into());
    }
    Ok(id.to_string())
}

fn move_folder(env: &Env, params: &Value) -> Result<PathBuf, String> {
    let id = text_param(params, "moveId")?;
    let ok =
        (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !ok {
        return Err("Invalid move id".into());
    }
    Ok(env.staging_root.join(id))
}

fn name_param(params: &Value) -> Result<String, String> {
    let name = text_param(params, "name")?;
    let first_ok = name
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_');
    let ok = first_ok
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        && !name.contains("..")
        && !name.to_ascii_lowercase().ends_with(".lock");
    if !ok {
        return Err("Invalid session name".into());
    }
    Ok(name.to_string())
}

fn urls_param(params: &Value) -> Vec<String> {
    params
        .get("urls")
        .and_then(Value::as_array)
        .map(|urls| {
            urls.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

fn io_text(error: std::io::Error) -> String {
    error.to_string()
}

fn project_key(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn lexists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

struct GitOut {
    ok: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

fn git(cwd: &Path, args: &[&str]) -> Result<GitOut, String> {
    git_within(cwd, args, GIT_TIME)
}

/// Killed at the deadline, as the host does: a hung fetch must not strand a stopped move.
fn git_within(cwd: &Path, args: &[&str], limit: Duration) -> Result<GitOut, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own group, so the deadline also ends what it started (ssh for a fetch).
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("git failed to start: {e}"))?;
    // Read as it runs, so a full pipe never blocks it.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let started = std::time::Instant::now();
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().map_err(io_text)? {
            break (Some(status), false);
        }
        if started.elapsed() >= limit {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if timed_out {
        // Not waited on: anything that slipped the group could hold the pipes open.
        return Ok(GitOut {
            ok: false,
            timed_out,
            stdout: String::new(),
            stderr: format!("git {} timed out", args.first().copied().unwrap_or("")),
        });
    }
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    Ok(GitOut {
        ok: status.is_some_and(|status| status.success()),
        timed_out,
        stdout,
        stderr,
    })
}

fn git_out(cwd: &Path, args: &[&str]) -> Result<String, String> {
    git_out_within(cwd, args, GIT_TIME)
}

fn git_out_within(cwd: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let result = git_within(cwd, args, limit)?;
    if result.ok {
        return Ok(result.stdout);
    }
    Err(git_error(&result, args))
}

fn git_error(result: &GitOut, args: &[&str]) -> String {
    let last: String = result
        .stderr
        .trim()
        .lines()
        .last()
        .unwrap_or("")
        .chars()
        .take(300)
        .collect();
    if last.is_empty() {
        return format!("git {} failed", args.first().copied().unwrap_or(""));
    }
    last
}

/// Makes the parents of `root/rel`, refusing any parent that is a link, so a
/// link carried earlier cannot lead a write outside `root`.
fn safe_target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut at = root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(info) if info.is_dir() => {}
            Ok(_) => return Err(format!("Refused a path through a link: {rel}")),
            Err(_) => fs::create_dir(&at).map_err(io_text)?,
        }
    }
    Ok(at.join(parts[parts.len() - 1]))
}

fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(io_text)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(io_text)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        size += read as u64;
    }
    let hex: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((hex, size))
}

fn save_made(folder: &Path, made: &Made) -> Result<(), String> {
    fs::create_dir_all(folder).map_err(io_text)?;
    let text = serde_json::to_string(made).map_err(|e| e.to_string())?;
    // Replaced whole, so a crash never leaves half a record to be read as none.
    let temp = folder.join("made.json.tmp");
    fs::write(&temp, text).map_err(io_text)?;
    fs::rename(&temp, folder.join("made.json")).map_err(io_text)
}

/// Nothing made yet when there is no record; one it can't read is an error.
fn load_made(folder: &Path) -> Result<Made, String> {
    match fs::read_to_string(folder.join("made.json")) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Made::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn drop_stale(env: &Env) {
    let Ok(entries) = fs::read_dir(&env.staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        // An unfinished move's record is what its undo needs, however old.
        if lexists(&entry.path().join("made.json")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|info| info.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|age| age > STALE);
        if old {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

// ---- finding things ----

/// Where the conversation is: its account folder and its project folder.
struct Transcript {
    home: PathBuf,
    project: PathBuf,
}

/// The selected account and every Claude login, each once.
fn account_homes(env: &Env) -> Vec<PathBuf> {
    let mut homes: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let all = std::iter::once(env.account_home.clone())
        .chain(ACCOUNT_DIRS.iter().map(|dir| env.home.join(dir)));
    for home in all {
        let real = home.canonicalize().unwrap_or_else(|_| home.clone());
        if seen.insert(real) {
            homes.push(home);
        }
    }
    homes
}

/// The newest copy in any account, as the host does: after `claude-acct` moved
/// a conversation between accounts, both can hold it, and the older one is
/// missing the latest turns.
fn find_transcript(env: &Env, cwd: &str, session_id: &str) -> Option<Transcript> {
    let wanted = format!("{session_id}.jsonl");
    let homes = account_homes(env);
    let mut best: Option<(SystemTime, Transcript)> = None;
    let consider = |best: &mut Option<(SystemTime, Transcript)>, home: &Path, project: PathBuf| {
        let Ok(at) = fs::metadata(project.join(&wanted)).and_then(|info| info.modified()) else {
            return;
        };
        if best.as_ref().map_or(true, |(seen, _)| at > *seen) {
            *best = Some((
                at,
                Transcript {
                    home: home.to_path_buf(),
                    project,
                },
            ));
        }
    };
    for home in &homes {
        consider(
            &mut best,
            home,
            home.join("projects").join(project_key(cwd)),
        );
    }
    if best.is_none() {
        for home in &homes {
            let Ok(entries) = fs::read_dir(home.join("projects")) else {
                continue;
            };
            for entry in entries.flatten() {
                consider(&mut best, home, entry.path());
            }
        }
    }
    best.map(|(_, found)| found)
}

fn account_name(account_home: &Path) -> &'static str {
    let real = account_home
        .canonicalize()
        .unwrap_or_else(|_| account_home.to_path_buf());
    match real.file_name().and_then(|name| name.to_str()) {
        Some(".claude") => "main",
        Some(".claude-exec") | Some(".claude-cx") => "cx",
        _ => "other",
    }
}

fn remotes_of(repo: &Path) -> Vec<(String, String)> {
    let Ok(result) = git(repo, &["config", "--get-regexp", "^remote\\..*\\.url$"]) else {
        return Vec::new();
    };
    if !result.ok {
        return Vec::new();
    }
    result
        .stdout
        .lines()
        .filter_map(|line| {
            let (key, url) = line.trim().split_once(char::is_whitespace)?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            Some((name.to_string(), url.trim().to_string()))
        })
        .collect()
}

fn walk_repos(folder: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if found.len() >= SEARCH_MAX {
        return;
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let entries: Vec<fs::DirEntry> = entries.flatten().collect();
    let is_dir = |entry: &fs::DirEntry| entry.file_type().is_ok_and(|kind| kind.is_dir());
    if entries
        .iter()
        .any(|entry| entry.file_name() == ".git" && is_dir(entry))
    {
        if !found.iter().any(|path| path == folder) {
            found.push(folder.to_path_buf());
        }
        return;
    }
    if depth == 0 {
        return;
    }
    for entry in &entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_dir(entry) && !name.starts_with('.') && !SEARCH_SKIP.contains(&name.as_ref()) {
            walk_repos(&entry.path(), depth - 1, found);
        }
    }
}

fn home_relative(path: &str) -> &str {
    path.find("Documents/projects/")
        .map_or(path, |at| &path[at..])
}

enum Found {
    Repo {
        repo: PathBuf,
        remote_name: String,
        matched_url: String,
    },
    Client,
    Missing,
}

enum RepoKind {
    Ok,
    Client,
    Unknown,
}

/// Client when the folder, its real path or its git folder is client work, so
/// a link from elsewhere into a client repository is refused too.
fn repo_kind(repo: &Path) -> RepoKind {
    let real = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    if is_client_path(&path_text(repo)) || is_client_path(&path_text(&real)) {
        return RepoKind::Client;
    }
    let Ok(common) = git_out(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        return RepoKind::Unknown;
    };
    let dir = PathBuf::from(common.trim());
    if dir.as_os_str().is_empty() {
        return RepoKind::Unknown;
    }
    let real_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    if is_client_path(&path_text(&dir)) || is_client_path(&path_text(&real_dir)) {
        return RepoKind::Client;
    }
    RepoKind::Ok
}

fn find_repo(env: &Env, params: &Value, urls: &[String], source_path: &str) -> Found {
    let wanted: Vec<(String, &String)> = urls
        .iter()
        .map(|url| (normalize_remote_url(url), url))
        .collect();
    let mut repos: Vec<PathBuf> = params
        .get("projects")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect::<Vec<PathBuf>>()
        })
        .unwrap_or_default();
    walk_repos(
        &env.home.join("Documents").join("projects"),
        SEARCH_DEPTH,
        &mut repos,
    );
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut hits: Vec<(PathBuf, String, String)> = Vec::new();
    let mut client = false;
    for repo in repos {
        if !seen.insert(repo.clone()) {
            continue;
        }
        for (name, url) in remotes_of(&repo) {
            let normal = normalize_remote_url(&url);
            let Some((_, matched)) = wanted.iter().find(|(want, _)| *want == normal) else {
                continue;
            };
            match repo_kind(&repo) {
                RepoKind::Ok => {}
                RepoKind::Client => {
                    client = true;
                    break;
                }
                RepoKind::Unknown => break,
            }
            hits.push((repo.clone(), name, (*matched).clone()));
            break;
        }
    }
    if hits.is_empty() {
        return if client {
            Found::Client
        } else {
            Found::Missing
        };
    }
    let source = home_relative(source_path);
    let at = hits
        .iter()
        .position(|(repo, _, _)| source.starts_with(home_relative(&path_text(repo))))
        .unwrap_or(0);
    let (repo, remote_name, matched_url) = hits.swap_remove(at);
    Found::Repo {
        repo,
        remote_name,
        matched_url,
    }
}

// ---- ops: source ----

fn inspect(env: &Env, params: &Value) -> Result<Value, String> {
    let cwd = text_param(params, "cwd")?;
    let session_id = session_param(params)?;
    let top = git(Path::new(cwd), &["rev-parse", "--show-toplevel"])?;
    if !top.ok {
        return Err("This session's folder is not a git repository".into());
    }
    let root = top.stdout.trim().to_string();
    let common = git_out(
        Path::new(cwd),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    if is_client_path(&root) || is_client_path(common.trim()) {
        return Err(CLIENT.into());
    }
    let found = find_transcript(env, cwd, &session_id);
    let remotes: Vec<Value> = remotes_of(Path::new(&root))
        .into_iter()
        .map(|(name, url)| json!({"name": name, "url": url}))
        .collect();
    Ok(json!({
        "repoRoot": root,
        "remotes": remotes,
        "hasTranscript": found.is_some(),
        "account": account_name(found.as_ref().map_or(&env.account_home, |found| &found.home)),
    }))
}

fn add_file(
    folder: &Path,
    rel: &str,
    files: &mut Vec<PackFile>,
    executable: bool,
) -> Result<(), String> {
    let (sha256, size) = sha256_file(&folder.join(rel))?;
    files.push(PackFile {
        path: rel.to_string(),
        size,
        sha256,
        executable,
    });
    Ok(())
}

fn pack_copy(from: &Path, folder: &Path, rel: &str) -> Result<(), String> {
    let to = folder.join(rel);
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(io_text)?;
    }
    fs::copy(from, &to).map_err(io_text)?;
    Ok(())
}

fn pack_tree(
    source: &Path,
    folder: &Path,
    rel: &str,
    files: &mut Vec<PackFile>,
) -> Result<(), String> {
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(io_text)?;
        let kind = entry.file_type().map_err(io_text)?;
        let to = format!("{rel}/{}", entry.file_name().to_string_lossy());
        if kind.is_dir() {
            pack_tree(&entry.path(), folder, &to, files)?;
        } else if kind.is_file() {
            pack_copy(&entry.path(), folder, &to)?;
            add_file(folder, &to, files, false)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(info: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    info.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_info: &fs::Metadata) -> bool {
    false
}

fn pack(env: &Env, params: &Value) -> Result<Value, String> {
    drop_stale(env);
    let folder = move_folder(env, params)?;
    let cwd = text_param(params, "cwd")?;
    let session_id = session_param(params)?;
    let remote = text_param(params, "remoteName")?;
    if !remote
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return Err("Invalid remote name".into());
    }
    let root_text = git_out(Path::new(cwd), &["rev-parse", "--show-toplevel"])?;
    let root_text = root_text.trim();
    if is_client_path(root_text) {
        return Err(CLIENT.into());
    }
    let root = Path::new(root_text);
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).map_err(io_text)?;
    let mut files: Vec<PackFile> = Vec::new();
    let mut links: Vec<PackLink> = Vec::new();
    let head = git_out(root, &["rev-parse", "HEAD"])?.trim().to_string();
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
        .stdout
        .trim()
        .to_string();

    // Commits the remote doesn't have. Git refuses an empty bundle, so ask first.
    let not_remote = format!("--remotes={remote}");
    let local = git_out(
        root,
        &["rev-list", "--max-count=1", "HEAD", "--not", &not_remote],
    )?;
    if !local.trim().is_empty() {
        let bundle = path_text(&folder.join(BUNDLE_FILE));
        git_out_within(
            root,
            &["bundle", "create", &bundle, "HEAD", "--not", &not_remote],
            GIT_LONG_TIME,
        )?;
        add_file(&folder, BUNDLE_FILE, &mut files, false)?;
    }

    // Staged and unstaged together, with deletions and binary files.
    let output = format!("--output={}", path_text(&folder.join(PATCH_FILE)));
    git_out_within(
        root,
        &[
            "diff",
            "--binary",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &output,
            "HEAD",
        ],
        GIT_LONG_TIME,
    )?;
    if fs::metadata(folder.join(PATCH_FILE))
        .map_err(io_text)?
        .len()
        > 0
    {
        add_file(&folder, PATCH_FILE, &mut files, false)?;
    } else {
        fs::remove_file(folder.join(PATCH_FILE)).map_err(io_text)?;
    }

    let mut ignored: Vec<String> = Vec::new();
    let untracked = git_out_within(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        GIT_LONG_TIME,
    )?;
    for rel in untracked.split('\0').filter(|rel| !rel.is_empty()) {
        // A folder with its own repository: left behind and named on the card.
        let packed = format!("{UNTRACKED_DIR}/{rel}");
        if rel.ends_with('/') || !pack_path_ok(&packed, &session_id) {
            ignored.push(rel.to_string());
            continue;
        }
        let from = root.join(rel);
        let Ok(info) = fs::symlink_metadata(&from) else {
            continue;
        };
        if info.file_type().is_symlink() {
            links.push(PackLink {
                path: packed,
                target: path_text(&fs::read_link(&from).map_err(io_text)?),
            });
        } else if info.is_file() {
            pack_copy(&from, &folder, &packed)?;
            add_file(&folder, &packed, &mut files, is_executable(&info))?;
        }
    }

    let names = git_out_within(
        root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
        GIT_LONG_TIME,
    )?;
    for rel in names.split('\0').filter(|rel| !rel.is_empty()) {
        if !rel.starts_with(".claude/worktrees/") {
            ignored.push(rel.to_string());
        }
    }

    let Transcript { home, project } = find_transcript(env, cwd, &session_id)
        .ok_or("Could not find this session's conversation")?;
    pack_tree(
        &project.join(&session_id),
        &folder,
        &format!("{CONVO_DIR}/session/{session_id}"),
        &mut files,
    )?;
    pack_tree(
        &home.join("file-history").join(&session_id),
        &folder,
        &format!("{CONVO_DIR}/history/{session_id}"),
        &mut files,
    )?;
    let transcript = format!("{CONVO_DIR}/session/{session_id}.jsonl");
    pack_copy(
        &project.join(format!("{session_id}.jsonl")),
        &folder,
        &transcript,
    )?;
    add_file(&folder, &transcript, &mut files, false)?;

    if files.iter().map(|file| file.size).sum::<u64>() > PACK_MAX_BYTES {
        return Err("This session's work is over 2 GB, too big to carry".into());
    }
    let ignored_more = ignored.len().saturating_sub(IGNORED_MAX) as u64;
    ignored.truncate(IGNORED_MAX);
    let manifest = Manifest {
        version: 1,
        session_id,
        head,
        branch: (!branch.is_empty()).then_some(branch),
        source_path: cwd.to_string(),
        files,
        links,
        ignored,
        ignored_more,
    };
    let value = serde_json::to_value(&manifest).map_err(|e| e.to_string())?;
    fs::write(folder.join("manifest.json"), value.to_string()).map_err(io_text)?;
    Ok(value)
}

fn read_piece(env: &Env, params: &Value) -> Result<Value, String> {
    let folder = move_folder(env, params)?;
    let path = text_param(params, "path")?;
    let offset = params
        .get("offset")
        .and_then(Value::as_u64)
        .ok_or("Invalid offset")?;
    let text = fs::read_to_string(folder.join("manifest.json")).map_err(io_text)?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !manifest.files.iter().any(|file| file.path == path) {
        return Err("That file is not in this move".into());
    }
    let mut file = fs::File::open(folder.join(path)).map_err(io_text)?;
    file.seek(SeekFrom::Start(offset)).map_err(io_text)?;
    let mut buffer = Vec::with_capacity(CHUNK_BYTES);
    file.take(CHUNK_BYTES as u64)
        .read_to_end(&mut buffer)
        .map_err(io_text)?;
    Ok(json!({"data": base64::engine::general_purpose::STANDARD.encode(&buffer)}))
}

// ---- ops: target ----

fn check(env: &Env, params: &Value) -> Result<Value, String> {
    drop_stale(env);
    let source_path = text_param(params, "sourcePath")?;
    if is_client_path(source_path) {
        return Ok(json!({"ok": false, "reason": CLIENT}));
    }
    let urls = urls_param(params);
    if urls.is_empty() {
        return Ok(json!({"ok": false, "reason": NO_REMOTE}));
    }
    Ok(match find_repo(env, params, &urls, source_path) {
        Found::Client => json!({"ok": false, "reason": CLIENT}),
        Found::Missing => json!({"ok": false, "reason": NOT_THERE}),
        Found::Repo {
            repo,
            remote_name,
            matched_url,
        } => json!({
            "ok": true,
            "repo": path_text(&repo),
            "remoteName": remote_name,
            "matchedUrl": matched_url,
        }),
    })
}

fn write_piece(env: &Env, params: &Value) -> Result<Value, String> {
    let folder = move_folder(env, params)?;
    let session_id = session_param(params)?;
    let path = text_param(params, "path")?;
    if !pack_path_ok(path, &session_id) {
        return Err(format!("Refused a file in the move: {path}"));
    }
    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or("Missing data")?;
    if data.len() > WRITE_MAX_BASE64 {
        return Err("That piece is too big".into());
    }
    let offset = params.get("offset").and_then(Value::as_u64);
    fs::create_dir_all(&folder).map_err(io_text)?;
    let target = safe_target(&folder, path)?;
    let size = fs::symlink_metadata(&target).map_or(0, |info| info.len());
    if offset != Some(size) {
        return Err("The move's pieces arrived out of order".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(io_text)?;
    file.write_all(&bytes).map_err(io_text)?;
    Ok(json!({}))
}

fn verify_pack(folder: &Path, manifest: &Manifest) -> Result<(), String> {
    for file in &manifest.files {
        let whole = sha256_file(&folder.join(&file.path))
            .is_ok_and(|(sha256, size)| sha256 == file.sha256 && size == file.size);
        if !whole {
            return Err(format!("A file did not arrive whole: {}", file.path));
        }
    }
    Ok(())
}

fn has_commit(repo: &Path, sha: &str) -> bool {
    git(repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok_and(|result| result.ok)
}

fn bring_commits(
    repo: &Path,
    remote: &str,
    folder: &Path,
    manifest: &Manifest,
) -> Result<(), String> {
    if has_commit(repo, &manifest.head) {
        return Ok(());
    }
    // The remote's own commits first: the bundle builds on them.
    let _ = git_within(repo, &["fetch", "--quiet", remote], GIT_LONG_TIME);
    if manifest.files.iter().any(|file| file.path == BUNDLE_FILE) {
        let bundle = path_text(&folder.join(BUNDLE_FILE));
        git_out_within(repo, &["fetch", "--quiet", &bundle, "HEAD"], GIT_LONG_TIME)?;
    }
    if !has_commit(repo, &manifest.head) {
        return Err(format!(
            "This machine can't get commit {}; push it first",
            &manifest.head[..8]
        ));
    }
    Ok(())
}

/// A free name, reserved by making its folder: only one move can make it, so a
/// folder in this move's record is this move's even if it crashed before the add.
fn free_place(repo: &Path, name: &str) -> Result<(PathBuf, String), String> {
    let root = repo.join(".claude").join("worktrees");
    fs::create_dir_all(&root).map_err(io_text)?;
    for n in 1..50 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let worktree = root.join(format!("moved-{name}{suffix}"));
        let branch = format!("moved/{name}{suffix}");
        let reference = format!("refs/heads/{branch}");
        if git(repo, &["show-ref", "--verify", "--quiet", &reference])?.ok {
            continue;
        }
        match fs::create_dir(&worktree) {
            Ok(()) => return Ok((worktree, branch)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Too many moved copies of this session on that machine".into())
}

#[cfg(unix)]
fn make_link(target: &str, path: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, path).map_err(io_text)
}

#[cfg(not(unix))]
fn make_link(_target: &str, _path: &Path) -> Result<(), String> {
    Err("This machine can't carry links".into())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(io_text)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn unpack_code(env: &Env, params: &Value) -> Result<Value, String> {
    let folder = move_folder(env, params)?;
    let name = name_param(params)?;
    let manifest = parse_manifest(params.get("manifest"))?;
    if is_client_path(&manifest.source_path) {
        return Err(CLIENT.into());
    }
    // Found again here: what the app says the repository is isn't trusted.
    let (repo, remote_name) =
        match find_repo(env, params, &urls_param(params), &manifest.source_path) {
            Found::Client => return Err(CLIENT.into()),
            Found::Missing => return Err(NOT_THERE.into()),
            Found::Repo {
                repo, remote_name, ..
            } => (repo, remote_name),
        };
    verify_pack(&folder, &manifest)?;
    bring_commits(&repo, &remote_name, &folder, &manifest)?;
    // The real path: it is the one Claude's project key is made from.
    let repo = repo.canonicalize().map_err(io_text)?;
    let (worktree, branch) = free_place(&repo, &name)?;
    let worktree_text = path_text(&worktree);
    if project_key(&worktree_text).len() > PROJECT_KEY_MAX {
        let _ = fs::remove_dir(&worktree);
        return Err("The new folder's path is too long for Claude to resume in".into());
    }
    // Saved before the add, so a crash just after it still leaves a record.
    let mut made = Made {
        repo: Some(path_text(&repo)),
        session_id: Some(manifest.session_id.clone()),
        pending: Some(Pending {
            worktree: worktree_text.clone(),
            branch: branch.clone(),
            head: manifest.head.clone(),
        }),
        ..Made::default()
    };
    save_made(&folder, &made)?;
    // No hooks: one failing would leave a worktree this move can't tell is its own.
    let add_args = [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "--quiet",
        "-b",
        &branch,
        &worktree_text,
        &manifest.head,
    ];
    let added = git_within(&repo, &add_args, GIT_LONG_TIME)?;
    if !added.ok {
        // Another move may have taken the name first: that worktree is not this one's.
        // A timed-out add may still have made it, so the claim stays for undo to check.
        if !added.timed_out {
            made.pending = None;
            save_made(&folder, &made)?;
            // The reserved folder, if the add left it empty; never anyone's files.
            let _ = fs::remove_dir(&worktree);
        }
        return Err(git_error(&added, &add_args));
    }
    made.worktree = Some(worktree_text.clone());
    made.branch = Some(branch.clone());
    made.pending = None;
    save_made(&folder, &made)?;
    if manifest.files.iter().any(|file| file.path == PATCH_FILE) {
        let patch = path_text(&folder.join(PATCH_FILE));
        git_out_within(
            &worktree,
            &["apply", "--binary", "--whitespace=nowarn", &patch],
            GIT_LONG_TIME,
        )?;
    }
    let prefix = format!("{UNTRACKED_DIR}/");
    for file in &manifest.files {
        let Some(rel) = file.path.strip_prefix(&prefix) else {
            continue;
        };
        let target = safe_target(&worktree, rel)?;
        if lexists(&target) {
            return Err(format!("A carried file is already there: {rel}"));
        }
        fs::copy(folder.join(&file.path), &target).map_err(io_text)?;
        if file.executable {
            make_executable(&target)?;
        }
    }
    for link in &manifest.links {
        let rel = link.path.strip_prefix(&prefix).unwrap_or(&link.path);
        let target = safe_target(&worktree, rel)?;
        if lexists(&target) {
            return Err(format!("A carried file is already there: {rel}"));
        }
        make_link(&link.target, &target)?;
    }
    Ok(json!({"repo": path_text(&repo), "cwd": worktree_text, "branch": branch}))
}

fn place(
    from: &Path,
    root: &Path,
    rel: &str,
    folder: &Path,
    made: &mut Made,
) -> Result<(), String> {
    let target = safe_target(root, rel)?;
    if lexists(&target) {
        let backup = folder.join("backup").join(made.replaced.len().to_string());
        fs::create_dir_all(folder.join("backup")).map_err(io_text)?;
        fs::copy(&target, &backup).map_err(io_text)?;
        made.replaced.push(Replaced {
            path: path_text(&target),
            backup: path_text(&backup),
        });
    } else {
        made.files.push(path_text(&target));
    }
    save_made(folder, made)?;
    crate::codex_mono_store::copy_durable(from, &target).map_err(io_text)
}

fn unpack_conversation(env: &Env, params: &Value) -> Result<Value, String> {
    let folder = move_folder(env, params)?;
    let manifest = parse_manifest(params.get("manifest"))?;
    let mut made = load_made(&folder)?;
    let worktree = made
        .worktree
        .clone()
        .filter(|_| made.session_id.as_deref() == Some(manifest.session_id.as_str()))
        .ok_or("The code has not been carried yet")?;
    made.account_home = Some(path_text(&env.account_home));
    let project = env
        .account_home
        .join("projects")
        .join(project_key(&worktree));
    fs::create_dir_all(&project).map_err(io_text)?;
    let id = &manifest.session_id;
    let transcript = format!("{CONVO_DIR}/session/{id}.jsonl");
    let session_prefix = format!("{CONVO_DIR}/session/");
    let history_prefix = format!("{CONVO_DIR}/history/");
    for file in &manifest.files {
        if file.path == transcript {
            continue;
        }
        let from = folder.join(&file.path);
        if let Some(rel) = file.path.strip_prefix(&session_prefix) {
            place(&from, &project, rel, &folder, &mut made)?;
        } else if let Some(rel) = file.path.strip_prefix(&history_prefix) {
            let root = env.account_home.join("file-history");
            fs::create_dir_all(&root).map_err(io_text)?;
            place(&from, &root, rel, &folder, &mut made)?;
        }
    }
    // Last: it is what --resume looks for, so a partial copy never passes for whole.
    if !manifest.files.iter().any(|file| file.path == transcript) {
        return Err("The conversation is missing from the move".into());
    }
    place(
        &folder.join(&transcript),
        &project,
        &format!("{id}.jsonl"),
        &folder,
        &mut made,
    )?;
    save_made(&folder, &made)?;
    Ok(json!({"account": account_name(&env.account_home)}))
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// A worktree add the record never heard back from is this move's only if git
/// lists it at that path, on that branch, still at the commit it was made from.
fn added_by_this_move(repo: Option<&str>, pending: &Pending) -> bool {
    let Some(repo) = repo.map(Path::new) else {
        return false;
    };
    let reference = format!("refs/heads/{}", pending.branch);
    let tip = git_out(repo, &["rev-parse", "--verify", "--quiet", &reference]);
    if tip.map(|tip| tip.trim().to_string()).ok().as_deref() != Some(pending.head.as_str()) {
        return false;
    }
    let Ok(list) = git_out(repo, &["worktree", "list", "--porcelain"]) else {
        return false;
    };
    list.split("\n\n").any(|block| {
        let path = block
            .lines()
            .find_map(|line| line.strip_prefix("worktree "));
        let branch = block.lines().find_map(|line| line.strip_prefix("branch "));
        branch == Some(reference.as_str())
            && path.is_some_and(|path| same_path(Path::new(path), Path::new(&pending.worktree)))
    })
}

fn remove_empty(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            remove_empty(&entry.path());
        }
    }
    let _ = fs::remove_dir(folder);
}

/// Removes what this move made here. Only that: never anything older.
fn undo(env: &Env, params: &Value) -> Result<Value, String> {
    let folder = move_folder(env, params)?;
    let mut made = load_made(&folder)?;
    if let Some(pending) = made.pending.clone() {
        if added_by_this_move(made.repo.as_deref(), &pending) {
            made.worktree = Some(pending.worktree);
            made.branch = Some(pending.branch);
        } else {
            // Only if empty: the reserved folder of an add that never ran.
            let _ = fs::remove_dir(&pending.worktree);
        }
    }
    for file in &made.files {
        let _ = fs::remove_file(file);
    }
    for old in &made.replaced {
        fs::copy(&old.backup, &old.path).map_err(io_text)?;
    }
    if let (Some(home), Some(worktree)) = (&made.account_home, &made.worktree) {
        let home = Path::new(home);
        remove_empty(&home.join("projects").join(project_key(worktree)));
        if let Some(id) = &made.session_id {
            remove_empty(&home.join("file-history").join(id));
        }
    }
    if let (Some(repo), Some(worktree)) = (&made.repo, &made.worktree) {
        let repo = Path::new(repo);
        let _ = git_within(
            repo,
            &["worktree", "remove", "--force", worktree],
            GIT_LONG_TIME,
        );
        let _ = fs::remove_dir_all(worktree);
        let _ = git(repo, &["worktree", "prune"]);
    }
    if let (Some(repo), Some(branch)) = (&made.repo, &made.branch) {
        let _ = git(Path::new(repo), &["branch", "-D", branch]);
    }
    let _ = fs::remove_dir_all(&folder);
    Ok(json!({}))
}

fn done(env: &Env, params: &Value) -> Result<Value, String> {
    let _ = fs::remove_dir_all(move_folder(env, params)?);
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const ID: &str = "11111111-2222-3333-4444-555555555555";
    const MOVE: &str = "move-0001-abcdef";

    struct Fixture {
        base: PathBuf,
        source: PathBuf,
        target_repo: PathBuf,
        from: Env,
        to: Env,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn sh(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn env_at(home: &Path) -> Env {
        Env {
            home: home.to_path_buf(),
            staging_root: home.join("staging"),
            account_home: home.join(".claude"),
        }
    }

    fn fixture_at(base: PathBuf) -> Fixture {
        fs::create_dir_all(&base).unwrap();
        let origin = base.join("origin.git");
        sh(
            &base,
            &["init", "--quiet", "--bare", path_text(&origin).as_str()],
        );
        let source_home = base.join("mac");
        let target_home = base.join("lab");
        let source = source_home.join("Documents/projects/app");
        let target_repo = target_home.join("Documents/projects/app");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(target_repo.parent().unwrap()).unwrap();
        let origin_text = path_text(&origin);
        sh(
            &base,
            &[
                "clone",
                "--quiet",
                &origin_text,
                path_text(&source).as_str(),
            ],
        );
        sh(&source, &["checkout", "-q", "-b", "main"]);
        fs::write(source.join("keep.txt"), "keep\n").unwrap();
        fs::write(source.join("edit.txt"), "one\ntwo\n").unwrap();
        fs::write(source.join("gone.txt"), "bye\n").unwrap();
        fs::write(source.join(".gitignore"), ".env\nnode_modules/\n").unwrap();
        fs::write(source.join("logo.bin"), [0u8, 1, 2, 3, 255, 0]).unwrap();
        sh(&source, &["add", "."]);
        sh(&source, &["commit", "-q", "-m", "first"]);
        sh(&source, &["push", "-q", "origin", "main"]);
        sh(
            &base,
            &[
                "clone",
                "--quiet",
                &origin_text,
                path_text(&target_repo).as_str(),
            ],
        );

        let project = source_home
            .join(".claude/projects")
            .join(project_key(&path_text(&source)));
        fs::create_dir_all(project.join(ID).join("subagents")).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), "{\"turn\":1}\n").unwrap();
        fs::write(project.join(ID).join("subagents/agent-1.jsonl"), "sub\n").unwrap();
        let history = source_home.join(".claude/file-history").join(ID);
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("v1"), "v1\n").unwrap();
        Fixture {
            from: env_at(&source_home),
            to: env_at(&target_home),
            base,
            source,
            target_repo,
        }
    }

    fn fixture() -> Fixture {
        fixture_at(std::env::temp_dir().join(format!("fork-session-move-{}", uuid::Uuid::new_v4())))
    }

    /// A local-only commit, an edit, a deletion, binary, new, link and ignored files.
    fn dirty(source: &Path) {
        fs::write(source.join("local.txt"), "only here\n").unwrap();
        sh(source, &["add", "."]);
        sh(source, &["commit", "-q", "-m", "local only"]);
        fs::write(source.join("edit.txt"), "one\nchanged\n").unwrap();
        fs::remove_file(source.join("gone.txt")).unwrap();
        fs::write(source.join("logo.bin"), [9u8, 0, 8, 0, 7, 255]).unwrap();
        fs::write(source.join("staged.txt"), "staged\n").unwrap();
        sh(source, &["add", "staged.txt"]);
        fs::create_dir_all(source.join("new/deep")).unwrap();
        fs::write(source.join("new/deep/file with space.bin"), [0u8, 255, 0]).unwrap();
        fs::write(source.join("new/empty"), "").unwrap();
        fs::write(source.join("new/run.sh"), "#!/bin/sh\n").unwrap();
        make_executable(&source.join("new/run.sh")).unwrap();
        make_link("keep.txt", &source.join("new/link")).unwrap();
        fs::write(source.join(".env"), "SECRET=1\n").unwrap();
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::write(source.join("node_modules/x"), "x").unwrap();
    }

    fn tree(root: &Path, skip: &[&str]) -> BTreeMap<String, String> {
        fn walk(root: &Path, dir: &Path, skip: &[&str], out: &mut BTreeMap<String, String>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                let rel = path_text(path.strip_prefix(root).unwrap());
                if rel == ".git" || skip.iter().any(|item| rel.starts_with(item)) {
                    continue;
                }
                let info = fs::symlink_metadata(&path).unwrap();
                if info.file_type().is_symlink() {
                    out.insert(
                        rel,
                        format!("link:{}", path_text(&fs::read_link(&path).unwrap())),
                    );
                } else if info.is_dir() {
                    walk(root, &path, skip, out);
                } else {
                    let flag = if is_executable(&info) { "x" } else { "-" };
                    out.insert(rel, format!("{flag}{}", sha256_file(&path).unwrap().0));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, skip, &mut out);
        out
    }

    /// Everything up to unpacking: inspect, check, pack and the pieces.
    fn carry(fix: &Fixture) -> (Value, Vec<String>) {
        let cwd = path_text(&fix.source);
        let facts = inspect(&fix.from, &json!({"cwd": cwd, "sessionId": ID})).unwrap();
        let urls: Vec<String> = facts["remotes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|remote| remote["url"].as_str().unwrap().to_string())
            .collect();
        let checked = check(&fix.to, &json!({"sourcePath": cwd, "urls": urls})).unwrap();
        assert_eq!(checked["ok"], true, "{checked}");
        let manifest = pack(
            &fix.from,
            &json!({"moveId": MOVE, "cwd": cwd, "sessionId": ID, "remoteName": "origin"}),
        )
        .unwrap();
        for file in manifest["files"].as_array().unwrap() {
            let path = file["path"].as_str().unwrap();
            let size = file["size"].as_u64().unwrap();
            let mut offset = 0u64;
            if size == 0 {
                write_piece(
                    &fix.to,
                    &json!({"moveId": MOVE, "sessionId": ID, "path": path, "offset": 0, "data": ""}),
                )
                .unwrap();
            }
            while offset < size {
                let piece = read_piece(
                    &fix.from,
                    &json!({"moveId": MOVE, "path": path, "offset": offset}),
                )
                .unwrap();
                let data = piece["data"].as_str().unwrap();
                write_piece(
                    &fix.to,
                    &json!({"moveId": MOVE, "sessionId": ID, "path": path, "offset": offset, "data": data}),
                )
                .unwrap();
                offset += base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap()
                    .len() as u64;
            }
        }
        (manifest, urls)
    }

    fn unpack(
        fix: &Fixture,
        name: &str,
        manifest: &Value,
        urls: &[String],
    ) -> Result<Value, String> {
        unpack_code(
            &fix.to,
            &json!({"moveId": MOVE, "name": name, "manifest": manifest, "urls": urls}),
        )
    }

    #[test]
    fn carries_a_dirty_tree_byte_for_byte() {
        let fix = fixture();
        dirty(&fix.source);
        let (manifest, urls) = carry(&fix);
        let code = unpack(&fix, "my-session", &manifest, &urls).unwrap();
        assert_eq!(code["branch"], "moved/my-session");
        let cwd = PathBuf::from(code["cwd"].as_str().unwrap());
        assert_eq!(
            cwd,
            // Canonical: macOS temp folders sit behind the /var symlink.
            fix.target_repo
                .canonicalize()
                .unwrap()
                .join(".claude/worktrees/moved-my-session")
        );
        assert_eq!(
            code["repo"],
            path_text(&fix.target_repo.canonicalize().unwrap())
        );
        unpack_conversation(&fix.to, &json!({"moveId": MOVE, "manifest": manifest})).unwrap();

        assert_eq!(
            tree(&cwd, &[]),
            tree(&fix.source, &[".env", "node_modules"])
        );
        assert!(!cwd.join(".env").exists());
        assert!(!cwd.join("gone.txt").exists());
        assert_eq!(
            fs::read_link(cwd.join("new/link")).unwrap(),
            PathBuf::from("keep.txt")
        );
        assert_eq!(
            sh(&cwd, &["rev-parse", "HEAD"]),
            sh(&fix.source, &["rev-parse", "HEAD"])
        );
        assert_eq!(sh(&cwd, &["log", "-1", "--format=%s"]), "local only");

        let ignored = manifest["ignored"].as_array().unwrap();
        assert!(ignored.contains(&json!(".env")) && ignored.contains(&json!("node_modules/")));
        assert!(!manifest.to_string().contains("SECRET"));

        let key = project_key(&path_text(&cwd));
        let project = fix.to.account_home.join("projects").join(key);
        assert_eq!(
            fs::read(project.join(format!("{ID}.jsonl"))).unwrap(),
            b"{\"turn\":1}\n"
        );
        assert_eq!(
            fs::read(project.join(ID).join("subagents/agent-1.jsonl")).unwrap(),
            b"sub\n"
        );
        assert_eq!(
            fs::read(fix.to.account_home.join("file-history").join(ID).join("v1")).unwrap(),
            b"v1\n"
        );
        // The original is left as it was.
        assert_eq!(
            fs::read(fix.source.join("edit.txt")).unwrap(),
            b"one\nchanged\n"
        );
    }

    #[test]
    fn needs_no_bundle_and_carries_a_large_file_in_pieces() {
        let fix = fixture();
        let big = vec![7u8; CHUNK_BYTES * 2 + 17];
        fs::write(fix.source.join("big.bin"), &big).unwrap();
        let (manifest, urls) = carry(&fix);
        assert!(!manifest.to_string().contains(BUNDLE_FILE));
        let code = unpack(&fix, "s", &manifest, &urls).unwrap();
        let cwd = PathBuf::from(code["cwd"].as_str().unwrap());
        assert_eq!(fs::read(cwd.join("big.bin")).unwrap(), big);
    }

    #[test]
    fn takes_the_next_free_name() {
        let fix = fixture();
        let (manifest, urls) = carry(&fix);
        unpack(&fix, "s", &manifest, &urls).unwrap();
        let second = unpack(&fix, "s", &manifest, &urls).unwrap();
        assert_eq!(second["branch"], "moved/s-2");
    }

    #[test]
    fn undo_removes_what_it_made_and_nothing_older() {
        let fix = fixture();
        dirty(&fix.source);
        let (manifest, urls) = carry(&fix);
        let history = fix.to.account_home.join("file-history").join(ID);
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("older"), "older").unwrap();
        fs::write(history.join("v1"), "the older v1").unwrap();
        let code = unpack(&fix, "s", &manifest, &urls).unwrap();
        let cwd = PathBuf::from(code["cwd"].as_str().unwrap());
        unpack_conversation(&fix.to, &json!({"moveId": MOVE, "manifest": manifest})).unwrap();
        let project = fix
            .to
            .account_home
            .join("projects")
            .join(project_key(&path_text(&cwd)));
        assert!(project.join(format!("{ID}.jsonl")).exists());

        undo(&fix.to, &json!({"moveId": MOVE})).unwrap();

        assert!(!cwd.exists());
        assert!(!project.exists());
        assert_eq!(fs::read(history.join("v1")).unwrap(), b"the older v1");
        assert_eq!(fs::read(history.join("older")).unwrap(), b"older");
        assert_eq!(sh(&fix.target_repo, &["branch", "--list", "moved/s"]), "");
        assert!(!sh(&fix.target_repo, &["worktree", "list"]).contains("moved-s"));
        assert!(!fix.to.staging_root.join(MOVE).exists());
    }

    #[test]
    fn refuses_a_damaged_file_and_leaves_no_worktree() {
        let fix = fixture();
        dirty(&fix.source);
        let (manifest, urls) = carry(&fix);
        fs::write(
            fix.to.staging_root.join(MOVE).join(PATCH_FILE),
            "not a patch\n",
        )
        .unwrap();
        let error = unpack(&fix, "s", &manifest, &urls).unwrap_err();
        assert!(error.contains("did not arrive whole"), "{error}");
        undo(&fix.to, &json!({"moveId": MOVE})).unwrap();
        assert!(!fix.target_repo.join(".claude/worktrees/moved-s").exists());
    }

    #[test]
    fn refuses_a_missing_repository_and_client_work_on_both_ends() {
        let fix = fixture();
        let source = path_text(&fix.source);
        let other = json!({"sourcePath": source, "urls": ["https://example.com/other.git"]});
        assert_eq!(check(&fix.to, &other).unwrap()["reason"], NOT_THERE);
        let url = sh(&fix.source, &["remote", "get-url", "origin"]);
        let from_client = json!({
            "sourcePath": "/Users/me/Documents/projects/upwork/acme/app",
            "urls": [url],
        });
        assert_eq!(check(&fix.to, &from_client).unwrap()["reason"], CLIENT);

        // A client clone on the target is refused even if the source says otherwise.
        let client = fix.to.home.join("Documents/projects/upwork/acme");
        fs::create_dir_all(client.parent().unwrap()).unwrap();
        fs::remove_dir_all(&fix.target_repo).unwrap();
        sh(
            &fix.base,
            &["clone", "--quiet", &url, path_text(&client).as_str()],
        );
        let plain = json!({"sourcePath": source, "urls": [url]});
        assert_eq!(check(&fix.to, &plain).unwrap()["reason"], CLIENT);
    }

    #[test]
    fn refuses_a_link_from_outside_upwork_into_a_client_repository() {
        let fix = fixture();
        let source = path_text(&fix.source);
        let url = sh(&fix.source, &["remote", "get-url", "origin"]);
        fs::remove_dir_all(&fix.target_repo).unwrap();
        let client = fix.to.home.join("Documents/projects/upwork/acme");
        fs::create_dir_all(client.parent().unwrap()).unwrap();
        sh(
            &fix.base,
            &["clone", "--quiet", &url, path_text(&client).as_str()],
        );
        let link = fix.base.join("app-link");
        std::os::unix::fs::symlink(&client, &link).unwrap();
        let ask = json!({"sourcePath": source, "urls": [url], "projects": [path_text(&link)]});
        assert_eq!(check(&fix.to, &ask).unwrap()["reason"], CLIENT);

        // Panoptic is the exception, through a link too.
        fs::remove_dir_all(&client).unwrap();
        fs::remove_file(&link).unwrap();
        let panoptic = fix.to.home.join("Documents/projects/upwork/panoptic/app");
        fs::create_dir_all(panoptic.parent().unwrap()).unwrap();
        sh(
            &fix.base,
            &["clone", "--quiet", &url, path_text(&panoptic).as_str()],
        );
        std::os::unix::fs::symlink(&panoptic, &link).unwrap();
        assert_eq!(check(&fix.to, &ask).unwrap()["ok"], true);
    }

    #[test]
    fn takes_the_newest_transcript_from_any_account() {
        let fix = fixture();
        let key = project_key(&path_text(&fix.source));
        let cx = fix.from.home.join(".claude-exec");
        let project = cx.join("projects").join(&key);
        fs::create_dir_all(&project).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(project.join(format!("{ID}.jsonl")), "{\"turn\":2}\n").unwrap();
        fs::create_dir_all(cx.join("file-history").join(ID)).unwrap();
        fs::write(cx.join("file-history").join(ID).join("v2"), "v2\n").unwrap();
        let cwd = path_text(&fix.source);
        let facts = inspect(&fix.from, &json!({"cwd": cwd, "sessionId": ID})).unwrap();
        assert_eq!(facts["account"], "cx");
        let manifest = pack(
            &fix.from,
            &json!({"moveId": MOVE, "cwd": cwd, "sessionId": ID, "remoteName": "origin"}),
        )
        .unwrap();
        let staged = fix.from.staging_root.join(MOVE);
        let transcript = staged.join(format!("{CONVO_DIR}/session/{ID}.jsonl"));
        assert_eq!(fs::read(transcript).unwrap(), b"{\"turn\":2}\n");
        assert!(manifest
            .to_string()
            .contains(&format!("{CONVO_DIR}/history/{ID}/v2")));

        // Only in an account the tab doesn't use: found all the same.
        fs::remove_dir_all(fix.from.home.join(".claude/projects")).unwrap();
        let facts = inspect(&fix.from, &json!({"cwd": cwd, "sessionId": ID})).unwrap();
        assert_eq!(facts["hasTranscript"], true);
    }

    #[test]
    fn undo_removes_an_unconfirmed_worktree_only_if_unchanged() {
        let fix = fixture();
        let (manifest, urls) = carry(&fix);
        let code = unpack(&fix, "s", &manifest, &urls).unwrap();
        let cwd = PathBuf::from(code["cwd"].as_str().unwrap());
        let folder = fix.to.staging_root.join(MOVE);
        // As if it crashed between the add and saving that it worked.
        let crashed = || {
            let mut made = load_made(&folder).unwrap();
            made.pending = Some(Pending {
                worktree: made.worktree.take().unwrap(),
                branch: made.branch.take().unwrap(),
                head: manifest["head"].as_str().unwrap().to_string(),
            });
            save_made(&folder, &made).unwrap();
        };
        crashed();
        undo(&fix.to, &json!({"moveId": MOVE})).unwrap();
        assert!(!cwd.exists());
        assert_eq!(sh(&fix.target_repo, &["branch", "--list", "moved/s"]), "");

        // A branch that has moved on is someone's work, not this move's.
        let (manifest, urls) = carry(&fix);
        let code = unpack(&fix, "s", &manifest, &urls).unwrap();
        let cwd = PathBuf::from(code["cwd"].as_str().unwrap());
        crashed();
        fs::write(cwd.join("work.txt"), "mine\n").unwrap();
        sh(&cwd, &["add", "work.txt"]);
        sh(&cwd, &["commit", "-q", "-m", "work"]);
        undo(&fix.to, &json!({"moveId": MOVE})).unwrap();
        assert!(cwd.join("work.txt").exists());
        assert!(sh(&fix.target_repo, &["branch", "--list", "moved/s"]).contains("moved/s"));
    }

    #[test]
    fn a_reserved_name_is_skipped_and_its_undo_takes_nothing_else() {
        let fix = fixture();
        let (manifest, urls) = carry(&fix);
        // As if a move reserved the name and crashed before its add.
        let repo = fix.target_repo.canonicalize().unwrap();
        let reserved = repo.join(".claude/worktrees/moved-s");
        fs::create_dir_all(&reserved).unwrap();
        let other = fix.to.staging_root.join("move-0002-abcdef");
        save_made(
            &other,
            &Made {
                repo: Some(path_text(&repo)),
                session_id: Some(ID.into()),
                pending: Some(Pending {
                    worktree: path_text(&reserved),
                    branch: "moved/s".into(),
                    head: manifest["head"].as_str().unwrap().to_string(),
                }),
                ..Made::default()
            },
        )
        .unwrap();
        let code = unpack(&fix, "s", &manifest, &urls).unwrap();
        assert_eq!(code["branch"], "moved/s-2");
        undo(&fix.to, &json!({"moveId": "move-0002-abcdef"})).unwrap();
        assert!(!reserved.exists());
        assert!(PathBuf::from(code["cwd"].as_str().unwrap()).exists());
    }

    #[test]
    fn gives_up_on_a_git_command_that_hangs() {
        let base = std::env::temp_dir();
        let started = std::time::Instant::now();
        let result = git_within(
            &base,
            &["-c", "alias.nap=!sleep 20", "nap"],
            Duration::from_millis(300),
        )
        .unwrap();
        assert!(result.timed_out && !result.ok);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(git_error(&result, &["nap"]).contains("timed out"));
    }

    #[test]
    fn rejects_paths_and_ids_from_the_other_machine() {
        let fix = fixture();
        for path in [
            "../x",
            "/etc/passwd",
            "untracked/../../x",
            "untracked/.git/config",
            "convo/session/other.jsonl",
            "elsewhere",
            "untracked",
        ] {
            let params =
                json!({"moveId": MOVE, "sessionId": ID, "path": path, "offset": 0, "data": "eA=="});
            assert!(
                write_piece(&fix.to, &params)
                    .unwrap_err()
                    .contains("Refused"),
                "{path}"
            );
        }
        let bad_move = json!({"moveId": "../..", "sessionId": ID, "path": PATCH_FILE, "offset": 0, "data": "eA=="});
        assert_eq!(
            write_piece(&fix.to, &bad_move).unwrap_err(),
            "Invalid move id"
        );
        let bad_id = json!({"moveId": MOVE, "sessionId": "../x", "path": PATCH_FILE, "offset": 0, "data": "eA=="});
        assert_eq!(
            write_piece(&fix.to, &bad_id).unwrap_err(),
            "Invalid session id"
        );
        let bad_offset = json!({"moveId": MOVE, "sessionId": ID, "path": PATCH_FILE, "offset": 5, "data": "eA=="});
        assert!(write_piece(&fix.to, &bad_offset)
            .unwrap_err()
            .contains("out of order"));
        assert_eq!(
            handle(&fix.to, "stop", &json!({})).unwrap_err(),
            "Unsupported session move step"
        );
    }

    #[test]
    fn reads_only_what_the_manifest_lists() {
        let fix = fixture();
        carry(&fix);
        let folder = fix.from.staging_root.join(MOVE);
        fs::write(folder.join("secret"), "x").unwrap();
        let params = json!({"moveId": MOVE, "path": "secret", "offset": 0});
        assert_eq!(
            read_piece(&fix.from, &params).unwrap_err(),
            "That file is not in this move"
        );
    }

    #[test]
    fn will_not_write_through_a_carried_link() {
        let fix = fixture();
        let (mut manifest, urls) = carry(&fix);
        let outside = fix.base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        manifest["links"] = json!([
            {"path": "untracked/evil", "target": path_text(&outside)},
            {"path": "untracked/evil/x", "target": "y"},
        ]);
        let error = unpack(&fix, "s", &manifest, &urls).unwrap_err();
        assert!(error.contains("through a link"), "{error}");
        assert!(!outside.join("x").exists());
    }

    #[test]
    fn keeps_an_unfinished_record_and_refuses_one_it_cannot_read() {
        let fix = fixture();
        let (manifest, urls) = carry(&fix);
        let code = unpack(&fix, "s", &manifest, &urls).unwrap();
        let record = fix.to.staging_root.join(MOVE).join("made.json");
        assert!(record.is_file());
        drop_stale(&fix.to);
        assert!(record.is_file());
        fs::write(&record, "{\"repo\":\"/x\"").unwrap();
        assert!(undo(&fix.to, &json!({"moveId": MOVE})).is_err());
        assert!(Path::new(code["cwd"].as_str().unwrap()).exists());
    }

    #[test]
    fn normalizes_remote_urls() {
        for url in [
            "git@github.com:Me/app.git",
            "https://github.com/Me/app",
            "https://github.com/Me/app.git/",
            "ssh://git@github.com:22/Me/app.git",
            "https://token@GitHub.com/Me/app",
        ] {
            assert_eq!(normalize_remote_url(url), "github.com/Me/app", "{url}");
        }
        // A cut inside a character must not panic.
        assert_eq!(
            normalize_remote_url("https://example.com/项目"),
            "example.com/项目"
        );
        assert_ne!(
            normalize_remote_url("git@github.com:Me/other.git"),
            "github.com/Me/app"
        );
    }

    #[test]
    fn knows_client_paths() {
        for (path, client) in [
            ("/Users/x/Documents/projects/upwork/acme", true),
            (
                "/Users/x/Documents/projects/UPWORK/acme/.claude/worktrees/a",
                true,
            ),
            ("/Users/x/Documents/projects/upwork", true),
            ("/Users/x/Documents/projects/upwork/panoptic", false),
            ("/Users/x/Documents/projects/upwork/PANOPTIC/repo", false),
            ("/Users/x/Documents/projects/upwork/panoptic-two", true),
            ("/Users/x/Documents/projects/monocode", false),
        ] {
            assert_eq!(is_client_path(path), client, "{path}");
        }
    }

    #[test]
    fn checks_pack_paths_like_the_protocol() {
        for ok in [
            "commits.bundle",
            "changes.patch",
            "untracked/a/b c.txt",
            "convo/session/conv-1.jsonl",
            "convo/session/conv-1/subagents/a.jsonl",
            "convo/history/conv-1/v1",
        ] {
            assert!(pack_path_ok(ok, "conv-1"), "{ok}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "untracked",
            "untracked/../x",
            "untracked/a//b",
            "untracked/.GIT/config",
            "untracked/a\\b",
            "convo/session/other.jsonl",
            "convo/session/other/a",
            "convo/history/conv-1",
            "convo/other/conv-1/a",
            "manifest.json",
            "made.json",
        ] {
            assert!(!pack_path_ok(bad, "conv-1"), "{bad}");
        }
    }

    /// With MOVE_INTEROP_OUT: leaves a dirty repo and its pack for
    /// host/session-move.test.ts to unpack.
    #[test]
    #[ignore]
    fn interop_pack() {
        let out = PathBuf::from(std::env::var("MOVE_INTEROP_OUT").unwrap());
        let fix = fixture_at(out.clone());
        dirty(&fix.source);
        let cwd = path_text(&fix.source);
        let manifest = pack(
            &fix.from,
            &json!({"moveId": MOVE, "cwd": cwd, "sessionId": ID, "remoteName": "origin"}),
        )
        .unwrap();
        fs::write(out.join("manifest.json"), manifest.to_string()).unwrap();
        std::mem::forget(fix);
    }

    /// With MOVE_INTEROP_IN: unpacks what host/session-move.test.ts packed.
    #[test]
    #[ignore]
    fn interop_unpack() {
        let dir = PathBuf::from(std::env::var("MOVE_INTEROP_IN").unwrap());
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let urls: Vec<String> =
            serde_json::from_str(&fs::read_to_string(dir.join("urls.json")).unwrap()).unwrap();
        let to = env_at(&dir.join("lab"));
        let params =
            json!({"moveId": MOVE, "name": "from-host", "manifest": manifest, "urls": urls});
        unpack_code(&to, &params).unwrap();
        unpack_conversation(&to, &json!({"moveId": MOVE, "manifest": manifest})).unwrap();
    }
}
