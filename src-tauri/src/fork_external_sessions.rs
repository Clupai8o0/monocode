//! Fork feature: "Elsewhere". Agent sessions on a project that MonoCode did
//! not start (Claude Code in a terminal, the second account, Codex and the
//! other agents with a session registry), plus recent hand-overs, and one
//! session's transcript. Read-only: nothing here drives, kills or messages a
//! session. Shapes match src/fork/externalSessions/externalSessionsModel.ts.
//! MonoCode's own sessions are dropped by the TS layer, which knows their ids.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const HISTORY_TAIL: u64 = 1024 * 1024;
const MAX_HANDED_OVER: usize = 20;
const HANDOFF_MAX: usize = 64 * 1024;
const CHUNK: u64 = 512 * 1024;
const SCAN_MAX: u64 = 16 * 1024 * 1024;
const PAGE_TEXT_MAX: usize = 200 * 1024;
const TURN_MAX: usize = 4000;
const TOOL_MAX: usize = 200;
const PROC_START_SLACK_MS: i64 = 5_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub project_id: String,
    pub cwd: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    id: String,
    project_id: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff_path: Option<String>,
    has_transcript: bool,
}

#[derive(Serialize)]
pub struct SessionList {
    sessions: Vec<ExternalSession>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Turn {
    role: &'static str,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    at: Option<i64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Handoff {
    path: String,
    text: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct TranscriptPage {
    turns: Vec<Turn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff: Option<Handoff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
}

/// Every external session on these projects, on this Mac; with `only`, the
/// rows of just those project ids, still matched against every project.
#[tauri::command]
pub async fn fork_external_sessions_list(
    projects: Vec<ProjectRef>,
    only: Option<Vec<String>>,
) -> Result<SessionList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::system();
        let only: Option<HashSet<String>> = only.map(|ids| ids.into_iter().collect());
        SessionList {
            sessions: list(&env, &projects, only.as_ref()),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// One page of one session's turns, newest page when `before` is absent.
#[tauri::command]
pub async fn fork_external_sessions_read(
    projects: Vec<ProjectRef>,
    project_id: String,
    session_id: String,
    before: Option<u64>,
    limit: Option<u32>,
) -> Result<TranscriptPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::system();
        read(&env, &projects, &project_id, &session_id, before, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- environment ----

#[derive(Clone, Debug)]
struct Proc {
    pid: i64,
    start_ms: i64,
    args: String,
}

/// The git common dir of a folder, cached on a real machine.
type CommonDir = Box<dyn Fn(&Path) -> Option<PathBuf>>;

/// What the rules read from the machine; tests build their own.
struct Env {
    home: PathBuf,
    now_ms: i64,
    mac: bool,
    /// The process table; None skips the start-time check.
    procs: Option<Vec<Proc>>,
    common_dir: CommonDir,
}

impl Env {
    fn system() -> Env {
        let now_ms = now_ms();
        let mac = !cfg!(target_os = "linux");
        Env {
            home: crate::dirs_home().map(PathBuf::from).unwrap_or_default(),
            now_ms,
            mac,
            procs: Some(process_table(now_ms)),
            common_dir: Box::new(cached_common_dir),
        }
    }
}

/// The second account's folders: `.claude-exec` on every machine, plus an
/// older `.claude-cx` where one is still there (a missing folder reads as
/// empty).
const CX_ACCOUNTS: [&str; 2] = [".claude-exec", ".claude-cx"];

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn process_table(now_ms: i64) -> Vec<Proc> {
    let out = Command::new("ps")
        .args(["-Ao", "pid=,etime=,args="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(out) => parse_ps(&String::from_utf8_lossy(&out.stdout), now_ms),
        Err(_) => Vec::new(),
    }
}

fn parse_ps(text: &str, now_ms: i64) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let rest = rest.trim_start();
            let (etime, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            Some(Proc {
                pid: pid.parse().ok()?,
                start_ms: now_ms - parse_etime(etime)? * 1000,
                args: args.trim().to_string(),
            })
        })
        .collect()
}

/// `[[dd-]hh:]mm:ss` to seconds.
fn parse_etime(text: &str) -> Option<i64> {
    let (days, clock) = match text.split_once('-') {
        Some((d, rest)) => (d.parse::<i64>().ok()?, rest),
        None => (0, text),
    };
    let mut secs = 0;
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    for part in parts {
        secs = secs * 60 + part.parse::<i64>().ok()?;
    }
    Some(days * 86_400 + secs)
}

/// "Wed Oct 28 08:34:18 2026" (UTC) to milliseconds.
fn parse_proc_start(text: &str) -> Option<i64> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month = MONTHS
        .iter()
        .position(|m| parts[1].eq_ignore_ascii_case(m))? as u8
        + 1;
    let day: u8 = parts[2].parse().ok()?;
    let year: i32 = parts[4].parse().ok()?;
    let clock: Vec<u8> = parts[3]
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    if clock.len() != 3 {
        return None;
    }
    let date =
        time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()?;
    let at = date
        .with_hms(clock[0], clock[1], clock[2])
        .ok()?
        .assume_utc();
    Some(at.unix_timestamp() * 1000)
}

fn agent_command(args: &str) -> bool {
    const NAMES: [&str; 6] = ["claude", "codex", "opencode", "dsh", "kimi", "grok"];
    args.split_whitespace().any(|word| {
        let base = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
        NAMES.contains(&base.as_str())
            || base.strip_prefix("grok-macos-").is_some_and(|rest| {
                !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
    })
}

fn is_live(env: &Env, pid: i64, proc_start: Option<&str>) -> bool {
    if pid <= 0 {
        return false;
    }
    // Claude Code on Linux writes clock ticks from /proc; the other agents,
    // and Claude on the Mac, write a UTC time.
    let ticks = proc_start
        .map(str::trim)
        .filter(|s| !env.mac && !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    if let Some(ticks) = ticks {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        return stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(19))
            .is_some_and(|field| field == ticks);
    }
    match &env.procs {
        Some(procs) => {
            let Some(proc) = procs.iter().find(|p| p.pid == pid) else {
                return false;
            };
            match proc_start {
                None => true,
                Some(start) => parse_proc_start(start).is_some_and(|ms| {
                    (proc.start_ms - ms).abs() <= PROC_START_SLACK_MS && agent_command(&proc.args)
                }),
            }
        }
        None => proc_start.is_none() && Path::new(&format!("/proc/{pid}")).exists(),
    }
}

static COMMON_DIRS: LazyLock<Mutex<HashMap<PathBuf, Option<PathBuf>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached_common_dir(path: &Path) -> Option<PathBuf> {
    if let Some(hit) = COMMON_DIRS.lock().ok().and_then(|c| c.get(path).cloned()) {
        return hit;
    }
    let found = git_common_dir(path);
    if let Ok(mut cache) = COMMON_DIRS.lock() {
        cache.insert(path.to_path_buf(), found.clone());
    }
    found
}

fn git_common_dir(path: &Path) -> Option<PathBuf> {
    if !path.is_dir() {
        return None;
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .env("PATH", crate::harness::gui_search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                let line = out.trim();
                return (!line.is_empty()).then(|| PathBuf::from(line));
            }
            Ok(None) if started.elapsed() < GIT_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

// ---- registries ----

#[derive(Clone, Debug)]
struct Record {
    pid: i64,
    session_id: String,
    cwd: String,
    started_at: Option<i64>,
    proc_start: Option<String>,
    name: Option<String>,
    status: Option<String>,
    updated_at: i64,
    source: &'static str,
}

fn registries() -> Vec<(&'static str, &'static str)> {
    vec![
        (".claude/sessions", "claude"),
        (".claude-exec/sessions", "claude-cx"),
        (".claude-cx/sessions", "claude-cx"),
        (".codex/agent-sessions", "codex"),
        (".local/state/opencode/agent-sessions", "opencode"),
        (".dsh/agent-sessions", "dsh"),
        (".kimi-code/agent-sessions", "kimi"),
        (".grok/agent-sessions", "grok"),
    ]
}

fn num(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn parse_record(raw: &str, source: &'static str) -> Option<Record> {
    let v: Value = serde_json::from_str(raw).ok()?;
    // The relay's copies of sessions on other machines are not local sessions.
    if crate::fork_relay::is_relay_entry(&v) {
        return None;
    }
    let proc_start = match &v["procStart"] {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    Some(Record {
        pid: num(&v["pid"])?,
        session_id: text(&v["sessionId"])?,
        cwd: text(&v["cwd"])?,
        started_at: num(&v["startedAt"]),
        proc_start,
        name: text(&v["name"]),
        status: text(&v["status"]),
        updated_at: num(&v["updatedAt"]).unwrap_or(0),
        source,
    })
}

fn mirror_copies(home: &Path) -> HashSet<PathBuf> {
    std::fs::read_to_string(home.join(".local/state/session-mirror.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().map(|m| m.keys().map(PathBuf::from).collect()))
        .unwrap_or_default()
}

/// Every registry record, one per session, before the liveness check.
fn read_records(env: &Env) -> Vec<Record> {
    let copies = if env.mac {
        mirror_copies(&env.home)
    } else {
        HashSet::new()
    };
    let mut by_session: HashMap<String, Record> = HashMap::new();
    for (dir, source) in registries() {
        let Ok(entries) = std::fs::read_dir(env.home.join(dir)) else {
            continue;
        };
        // Newest record per process.
        let mut by_pid: HashMap<i64, Record> = HashMap::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") || copies.contains(&path) {
                continue;
            }
            let Some(record) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| parse_record(&raw, source))
            else {
                continue;
            };
            match by_pid.get(&record.pid) {
                Some(old) if old.updated_at >= record.updated_at => {}
                _ => {
                    by_pid.insert(record.pid, record);
                }
            }
        }
        for record in by_pid.into_values() {
            match by_session.get(&record.session_id) {
                Some(old) if old.updated_at >= record.updated_at => {}
                _ => {
                    by_session.insert(record.session_id.clone(), record);
                }
            }
        }
    }
    by_session.into_values().collect()
}

// ---- projects ----

fn under(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    !root.is_empty()
        && (path == root
            || path
                .strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/')))
}

/// The project whose folder holds `cwd`, else the first sharing its git repo.
fn match_project<'a>(env: &Env, projects: &'a [ProjectRef], cwd: &str) -> Option<&'a ProjectRef> {
    let best = projects
        .iter()
        .filter(|p| under(cwd, &p.cwd))
        .max_by_key(|p| p.cwd.trim_end_matches('/').len());
    if best.is_some() {
        return best;
    }
    let common = (env.common_dir)(Path::new(cwd))?;
    projects
        .iter()
        .find(|p| (env.common_dir)(Path::new(&p.cwd)).as_deref() == Some(common.as_path()))
}

// ---- transcripts ----

/// Kimi and OpenCode ids carry underscores ("session_…", "ses_…").
fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_handoff_name(name: &str) -> bool {
    name.strip_prefix("handoff")
        .and_then(|rest| rest.strip_suffix(".md"))
        .is_some_and(|mid| {
            mid.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
}

fn valid_handoff_rel(path: &str) -> bool {
    path.strip_prefix(".claude/")
        .is_some_and(valid_handoff_name)
}

/// A handoff file's path: `.claude/handoff*.md`, maybe in a worktree.
fn is_handoff_path(path: &str) -> bool {
    let mut parts = path.rsplit('/');
    matches!((parts.next(), parts.next()), (Some(name), Some(".claude")) if valid_handoff_name(name))
}

/// The same check on a real path, by components, so it also holds where
/// paths use `\`.
fn is_handoff_real_path(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str());
    let dir = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str());
    matches!((name, dir), (Some(name), Some(".claude")) if valid_handoff_name(name))
}

/// The real path of a project's handoff file, or None when `rel` is not a
/// handoff file inside the project. A link may point anywhere, so the real
/// path has to be a handoff file too.
fn handoff_file(project: &str, rel: &str) -> Option<PathBuf> {
    if !is_handoff_path(rel) {
        return None;
    }
    let root = std::fs::canonicalize(project).ok()?;
    let file = std::fs::canonicalize(root.join(rel)).ok()?;
    let inside = file.starts_with(&root) && file != root;
    (inside && is_handoff_real_path(&file) && file.is_file()).then_some(file)
}

/// The agent a claims name such as "monocode-cx79" belongs to, when it is
/// not Claude ("monocode-14").
fn agent_of_name(name: Option<&str>) -> Option<&'static str> {
    let (_, tail) = name?.rsplit_once('-')?;
    let tail = tail.as_bytes();
    if tail.len() != 4
        || !tail[2..]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    {
        return None;
    }
    match &tail[..2] {
        b"cx" => Some("codex"),
        b"oc" => Some("opencode"),
        b"ds" => Some("dsh"),
        b"km" => Some("kimi"),
        b"gk" => Some("grok"),
        _ => None,
    }
}

fn project_key(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Where a Claude session's transcript is, and which account holds it.
fn find_transcript(
    env: &Env,
    source: &str,
    cwd: &str,
    id: &str,
) -> Option<(PathBuf, &'static str)> {
    if !valid_session_id(id) {
        return None;
    }
    let cx = CX_ACCOUNTS.map(|account| (account, "claude-cx"));
    let file = format!("{id}.jsonl");
    let key = project_key(cwd);
    let mut ordered = vec![(".claude", "claude")];
    if source == "claude-cx" {
        ordered.splice(0..0, cx);
    } else {
        ordered.extend(cx);
    }
    if let Some((account, src)) = ordered.first() {
        let direct = env
            .home
            .join(account)
            .join("projects")
            .join(&key)
            .join(&file);
        if direct.is_file() {
            return Some((direct, src));
        }
    }
    for (account, src) in ordered {
        let Ok(dirs) = std::fs::read_dir(env.home.join(account).join("projects")) else {
            continue;
        };
        for dir in dirs.flatten() {
            let candidate = dir.path().join(&file);
            if candidate.is_file() {
                return Some((candidate, src));
            }
        }
    }
    None
}

fn is_claude(source: &str) -> bool {
    source == "claude" || source == "claude-cx"
}

// ---- history ----

#[derive(Clone, Debug)]
struct Note {
    at: f64,
    name: Option<String>,
    worktree: Option<String>,
    branch: Option<String>,
    text: String,
}

fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf).ok()?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        text = text
            .split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default();
    }
    Some(text)
}

/// The latest note per session from the last week of a repo's history.
fn latest_notes(env: &Env, common: &Path) -> HashMap<String, Note> {
    let mut latest: HashMap<String, Note> = HashMap::new();
    let Some(body) = read_tail(&common.join("claude-claims-history.jsonl"), HISTORY_TAIL) else {
        return latest;
    };
    let since = (env.now_ms - WEEK_MS) as f64 / 1000.0;
    for line in body.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["event"] != "note" {
            continue;
        }
        let (Some(at), Some(session)) = (v["at"].as_f64(), text(&v["session"])) else {
            continue;
        };
        if at < since {
            continue;
        }
        let note = Note {
            at,
            // claims.py writes "?" when it has no name for the session.
            name: text(&v["name"]).filter(|name| name != "?"),
            worktree: text(&v["worktree"]),
            branch: text(&v["branch"]),
            text: v["text"].as_str().unwrap_or("").to_string(),
        };
        if latest.get(&session).is_none_or(|old| old.at <= at) {
            latest.insert(session, note);
        }
    }
    latest
}

fn handed_over(note: &str) -> bool {
    note.trim_start()
        .get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("handed over"))
}

/// Lexically resolve `.` and `..`.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// The handoff file a "handed over: <path>" note names, relative to the project.
fn note_handoff(env: &Env, note: &Note, project: &str) -> Option<String> {
    let lower = note.text.to_ascii_lowercase();
    let at = lower.find("handed over:")?;
    let rest = note.text[at + "handed over:".len()..].trim_start();
    let raw = rest.split_whitespace().next()?;
    let raw = raw.trim_end_matches(|c: char| ".,;:!?)]}>\"'`".contains(c));
    if raw.is_empty() {
        return None;
    }
    let path = if let Some(tail) = raw.strip_prefix("~/") {
        env.home.join(tail)
    } else {
        let base = note.worktree.as_deref().unwrap_or(project);
        Path::new(base).join(raw)
    };
    let path = normalize(&path);
    let rel = path.strip_prefix(normalize(Path::new(project))).ok()?;
    let rel = rel.to_str()?.to_string();
    handoff_file(project, &rel).map(|_| rel)
}

// ---- list ----

/// The rows of every project, or of the ids in `only`. Sessions are matched
/// against all `projects`, so a nested project keeps its own, but only the
/// wanted projects' history and handoff files are read.
fn list(
    env: &Env,
    projects: &[ProjectRef],
    only: Option<&HashSet<String>>,
) -> Vec<ExternalSession> {
    let wanted = |id: &str| only.is_none_or(|ids| ids.contains(id));
    let records = read_records(env);
    let live: Vec<Record> = records
        .into_iter()
        .filter(|r| is_live(env, r.pid, r.proc_start.as_deref()))
        .collect();
    let live_ids: HashSet<String> = live.iter().map(|r| r.session_id.clone()).collect();

    let mut rows: Vec<ExternalSession> = Vec::new();
    for record in &live {
        if !valid_session_id(&record.session_id) {
            continue;
        }
        let Some(project) = match_project(env, projects, &record.cwd) else {
            continue;
        };
        if !wanted(&project.project_id) {
            continue;
        }
        let mut source = record.source;
        let mut has_transcript = false;
        if is_claude(source) {
            if let Some((_, found)) = find_transcript(env, source, &record.cwd, &record.session_id)
            {
                source = found;
                has_transcript = true;
            }
        }
        rows.push(ExternalSession {
            id: record.session_id.clone(),
            project_id: project.project_id.clone(),
            source: source.to_string(),
            name: record.name.clone(),
            cwd: record.cwd.clone(),
            branch: None,
            state: if record.status.as_deref() == Some("idle") {
                "idle"
            } else {
                "running"
            },
            started_at: record.started_at,
            updated_at: Some(record.updated_at).filter(|t| *t > 0),
            note: None,
            handoff_path: None,
            has_transcript,
        });
    }

    // Notes and hand-overs, one history file per repo.
    let mut seen_common: HashSet<PathBuf> = HashSet::new();
    let mut handed: Vec<ExternalSession> = Vec::new();
    for project in projects.iter().filter(|p| wanted(&p.project_id)) {
        let Some(common) = (env.common_dir)(Path::new(&project.cwd)) else {
            continue;
        };
        if !seen_common.insert(common.clone()) {
            continue;
        }
        for (session, note) in latest_notes(env, &common) {
            if live_ids.contains(&session) {
                for row in rows.iter_mut().filter(|r| r.id == session) {
                    if !note.text.is_empty() {
                        row.note = Some(note.text.clone());
                    }
                    if row.branch.is_none() {
                        row.branch = note.branch.clone();
                    }
                }
                continue;
            }
            if !handed_over(&note.text) || !valid_session_id(&session) {
                continue;
            }
            let cwd = note.worktree.clone().unwrap_or_else(|| project.cwd.clone());
            let owner = match_project(env, projects, &cwd).unwrap_or(project);
            if !wanted(&owner.project_id) {
                continue;
            }
            let agent = agent_of_name(note.name.as_deref());
            let found = if agent.is_some() {
                None
            } else {
                find_transcript(env, "claude", &cwd, &session)
            };
            handed.push(ExternalSession {
                id: session.clone(),
                project_id: owner.project_id.clone(),
                source: found
                    .as_ref()
                    .map(|f| f.1)
                    .or(agent)
                    .unwrap_or("claude")
                    .to_string(),
                name: note.name.clone(),
                cwd,
                branch: note.branch.clone(),
                state: "handed-over",
                started_at: None,
                updated_at: Some((note.at * 1000.0) as i64),
                note: Some(note.text.clone()),
                handoff_path: note_handoff(env, &note, &owner.cwd),
                has_transcript: found.is_some(),
            });
        }
    }

    // Handoff files no row names yet.
    for project in projects.iter().filter(|p| wanted(&p.project_id)) {
        let named: HashSet<String> = handed
            .iter()
            .filter(|r| r.project_id == project.project_id)
            .filter_map(|r| r.handoff_path.clone())
            .collect();
        let Ok(entries) = std::fs::read_dir(Path::new(&project.cwd).join(".claude")) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            let rel = format!(".claude/{file}");
            if !valid_handoff_rel(&rel) || named.contains(&rel) {
                continue;
            }
            // Checked the way a read is, so nothing outside the project is
            // listed (a linked .claude folder, say).
            let Some(mtime) = handoff_file(&project.cwd, &rel)
                .and_then(|real| std::fs::metadata(real).ok())
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
            else {
                continue;
            };
            if mtime < env.now_ms - WEEK_MS {
                continue;
            }
            handed.push(ExternalSession {
                id: format!("handoff:{rel}"),
                project_id: project.project_id.clone(),
                source: "claude".into(),
                name: Some(file),
                cwd: project.cwd.clone(),
                branch: None,
                state: "handed-over",
                started_at: None,
                updated_at: Some(mtime),
                note: None,
                handoff_path: Some(rel),
                has_transcript: false,
            });
        }
    }

    rows.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
    handed.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
    let mut per_project: HashMap<String, usize> = HashMap::new();
    for row in handed {
        let count = per_project.entry(row.project_id.clone()).or_default();
        if *count < MAX_HANDED_OVER {
            *count += 1;
            rows.push(row);
        }
    }
    rows
}

// ---- read ----

fn read(
    env: &Env,
    projects: &[ProjectRef],
    project_id: &str,
    session_id: &str,
    before: Option<u64>,
    limit: Option<u32>,
) -> Result<TranscriptPage, String> {
    let handoff_only = match session_id.strip_prefix("handoff:") {
        Some(rel) => {
            if !valid_handoff_rel(rel) {
                return Err("Session not found".into());
            }
            true
        }
        None => {
            if !valid_session_id(session_id) {
                return Err("Session not found".into());
            }
            false
        }
    };
    let project = projects
        .iter()
        .find(|p| p.project_id == project_id)
        .ok_or("Session not found")?;
    let row = list(
        env,
        projects,
        Some(&HashSet::from([project_id.to_string()])),
    )
    .into_iter()
    .find(|r| r.project_id == project_id && r.id == session_id)
    .ok_or("Session not found")?;
    let handoff = if before.is_none() {
        row.handoff_path
            .as_deref()
            .and_then(|rel| read_handoff(&project.cwd, rel))
    } else {
        None
    };
    if handoff_only || !row.has_transcript {
        return Ok(TranscriptPage {
            turns: Vec::new(),
            handoff,
            ..Default::default()
        });
    }
    let Some((path, _)) = find_transcript(env, &row.source, &row.cwd, &row.id) else {
        return Ok(TranscriptPage {
            turns: Vec::new(),
            handoff,
            ..Default::default()
        });
    };
    let limit = limit.unwrap_or(60).clamp(1, 200) as usize;
    let mut page = read_page(&path, before, limit)
        .map_err(|e| format!("Could not read the transcript: {e}"))?;
    page.handoff = handoff;
    Ok(page)
}

fn read_handoff(project: &str, rel: &str) -> Option<Handoff> {
    let file = handoff_file(project, rel)?;
    let mut buf = Vec::new();
    File::open(&file)
        .ok()?
        .take(HANDOFF_MAX as u64)
        .read_to_end(&mut buf)
        .ok()?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // A cut may split a character; lossy decoding leaves a replacement mark.
    if buf.len() == HANDOFF_MAX && text.ends_with('\u{FFFD}') {
        text.pop();
    }
    Some(Handoff {
        path: rel.to_string(),
        text,
    })
}

/// Read backward from `before` (or the end) in chunks, a page of whole lines.
fn read_page(path: &Path, before: Option<u64>, limit: usize) -> std::io::Result<TranscriptPage> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let end = before.unwrap_or(size).min(size);
    let mut pos = end;
    // Bytes from `pos` up to the oldest line already handled.
    let mut tail: Vec<u8> = Vec::new();
    let mut lines: Vec<(u64, Vec<Turn>)> = Vec::new();
    let mut count = 0;
    let mut scanned = 0u64;
    let mut truncated = false;
    let mut oldest: Option<u64> = None;
    'scan: while pos > 0 && count < limit && scanned < SCAN_MAX {
        let start = pos.saturating_sub(CHUNK);
        let mut data = vec![0u8; (pos - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut data)?;
        scanned += data.len() as u64;
        data.extend_from_slice(&tail);
        let mut stop = data.len();
        loop {
            let body_end = if stop > 0 && data[stop - 1] == b'\n' {
                stop - 1
            } else {
                stop
            };
            let line_start = match data[..body_end].iter().rposition(|b| *b == b'\n') {
                Some(i) => i + 1,
                None if start == 0 => 0,
                None => {
                    tail = data[..stop].to_vec();
                    break;
                }
            };
            let offset = start + line_start as u64;
            if body_end > line_start {
                let turns = parse_line(&data[line_start..body_end], &mut truncated);
                count += turns.len();
                if !turns.is_empty() {
                    lines.push((offset, turns));
                }
            }
            oldest = Some(offset);
            stop = line_start;
            if count >= limit || line_start == 0 {
                break 'scan;
            }
        }
        pos = start;
    }
    // A line longer than the whole scan is skipped, or paging would stop on it.
    if oldest.is_none() && pos > 0 {
        oldest = Some(pos);
        truncated = true;
    }
    // Newest first here. Whole lines only, up to the turn limit and the text
    // cap; the rest waits for the next page. Only a newest line too big for a
    // page on its own is cut, keeping its newest turns.
    let mut kept: Vec<Vec<Turn>> = Vec::new();
    let mut last_kept: Option<u64> = None;
    let mut total = 0;
    let mut bytes = 0;
    for (offset, turns) in lines {
        let size: usize = turns.iter().map(|t| t.text.len()).sum();
        if total + turns.len() <= limit && bytes + size <= PAGE_TEXT_MAX {
            total += turns.len();
            bytes += size;
            kept.push(turns);
            last_kept = Some(offset);
            continue;
        }
        if kept.is_empty() {
            let mut part: Vec<Turn> = Vec::new();
            for turn in turns.into_iter().rev() {
                if part.len() >= limit
                    || (!part.is_empty() && bytes + turn.text.len() > PAGE_TEXT_MAX)
                {
                    break;
                }
                bytes += turn.text.len();
                part.push(turn);
            }
            part.reverse();
            kept.push(part);
            oldest = Some(offset);
            truncated = true;
        } else {
            oldest = last_kept;
        }
        break;
    }
    let before = oldest.filter(|o| *o > 0);
    let turns = kept.into_iter().rev().flatten().collect();
    Ok(TranscriptPage {
        turns,
        before,
        handoff: None,
        truncated: truncated.then_some(true),
    })
}

fn cut(text: &str, max: usize, truncated: &mut bool) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    *truncated = true;
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

fn strip_reminders(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("<system-reminder>") {
        out.push_str(&rest[..i]);
        match rest[i..].find("</system-reminder>") {
            Some(j) => rest = &rest[i + j + "</system-reminder>".len()..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_line(raw: &[u8], truncated: &mut bool) -> Vec<Turn> {
    let Ok(v) = serde_json::from_slice::<Value>(raw) else {
        return Vec::new();
    };
    if v["isSidechain"] == true || v["isMeta"] == true {
        return Vec::new();
    }
    let at = v["timestamp"].as_str().and_then(|s| {
        time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
            .ok()
            .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64)
    });
    let content = &v["message"]["content"];
    let mut turns = Vec::new();
    match v["type"].as_str() {
        Some("user") => {
            let joined = match content {
                Value::String(s) => s.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            let stripped = strip_reminders(&joined);
            let trimmed = stripped.trim();
            const SKIP: [&str; 6] = [
                "<local-command-stdout>",
                "<local-command-caveat>",
                "<command-name>",
                "<command-message>",
                "<command-args>",
                "<task-notification>",
            ];
            if !trimmed.is_empty() && !SKIP.iter().any(|p| trimmed.starts_with(p)) {
                turns.push(Turn {
                    role: "user",
                    text: cut(trimmed, TURN_MAX, truncated),
                    at,
                });
            }
        }
        Some("assistant") => {
            for part in content.as_array().into_iter().flatten() {
                match part["type"].as_str() {
                    Some("text") => {
                        let text = part["text"].as_str().unwrap_or("").trim();
                        if !text.is_empty() {
                            turns.push(Turn {
                                role: "assistant",
                                text: cut(text, TURN_MAX, truncated),
                                at,
                            });
                        }
                    }
                    Some("tool_use") => {
                        let name = part["name"].as_str().unwrap_or("tool");
                        let input = &part["input"];
                        let detail = [
                            "command",
                            "file_path",
                            "path",
                            "pattern",
                            "description",
                            "prompt",
                        ]
                        .iter()
                        .find_map(|key| input[*key].as_str())
                        .map(|s| s.lines().next().unwrap_or("").to_string());
                        let line = match detail {
                            Some(d) => format!("{name}: {d}"),
                            None => name.to_string(),
                        };
                        let mut ignored = false;
                        turns.push(Turn {
                            role: "tool",
                            text: cut(&line, TOOL_MAX, &mut ignored),
                            at,
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const NOW: i64 = 1_800_000_000_000;

    fn temp() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "monocode-ext-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn env(home: &Path, procs: Vec<Proc>) -> Env {
        Env {
            home: home.to_path_buf(),
            now_ms: NOW,
            mac: true,
            procs: Some(procs),
            common_dir: Box::new(|p: &Path| {
                let mut dir = Some(p);
                while let Some(d) = dir {
                    if d.join(".git").is_dir() {
                        return Some(d.join(".git"));
                    }
                    dir = d.parent();
                }
                None
            }),
        }
    }

    fn proc(pid: i64) -> Proc {
        Proc {
            pid,
            start_ms: NOW - 60_000,
            args: "/usr/local/bin/claude --resume".into(),
        }
    }

    fn rec(pid: i64, id: &str, cwd: &Path, updated: i64, extra: &str) -> String {
        format!(
            r#"{{"pid":{pid},"sessionId":"{id}","cwd":"{}","startedAt":1,"updatedAt":{updated}{extra}}}"#,
            cwd.display()
        )
    }

    fn project(id: &str, cwd: &Path) -> ProjectRef {
        ProjectRef {
            project_id: id.into(),
            cwd: cwd.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn filters_and_dedupes_registries() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let s = home.join(".claude/sessions");
        write(
            &s.join("1.json"),
            &rec(1, "aaaaaaaa-1", &repo, 10, r#","status":"idle""#),
        );
        write(&s.join("2.json"), &rec(2, "dead0000-2", &repo, 10, ""));
        write(&s.join("3.json"), "{not json");
        write(&s.join("4.json"), r#"{"pid":4,"cwd":"/x"}"#);
        write(&s.join("5.key"), &rec(1, "secretkey-5", &repo, 99, ""));
        // Several files for one codex process: the newest wins.
        let c = home.join(".codex/agent-sessions");
        write(&c.join("7.json"), &rec(7, "codexold-7", &repo, 5, ""));
        write(
            &c.join("7-a.json"),
            &rec(7, "codexnew-7", &repo, 50, r#","status":"busy""#),
        );
        // The same session in both accounts: newest updatedAt wins.
        write(
            &home.join(".claude-exec/sessions/8.json"),
            &rec(8, "aaaaaaaa-1", &repo, 30, ""),
        );
        let e = env(&home, vec![proc(1), proc(7), proc(8)]);
        let rows = list(&e, &[project("p", &repo)], None);
        let ids: Vec<(&str, &str, &str)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.source.as_str(), r.state))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("codexnew-7", "codex", "running"),
                ("aaaaaaaa-1", "claude-cx", "running")
            ]
        );
        let json = serde_json::to_value(&rows[0]).unwrap();
        assert!(json.get("pid").is_none() && json.get("note").is_none());
        assert_eq!(json["projectId"], "p");
        assert_eq!(json["hasTranscript"], false);
    }

    #[test]
    fn skips_mirror_copies_and_checks_proc_start() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let copy = home.join(".claude-exec/sessions/1.json");
        write(&copy, &rec(1, "copycopy-1", &repo, 99, ""));
        write(
            &home.join(".local/state/session-mirror.json"),
            &format!(r#"{{"{}":"/orig"}}"#, copy.display()),
        );
        let ps = "Wed Oct 28 08:34:18 2026";
        let started = parse_proc_start(ps).unwrap();
        write(
            &home.join(".claude/sessions/2.json"),
            &rec(
                2,
                "livelive-2",
                &repo,
                1,
                &format!(r#","procStart":"{ps}""#),
            ),
        );
        write(
            &home.join(".claude/sessions/3.json"),
            &rec(
                3,
                "reused00-3",
                &repo,
                1,
                r#","procStart":"Wed Oct 28 08:34:18 2020""#,
            ),
        );
        let at = |pid: i64| Proc {
            start_ms: started + 2_000,
            ..proc(pid)
        };
        let mut other = at(4);
        other.args = "/bin/zsh".into();
        write(
            &home.join(".claude/sessions/4.json"),
            &rec(
                4,
                "notagent-4",
                &repo,
                1,
                &format!(r#","procStart":"{ps}""#),
            ),
        );
        let e = env(&home, vec![proc(1), at(2), at(3), other]);
        let ids: Vec<String> = list(&e, &[project("p", &repo)], None)
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["livelive-2"]);
    }

    #[test]
    fn parses_ps_and_times() {
        assert_eq!(parse_etime("05:03"), Some(303));
        assert_eq!(parse_etime("1:00:00"), Some(3600));
        assert_eq!(parse_etime("2-01:00:00"), Some(176_400));
        assert_eq!(parse_etime("x"), None);
        let procs = parse_ps(
            "  12   01:00 /opt/claude --x\n  9 1-00:00:00 codex\n",
            1_000_000_000,
        );
        assert_eq!(procs[0].pid, 12);
        assert_eq!(procs[0].start_ms, 1_000_000_000 - 60_000);
        assert_eq!(procs[0].args, "/opt/claude --x");
        assert_eq!(procs[1].start_ms, 1_000_000_000 - 86_400_000);
        assert_eq!(
            parse_proc_start("Wed Oct 28 08:34:18 2026"),
            Some(1_793_176_458_000)
        );
        assert!(agent_command("node /usr/bin/claude"));
        assert!(agent_command("grok-macos-arm64 run"));
        assert!(!agent_command("claudette"));
        assert!(!agent_command("/bin/zsh"));
    }

    #[test]
    fn lists_only_the_asked_projects() {
        let home = temp();
        let a = home.join("a");
        let ab = home.join("a/b");
        std::fs::create_dir_all(a.join(".git")).unwrap();
        std::fs::create_dir_all(&ab).unwrap();
        write(
            &home.join(".claude/sessions/31.json"),
            &rec(31, "aaaaaaaa-31", &a, 1, ""),
        );
        write(
            &home.join(".claude/sessions/32.json"),
            &rec(32, "bbbbbbbb-32", &ab, 2, ""),
        );
        write(&ab.join(".claude/handoff.md"), "b's handoff");
        let e = Env {
            now_ms: now_ms(),
            ..env(&home, vec![proc(31), proc(32)])
        };
        let projects = [project("a", &a), project("ab", &ab)];
        let rows = |only: Option<&HashSet<String>>| -> Vec<String> {
            let mut rows: Vec<String> = list(&e, &projects, only)
                .into_iter()
                .map(|r| format!("{} {}", r.project_id, r.id))
                .collect();
            rows.sort();
            rows
        };
        // The nested project's session stays its own, so "a" shows only its.
        assert_eq!(
            rows(Some(&HashSet::from(["a".to_string()]))),
            vec!["a aaaaaaaa-31"]
        );
        assert_eq!(
            rows(None),
            vec![
                "a aaaaaaaa-31",
                "ab bbbbbbbb-32",
                "ab handoff:.claude/handoff.md"
            ]
        );
        assert!(read(&e, &projects, "a", "bbbbbbbb-32", None, None).is_err());
        assert!(read(&e, &projects, "ab", "bbbbbbbb-32", None, None).is_ok());
    }

    #[test]
    fn matches_projects() {
        let home = temp();
        let a = home.join("a");
        let ab = home.join("a/b");
        let wt = home.join("elsewhere/wt");
        std::fs::create_dir_all(a.join(".git")).unwrap();
        std::fs::create_dir_all(&ab).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        let projects = [project("a", &a), project("ab", &ab)];
        let e = env(&home, vec![]);
        let at = |p: &Path| {
            match_project(&e, &projects, p.to_str().unwrap()).map(|p| p.project_id.clone())
        };
        assert_eq!(at(&a.join(".claude/worktrees/x")), Some("a".into()));
        assert_eq!(at(&ab.join("c")), Some("ab".into()));
        assert_eq!(at(&home.join("abc")), None);
        assert_eq!(at(&wt), None);
        // Same repo by git common dir.
        let e = Env {
            common_dir: Box::new({
                let wt = wt.clone();
                let a = a.clone();
                move |p: &Path| (p == wt || p == a).then(|| PathBuf::from("/common"))
            }),
            ..env(&home, vec![])
        };
        assert_eq!(
            match_project(&e, &projects, wt.to_str().unwrap()).map(|p| p.project_id.clone()),
            Some("a".into())
        );
    }

    #[test]
    fn notes_and_handed_over_rows() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write(&repo.join(".claude/handoff.md"), "# left to do\n");
        write(
            &home.join(".claude/sessions/1.json"),
            &rec(1, "livelive-1", &repo, 5, ""),
        );
        let now = NOW as f64 / 1000.0;
        let line = |at: f64, session: &str, text: &str| {
            format!(
                r#"{{"at":{at},"event":"note","session":"{session}","name":"n-{session}","worktree":"{}","branch":"main","text":"{text}"}}"#,
                repo.display()
            )
        };
        let history = [
            "partial line from a cut".to_string(),
            line(now - 100.0, "livelive-1", "old note"),
            line(now - 50.0, "livelive-1", "doing tests"),
            line(now - 40.0, "gonegone-2", "Handed over: .claude/handoff.md."),
            line(now - 30.0, "gonegone-3", "just a note"),
            line(now - 8.0 * 86400.0, "ancient0-4", "handed over: x"),
            line(now - 20.0, "gonegone-5", "handed over: ../../etc/passwd"),
            r#"{"at":1,"event":"claim","session":"x"}"#.to_string(),
        ]
        .join("\n");
        write(&repo.join(".git/claude-claims-history.jsonl"), &history);
        // gonegone-2's transcript lives under the second account.
        let key = project_key(repo.to_str().unwrap());
        write(
            &home
                .join(".claude-exec/projects")
                .join(&key)
                .join("gonegone-2.jsonl"),
            "",
        );
        let e = env(&home, vec![proc(1)]);
        let rows = list(&e, &[project("p", &repo)], None);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["livelive-1", "gonegone-5", "gonegone-2"]);
        assert_eq!(rows[0].note.as_deref(), Some("doing tests"));
        assert_eq!(rows[0].branch.as_deref(), Some("main"));
        assert_eq!(rows[1].handoff_path, None);
        let h = &rows[2];
        assert_eq!(h.state, "handed-over");
        assert_eq!(h.source, "claude-cx");
        assert!(h.has_transcript);
        assert_eq!(h.handoff_path.as_deref(), Some(".claude/handoff.md"));
        assert_eq!(h.updated_at, Some(NOW - 40_000));
        assert_eq!(h.name.as_deref(), Some("n-gonegone-2"));
    }

    #[test]
    fn handoff_file_rows() {
        let home = temp();
        let repo = home.join("repo");
        write(&repo.join(".claude/handoff-ui.md"), "ui work");
        write(&repo.join(".claude/notes.md"), "not a handoff");
        let e = Env {
            now_ms: now_ms(),
            ..env(&home, vec![])
        };
        let rows = list(&e, &[project("p", &repo)], None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "handoff:.claude/handoff-ui.md");
        assert_eq!(rows[0].name.as_deref(), Some("handoff-ui.md"));
        assert!(!rows[0].has_transcript);
        let page = read(
            &e,
            &[project("p", &repo)],
            "p",
            "handoff:.claude/handoff-ui.md",
            None,
            None,
        )
        .unwrap();
        assert!(page.turns.is_empty());
        assert_eq!(page.handoff.unwrap().text, "ui work");
        // Old files are left out.
        let e = Env {
            now_ms: now_ms() + 8 * 86_400_000,
            ..env(&home, vec![])
        };
        assert!(list(&e, &[project("p", &repo)], None).is_empty());
    }

    #[test]
    fn rejects_bad_ids_and_traversal() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write(&home.join("secret.md"), "nope");
        let e = Env {
            now_ms: now_ms(),
            ..env(&home, vec![])
        };
        let projects = [project("p", &repo)];
        for id in [
            "short",
            "../../etc/passwd",
            "handoff:../secret.md",
            "handoff:.claude/../../secret.md",
            "handoff:.claude/handoff/x.md",
        ] {
            assert_eq!(
                read(&e, &projects, "p", id, None, None).unwrap_err(),
                "Session not found",
                "{id}"
            );
        }
        assert_eq!(
            read(&e, &projects, "p", "missing0-session", None, None).unwrap_err(),
            "Session not found"
        );
        assert!(read_handoff(repo.to_str().unwrap(), "../secret.md").is_none());
        assert!(valid_handoff_rel(".claude/handoff.md"));
        assert!(!valid_handoff_rel(".claude/handoff/../x.md"));
    }

    #[test]
    fn parses_transcript_lines() {
        let mut t = false;
        let user = r#"{"type":"user","timestamp":"2026-10-28T08:00:00.000Z","message":{"content":"hi<system-reminder>secret</system-reminder> there"}}"#;
        let turns = parse_line(user.as_bytes(), &mut t);
        assert_eq!(
            turns,
            vec![Turn {
                role: "user",
                text: "hi there".into(),
                at: Some(1_793_174_400_000)
            }]
        );
        for skip in [
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"content":"side"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
            "not json",
        ] {
            assert!(parse_line(skip.as_bytes(), &mut t).is_empty(), "{skip}");
        }
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Done."},{"type":"tool_use","name":"Bash","input":{"description":"d","command":"ls\nmore"}}]}}"#;
        let turns = parse_line(asst.as_bytes(), &mut t);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].text, "Done.");
        assert_eq!(turns[1].role, "tool");
        assert_eq!(turns[1].text, "Bash: ls");
        assert!(!t);
        let long = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(5000)
        );
        let turns = parse_line(long.as_bytes(), &mut t);
        assert_eq!(turns[0].text.chars().count(), 4000);
        assert!(turns[0].text.ends_with('…'));
        assert!(t);
    }

    #[test]
    fn pages_backward_across_chunks() {
        let dir = temp();
        let path = dir.join("t.jsonl");
        let mut file = File::create(&path).unwrap();
        let mut offsets = Vec::new();
        let mut at = 0u64;
        // About 1.6 MB: lines straddle several 512 KB chunk edges.
        let pad = "p".repeat(3000);
        for i in 0..520 {
            let line = format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"m{i} {}\"}}}}\n",
                if i % 2 == 0 { pad.as_str() } else { "" }
            );
            offsets.push(at);
            at += line.len() as u64;
            file.write_all(line.as_bytes()).unwrap();
        }
        // A sidechain line is skipped but still scanned.
        file.write_all(
            b"{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"content\":\"x\"}}\n",
        )
        .unwrap();
        drop(file);
        let mut seen = Vec::new();
        let mut before = None;
        let mut pages = 0;
        loop {
            let page = read_page(&path, before, 50).unwrap();
            pages += 1;
            let mut names: Vec<String> = page
                .turns
                .iter()
                .map(|t| t.text.split(' ').next().unwrap().to_string())
                .collect();
            names.extend(seen);
            seen = names;
            if let Some(b) = page.before {
                assert!(offsets.contains(&b));
            }
            match page.before {
                Some(b) => before = Some(b),
                None => break,
            }
            assert!(pages < 100);
        }
        let expect: Vec<String> = (0..520).map(|i| format!("m{i}")).collect();
        assert_eq!(seen, expect);
        // A page stays under the text cap; older lines wait for the next page.
        let page = read_page(&path, None, 200).unwrap();
        let size: usize = page.turns.iter().map(|t| t.text.len()).sum();
        assert!(size <= PAGE_TEXT_MAX);
        assert_eq!(page.truncated, None);
    }

    #[test]
    fn pages_whole_lines_and_cuts_only_a_line_too_big() {
        let dir = temp();
        let path = dir.join("t.jsonl");
        let tools = |tag: &str| {
            let parts: Vec<String> = (1..=3)
                .map(|n| format!(r#"{{"type":"tool_use","name":"{tag}{n}","input":{{}}}}"#))
                .collect();
            format!(
                r#"{{"type":"assistant","message":{{"content":[{}]}}}}"#,
                parts.join(",")
            ) + "\n"
        };
        write(&path, &(tools("a") + &tools("b")));
        let page = read_page(&path, None, 4).unwrap();
        let texts: Vec<&str> = page.turns.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec!["b1", "b2", "b3"]);
        assert_eq!(page.truncated, None);
        let next = read_page(&path, page.before, 4).unwrap();
        let texts: Vec<&str> = next.turns.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec!["a1", "a2", "a3"]);
        assert_eq!(next.before, None);

        // One line bigger than a page keeps its newest turns.
        let parts: Vec<String> = (0..300)
            .map(|i| format!(r#"{{"type":"text","text":"t{i:03} {}"}}"#, "w".repeat(2995)))
            .collect();
        let big = format!(
            r#"{{"type":"assistant","message":{{"content":[{}]}}}}"#,
            parts.join(",")
        );
        write(
            &path,
            &format!("{{\"type\":\"user\",\"message\":{{\"content\":\"hello\"}}}}\n{big}\n"),
        );
        let page = read_page(&path, None, 200).unwrap();
        assert_eq!(page.truncated, Some(true));
        assert_eq!(page.turns.len(), PAGE_TEXT_MAX / 3000);
        assert!(page.turns.last().unwrap().text.starts_with("t299 "));
        let next = read_page(&path, page.before, 200).unwrap();
        assert_eq!(
            next.turns
                .iter()
                .map(|t| t.text.as_str())
                .collect::<Vec<_>>(),
            vec!["hello"]
        );
        let few = read_page(&path, None, 5).unwrap();
        let heads: Vec<&str> = few.turns.iter().map(|t| &t.text[..4]).collect();
        assert_eq!(heads, vec!["t295", "t296", "t297", "t298", "t299"]);
    }

    #[test]
    fn moves_past_a_line_longer_than_the_scan() {
        let dir = temp();
        let path = dir.join("t.jsonl");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"first\"}}\n")
            .unwrap();
        file.write_all(&vec![b'x'; 17 * 1024 * 1024]).unwrap();
        file.write_all(b"\n{\"type\":\"user\",\"message\":{\"content\":\"last\"}}\n")
            .unwrap();
        drop(file);
        let mut texts = Vec::new();
        let mut before = None;
        let mut cut = false;
        for _ in 0..5 {
            let page = read_page(&path, before, 60).unwrap();
            texts.extend(page.turns.into_iter().map(|t| t.text));
            cut |= page.truncated == Some(true);
            before = page.before;
            if before.is_none() {
                break;
            }
        }
        assert_eq!(texts, vec!["last", "first"]);
        assert!(before.is_none() && cut);
    }

    #[test]
    fn skips_relay_copies_and_reads_both_cx_folders() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // Copies the relay writes for sessions on other machines.
        write(
            &home.join(".claude/sessions/1000000001.json"),
            &rec(
                1,
                "relayrelay-1",
                &repo,
                9,
                r#","pidDomain":"relay:vivobook","monocodeRelay":{"machine":"vivobook"}"#,
            ),
        );
        write(
            &home.join(".claude/sessions/2.json"),
            &rec(
                2,
                "relaydomain-2",
                &repo,
                9,
                r#","pidDomain":"relay:lenovo""#,
            ),
        );
        // The cx account is .claude-exec off the Mac too, and an old
        // .claude-cx folder is still read.
        write(
            &home.join(".claude-exec/sessions/3.json"),
            &rec(3, "execexec-3", &repo, 3, ""),
        );
        write(
            &home.join(".claude-cx/sessions/4.json"),
            &rec(4, "oldcxold-4", &repo, 4, ""),
        );
        let e = Env {
            mac: false,
            ..env(&home, vec![proc(1), proc(2), proc(3), proc(4)])
        };
        let mut rows: Vec<(String, String)> = list(&e, &[project("p", &repo)], None)
            .into_iter()
            .map(|r| (r.id, r.source))
            .collect();
        rows.sort();
        assert_eq!(
            rows,
            vec![
                ("execexec-3".to_string(), "claude-cx".to_string()),
                ("oldcxold-4".to_string(), "claude-cx".to_string())
            ]
        );
    }

    #[test]
    fn linux_agent_records_use_the_process_table() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let ps = "Wed Oct 28 08:34:18 2026";
        let started = parse_proc_start(ps).unwrap();
        let utc = format!(r#","procStart":"{ps}""#);
        write(
            &home.join(".kimi-code/agent-sessions/21.json"),
            &rec(21, "session_live-1", &repo, 2, &utc),
        );
        write(
            &home.join(".dsh/agent-sessions/22.json"),
            &rec(22, "session-reused-1", &repo, 1, &utc),
        );
        // Clock ticks are checked against /proc, which this pid does not have.
        write(
            &home.join(".claude/sessions/23.json"),
            &rec(23, "cccccccc-3", &repo, 3, r#","procStart":"123456""#),
        );
        let kimi = Proc {
            pid: 21,
            start_ms: started + 1_000,
            args: "/home/u/.local/bin/kimi".into(),
        };
        let reused = Proc {
            pid: 22,
            start_ms: started + 600_000,
            args: "kimi".into(),
        };
        let e = Env {
            mac: false,
            ..env(&home, vec![kimi, reused, proc(23)])
        };
        let ids: Vec<String> = list(&e, &[project("p", &repo)], None)
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["session_live-1"]);
        assert!(read(
            &e,
            &[project("p", &repo)],
            "p",
            "session_live-1",
            None,
            None
        )
        .is_ok());
    }

    #[test]
    fn only_handoff_files_are_shown() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write(&repo.join(".claude/notes.md"), "not a handoff");
        write(&repo.join(".env"), "TOKEN=1");
        std::os::unix::fs::symlink(repo.join(".env"), repo.join(".claude/handoff-env.md")).unwrap();
        let now = NOW as f64 / 1000.0;
        let line = |at: f64, session: &str, name: &str, text: &str| {
            format!(
                r#"{{"at":{at},"event":"note","session":"{session}","name":"{name}","worktree":"{}","text":"{text}"}}"#,
                repo.display()
            )
        };
        let history = [
            line(
                now - 30.0,
                "codexsess-1",
                "repo-cx79",
                "handed over: .claude/notes.md",
            ),
            line(
                now - 20.0,
                "gonegone-2",
                "?",
                "handed over: .claude/handoff-env.md",
            ),
            line(now - 10.0, "bad id/x", "n", "handed over: .claude/notes.md"),
        ]
        .join("\n");
        write(&repo.join(".git/claude-claims-history.jsonl"), &history);
        let e = env(&home, vec![]);
        let projects = [project("p", &repo)];
        let rows = list(&e, &projects, None);
        let ids: Vec<(&str, Option<&str>, &str)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.handoff_path.as_deref(), r.source.as_str()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("gonegone-2", None, "claude"),
                ("codexsess-1", None, "codex")
            ]
        );
        assert_eq!(rows[0].name, None);
        assert!(read_handoff(repo.to_str().unwrap(), ".claude/handoff-env.md").is_none());
        assert_eq!(
            read(
                &e,
                &projects,
                "p",
                "handoff:.claude/handoff-env.md",
                None,
                None
            )
            .unwrap_err(),
            "Session not found"
        );
        // A .claude folder linked from outside the project lists nothing,
        // while a real one does (a clock of now, so neither is a week old).
        let linked = home.join("linked");
        let outside = home.join("outside");
        std::fs::create_dir_all(&linked).unwrap();
        write(&outside.join("handoff.md"), "not this project's");
        std::os::unix::fs::symlink(&outside, linked.join(".claude")).unwrap();
        write(&repo.join(".claude/handoff-real.md"), "this project's");
        let fresh = Env {
            now_ms: now_ms(),
            ..env(&home, vec![])
        };
        let both = [project("p", &repo), project("q", &linked)];
        let listed: Vec<String> = list(&fresh, &both, None)
            .into_iter()
            .map(|r| format!("{} {}", r.project_id, r.id))
            .collect();
        assert!(listed.contains(&"p handoff:.claude/handoff-real.md".to_string()));
        assert!(listed.iter().all(|r| r.starts_with("p ")));
        assert!(read_handoff(linked.to_str().unwrap(), ".claude/handoff.md").is_none());
        assert!(is_handoff_real_path(Path::new("/r/.claude/handoff-x.md")));
        assert!(!is_handoff_real_path(Path::new("/r/claude/handoff.md")));
        assert!(!is_handoff_real_path(Path::new("/r/.claude/notes.md")));
        assert_eq!(agent_of_name(Some("monocode-14")), None);
        assert_eq!(agent_of_name(Some("morgue-km93")), Some("kimi"));
        assert_eq!(agent_of_name(Some("x-cé1")), None);
    }

    #[test]
    fn reads_a_live_session() {
        let home = temp();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write(
            &home.join(".claude/sessions/1.json"),
            &rec(1, "livelive-1", &repo, 5, ""),
        );
        let key = project_key(repo.to_str().unwrap());
        write(
            &home.join(".claude/projects").join(key).join("livelive-1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"one\"}}\n{\"type\":\"user\",\"message\":{\"content\":\"two\"}}",
        );
        let e = env(&home, vec![proc(1)]);
        let projects = [project("p", &repo)];
        let rows = list(&e, &projects, None);
        assert!(rows[0].has_transcript);
        let page = read(&e, &projects, "p", "livelive-1", None, Some(1)).unwrap();
        assert_eq!(page.turns[0].text, "two");
        let next = read(&e, &projects, "p", "livelive-1", page.before, Some(1)).unwrap();
        assert_eq!(next.turns[0].text, "one");
        assert_eq!(next.before, None);
    }
}
