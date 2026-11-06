//! Fork: Mono's code contributions, detected from saved successful tool blocks.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, LazyLock};
use std::time::{Duration, Instant};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::session_store::SessionStore;

const MENTIONS: &str = "instr({column},'git commit')>0 OR instr({column},'git -C')>0
    OR instr({column},'gh pr')>0 OR instr({column},'pull_request')>0
    OR instr({column},'git -c')>0 OR instr({column},'add_review_to_pr')>0";
/// A running sub-agent's `updated_at` keeps changing, so its whole transcript
/// is only parsed when it could hold a launch.
const LAUNCH_MENTIONS: &str = "instr({column},'monoSpawnedSessions')>0
    OR instr({column},'sessions.start')>0 OR instr({column},'sessions.send')>0";
const MONTH_MS: u64 = 30 * 24 * 60 * 60 * 1000;

static GIT_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s;&|(])(?P<git>git)\s+").unwrap());
static COMMIT_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\[[^\]\n]* ([0-9a-f]{7,40})\] ").unwrap());
static QUIET_COMMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^([0-9a-f]{7,40})(?: |$)").unwrap());
static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A[0-9a-f]{7,40}\z").unwrap());
static GH_PR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s;&|(])gh\s+pr\s+(create|merge|review)\b").unwrap());
static PR_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([0-9]+)").unwrap()
});
static PR_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([0-9]+)\b").unwrap());
static PR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.][A-Za-z0-9_.-]*)#([1-9][0-9]*)\z")
        .unwrap()
});

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonoContributions {
    contributions: Vec<Contribution>,
    sessions: Vec<SessionStamp>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Contribution {
    session_id: String,
    kind: String,
    reference: String,
    at: u64,
    additions: u64,
    deletions: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStamp {
    id: String,
    updated_at: i64,
}

struct Session {
    id: String,
    cwd: PathBuf,
    worktree_cwd: Option<PathBuf>,
    created_at: u64,
    updated_at: i64,
    blocks: Vec<String>,
}

struct LaunchSnapshot {
    updated_at: i64,
    blocks: Vec<String>,
}

#[tauri::command]
pub async fn fork_mono_contributions(
    app: AppHandle,
    session_ids: Vec<String>,
    since_ms: u64,
    check_landed: bool,
) -> Result<MonoContributions, String> {
    validate_ids(&session_ids)?;
    if session_ids.is_empty() {
        return Ok(MonoContributions::default());
    }
    crate::background_work::read(move || {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut cache =
            Connection::open(dir.join("fork-mono-contributions.db")).map_err(|e| e.to_string())?;
        init_cache(&cache)?;
        let store = app.state::<SessionStore>();
        collect(
            &mut cache,
            &session_ids,
            since_ms,
            check_landed,
            |id, scanned| store.with_read_conn(|conn| load_session(conn, id, scanned)),
            |id, scanned| store.with_read_conn(|conn| load_launches(conn, id, scanned)),
        )
    })
    .await?
}

fn validate_ids(ids: &[String]) -> Result<(), String> {
    if ids.len() > 2000 {
        return Err("At most 2000 session ids are allowed".into());
    }
    for id in ids {
        crate::session_store::validate_id(id, "session")?;
    }
    Ok(())
}

fn init_cache(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS contributions(
            session_id TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL,
            at INTEGER NOT NULL, additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(kind,reference));
        CREATE INDEX IF NOT EXISTS contributions_by_session ON contributions(session_id,at);
        CREATE TABLE IF NOT EXISTS scanned(session_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_launches(
            session_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, launched_ids TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pr_checks(reference TEXT PRIMARY KEY, checked_at INTEGER NOT NULL);")
        .map_err(|e| e.to_string())
}

/// SQL rules out unrelated histories before fetching any JSON. The caller
/// releases the app's read lock as soon as this snapshot has been loaded.
fn load_session(
    conn: &Connection,
    id: &str,
    scanned: Option<i64>,
) -> Result<Option<Session>, String> {
    let session = conn
        .query_row(
            "SELECT cwd,worktree_cwd,created_at,updated_at FROM sessions WHERE id=?1",
            [id],
            |r| {
                Ok(Session {
                    id: id.into(),
                    cwd: PathBuf::from(r.get::<_, String>(0)?),
                    worktree_cwd: r
                        .get::<_, Option<String>>(1)?
                        .filter(|s| !s.is_empty())
                        .map(PathBuf::from),
                    created_at: r.get::<_, i64>(2)?.max(0) as u64,
                    updated_at: r.get(3)?,
                    blocks: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mut session) = session else {
        return Ok(None);
    };
    if scanned == Some(session.updated_at) {
        return Ok(Some(session));
    }
    session.blocks = load_blocks(conn, id, MENTIONS)?;
    Ok(Some(session))
}

fn load_launches(
    conn: &Connection,
    id: &str,
    scanned: Option<i64>,
) -> Result<Option<LaunchSnapshot>, String> {
    let updated_at = conn
        .query_row("SELECT updated_at FROM sessions WHERE id=?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(updated_at) = updated_at else {
        return Ok(None);
    };
    Ok(Some(LaunchSnapshot {
        updated_at,
        blocks: if scanned == Some(updated_at) {
            Vec::new()
        } else {
            load_blocks(conn, id, LAUNCH_MENTIONS)?
        },
    }))
}

fn load_blocks(conn: &Connection, id: &str, mentions: &str) -> Result<Vec<String>, String> {
    let mut blocks = Vec::new();
    let filter = |column| format!(" AND ({})", mentions.replace("{column}", column));
    let sql = format!(
        "SELECT blocks_json FROM sessions WHERE id=?1{}",
        filter("blocks_json")
    );
    if let Some(text) = conn
        .query_row(&sql, [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
    {
        blocks.push(text);
    }
    let has_mono: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mono_blocks')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_mono {
        let user_rows = if mentions == MENTIONS {
            " OR instr(block_json,'\"role\":\"user\"')>0"
        } else {
            ""
        };
        let sql = format!(
            "SELECT block_json FROM mono_blocks WHERE session_id=?1 AND (({}){user_rows}) ORDER BY seq",
            mentions.replace("{column}", "block_json")
        );
        let mut query = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = query
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            blocks.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(blocks)
}

fn expand_ids(
    cache: &Connection,
    ids: &[String],
    mut load: impl FnMut(&str, Option<i64>) -> Result<Option<LaunchSnapshot>, String>,
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    // Reserve every requested id before spending the remaining slots on launches.
    let mut expanded: Vec<_> = ids
        .iter()
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect();
    for id in ids {
        if expanded.len() >= 2000 {
            break;
        }
        let previous = cache
            .query_row(
                "SELECT updated_at,launched_ids FROM session_launches WHERE session_id=?1",
                [id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let scanned = previous.as_ref().map(|(at, _)| *at);
        let Some(snapshot) = load(id, scanned)? else {
            continue;
        };
        let launches = if scanned == Some(snapshot.updated_at) {
            previous.unwrap().1
        } else {
            let mut launches = Vec::new();
            let mut unique = HashSet::new();
            // The store's read lock has been released before any JSON is parsed.
            for text in &snapshot.blocks {
                let Ok(value) = serde_json::from_str::<Value>(text) else {
                    continue;
                };
                let blocks = match &value {
                    Value::Array(blocks) => blocks.as_slice(),
                    Value::Object(_) => std::slice::from_ref(&value),
                    _ => continue,
                };
                for block in blocks {
                    for launched in launched_ids(block) {
                        if crate::session_store::validate_id(&launched, "session").is_ok()
                            && unique.insert(launched.clone())
                        {
                            launches.push(launched);
                        }
                    }
                }
            }
            // Valid ids cannot contain newlines: reuse this list without JSON on
            // later polls. A concurrent newer snapshot must not be overwritten.
            let launches = launches.join("\n");
            cache.execute(
                "INSERT INTO session_launches VALUES(?1,?2,?3)
                ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at,launched_ids=excluded.launched_ids
                WHERE session_launches.updated_at=?4",
                params![id, snapshot.updated_at, launches, scanned],
            ).map_err(|e| e.to_string())?;
            launches
        };
        for launched in launches.lines() {
            if expanded.len() >= 2000 {
                break;
            }
            if crate::session_store::validate_id(launched, "session").is_ok()
                && seen.insert(launched.to_string())
            {
                expanded.push(launched.to_string());
            }
        }
    }
    Ok(expanded)
}

fn launched_ids(block: &Value) -> Vec<String> {
    let mut ids: Vec<_> = block["monoSpawnedSessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["sessionId"].as_str().map(String::from))
        .collect();
    let tool = &block["tool"];
    if !matches!(tool["status"].as_str(), Some("completed" | "success")) {
        return ids;
    }
    let Some(action) = launch_action(block) else {
        return ids;
    };
    let receipt = tool["detail"]
        .as_str()
        .and_then(|detail| serde_json::from_str::<Value>(detail).ok());
    if let Some(receipt) = receipt.filter(|receipt| receipt["ok"] == true) {
        let result = &receipt["result"];
        let id = if action == "sessions.start" {
            result["id"].as_str().filter(|id| id.starts_with("app-"))
        } else if result["submitted"] == true {
            result["sessionId"].as_str()
        } else {
            None
        };
        if let Some(id) = id {
            ids.push(id.into());
        }
    }
    ids
}

/// Mirror monoCodeToolCall: accept a single app invocation, never a mention,
/// shell expansion or a compound command. Preview commands take precedence.
fn launch_action(block: &Value) -> Option<&'static str> {
    if !matches!(block["role"].as_str(), Some("tool" | "approval")) {
        return None;
    }
    let tool = &block["tool"];
    let candidate = if tool["preview"]["kind"] == "shell" {
        tool["preview"]["title"].as_str()
    } else {
        tool["title"].as_str().or_else(|| block["text"].as_str())
    }?;
    static PREFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^Run(?:ning)?\s+command:\s*").unwrap());
    let mut command = PREFIX.replace(candidate.trim(), "").into_owned();
    for _ in 0..2 {
        let words = launch_words(&command)?;
        let executable = words
            .first()?
            .rsplit(['/', '\\'])
            .next()?
            .to_ascii_lowercase();
        let flag = match executable.as_str() {
            "sh" | "bash" | "zsh" | "dash" | "ksh" => words.iter().position(|word| {
                word == "--command"
                    || (word.starts_with('-')
                        && word[1..].chars().all(|c| c.is_ascii_alphabetic())
                        && word.contains('c'))
            }),
            "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => words
                .iter()
                .skip(1)
                .take_while(|word| !matches!(word.to_ascii_lowercase().as_str(), "-file" | "-f"))
                .position(|word| matches!(word.to_ascii_lowercase().as_str(), "-command" | "-c"))
                .map(|i| i + 1),
            "cmd" | "cmd.exe" => words
                .iter()
                .position(|word| word.eq_ignore_ascii_case("/c")),
            _ => break,
        };
        let Some(flag) = flag else {
            break;
        };
        let script = words.get(flag + 1)?;
        command = if matches!(
            executable.as_str(),
            "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" | "cmd" | "cmd.exe"
        ) && words.len() > flag + 2
        {
            words[flag + 1..]
                .iter()
                .map(|word| shlex::try_quote(word))
                .collect::<Result<Vec<_>, _>>()
                .ok()?
                .join(" ")
        } else {
            script.clone()
        };
    }
    let words = launch_words(&command)?;
    let executable = words.first()?.rsplit(['/', '\\']).next()?;
    if !(executable.eq_ignore_ascii_case("monocode")
        || executable.eq_ignore_ascii_case("monocode.exe"))
        || words.get(1)?.as_str() != "app"
    {
        return None;
    }
    let action = match words.get(2)?.as_str() {
        "sessions.start" => "sessions.start",
        "sessions.send" => "sessions.send",
        _ => return None,
    };
    for option in words[3..].chunks(2) {
        if option.len() != 2
            || !matches!(option[0].as_str(), "--json" | "--input" | "--request-id")
            || option[1].is_empty()
        {
            return None;
        }
    }
    Some(action)
}

fn launch_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        if quote == Some('\'') {
            if c == '\'' {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        if c == '\'' && quote.is_none() {
            quote = Some(c);
            started = true;
        } else if c == '"' {
            quote = if quote == Some(c) { None } else { Some(c) };
            started = true;
        } else if c == '\\' {
            let next = *chars.peek()?;
            if (quote == Some('"') && !"\\\"$`".contains(next))
                || (quote.is_none()
                    && !next.is_whitespace()
                    && !"'\"\\;&|<>()[]{}$`#".contains(next))
            {
                word.push(c);
            } else {
                word.push(chars.next()?);
            }
            started = true;
        } else if c == '$' || c == '`' || (quote.is_none() && "\r\n;&|<>()[]{}#".contains(c)) {
            return None;
        } else if quote.is_none() && c.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut word));
            }
            started = false;
        } else {
            word.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

fn scanned_at(conn: &Connection, id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT updated_at FROM scanned WHERE session_id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn collect(
    cache: &mut Connection,
    ids: &[String],
    since: u64,
    landed: bool,
    mut load: impl FnMut(&str, Option<i64>) -> Result<Option<Session>, String>,
    launches: impl FnMut(&str, Option<i64>) -> Result<Option<LaunchSnapshot>, String>,
) -> Result<MonoContributions, String> {
    let ids = expand_ids(cache, ids, launches)?;
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    for id in ids.iter().filter(|id| seen.insert(id.as_str())) {
        let scanned = scanned_at(cache, id)?;
        let Some(session) = load(id, scanned)? else {
            continue;
        };
        if scanned != Some(session.updated_at) {
            // Parse failures affect just this session. A changed timestamp retries it.
            let blocks = session
                .blocks
                .iter()
                .try_fold(Vec::new(), |mut blocks, text| {
                    let value = serde_json::from_str::<Value>(text).ok()?;
                    match value {
                        Value::Array(array) => blocks.extend(array),
                        Value::Object(_) => blocks.push(value),
                        _ => return None,
                    }
                    Some(blocks)
                });
            let items = blocks
                .map(|blocks| scan_blocks(&session, &blocks))
                .unwrap_or_default();
            // No database lock is held while git runs. Recheck inside the write
            // transaction so concurrent polls cannot replay an old scan's amends.
            let tx = cache
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            if scanned_at(&tx, id)? == scanned {
                record_scan(&tx, items)?;
                tx.execute(
                    "INSERT OR REPLACE INTO scanned VALUES(?1,?2)",
                    params![id, session.updated_at],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        sessions.push(SessionStamp {
            id: session.id,
            updated_at: session.updated_at,
        });
    }
    let ids: Vec<_> = sessions.iter().map(|s| s.id.clone()).collect();
    if landed {
        check_landed(cache, &ids)?;
    }
    Ok(MonoContributions {
        contributions: cached(cache, &ids, since)?,
        sessions,
    })
}

/// Match an abbreviation only when it names one cached commit in this session.
fn cached_commit(
    conn: &Connection,
    session: &str,
    reference: &str,
) -> Result<Option<String>, String> {
    let mut query = conn
        .prepare(
            "SELECT reference FROM contributions WHERE session_id=?1 AND kind='commit'
        AND (reference LIKE ?2 OR ?3 LIKE reference || '%') LIMIT 2",
        )
        .map_err(|e| e.to_string())?;
    let references = query
        .query_map(params![session, format!("{reference}%"), reference], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(match references.as_slice() {
        [reference] => Some(reference.clone()),
        _ => None,
    })
}

fn record_scan(
    conn: &Connection,
    items: Vec<(Contribution, bool, Option<PathBuf>)>,
) -> Result<(), String> {
    struct Pending {
        item: Contribution,
        checkout: Option<PathBuf>,
        replaced: Vec<String>,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for (item, amend, checkout) in items {
        let mut next = Pending {
            item,
            checkout,
            replaced: Vec::new(),
        };
        if amend && next.checkout.is_some() {
            if let Some(index) = pending
                .iter()
                .rposition(|p| p.item.kind == "commit" && p.checkout == next.checkout)
            {
                let previous = pending.remove(index);
                next.replaced = previous.replaced;
                next.replaced.push(previous.item.reference);
            }
        }
        pending.push(next);
    }
    for pending in pending {
        for reference in pending.replaced {
            if let Some(reference) = cached_commit(conn, &pending.item.session_id, &reference)? {
                conn.execute("DELETE FROM contributions WHERE session_id=?1 AND kind='commit' AND reference=?2",
                    params![pending.item.session_id, reference]).map_err(|e| e.to_string())?;
            }
        }
        // Cached commits have no checkout provenance. Only replace a commit
        // identified in this scan; otherwise keep both.
        record(conn, &pending.item)?;
    }
    Ok(())
}

fn record(conn: &Connection, item: &Contribution) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM contributions WHERE kind=?1 AND reference=?2)",
            params![item.kind, item.reference],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Ok(());
    }
    if item.kind == "commit" {
        // Git may disappear (or return) between scans. Keep the same commit
        // when its printed abbreviation and resolved full id trade places.
        if let Some(reference) = cached_commit(conn, &item.session_id, &item.reference)? {
            if reference.len() < item.reference.len() {
                conn.execute("UPDATE contributions SET reference=?2,at=?3,additions=?4,deletions=?5 WHERE kind='commit' AND reference=?1",
                    params![reference, item.reference, item.at as i64, item.additions as i64, item.deletions as i64]).map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
    }
    conn.execute("INSERT OR IGNORE INTO contributions(session_id,kind,reference,at,additions,deletions) VALUES(?1,?2,?3,?4,?5,?6)",
        params![item.session_id, item.kind, item.reference, item.at as i64, item.additions as i64, item.deletions as i64]).map_err(|e| e.to_string())?;
    Ok(())
}

fn cached(conn: &Connection, ids: &[String], since: u64) -> Result<Vec<Contribution>, String> {
    let Ok(since) = i64::try_from(since) else {
        return Ok(Vec::new());
    };
    let mut query = conn.prepare("SELECT session_id,kind,reference,at,additions,deletions FROM contributions WHERE session_id=?1 AND at>=?2").map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for id in ids {
        let rows = query
            .query_map(params![id, since], |r| {
                Ok(Contribution {
                    session_id: r.get(0)?,
                    kind: r.get(1)?,
                    reference: r.get(2)?,
                    at: r.get::<_, i64>(3)?.max(0) as u64,
                    additions: r.get::<_, i64>(4)?.max(0) as u64,
                    deletions: r.get::<_, i64>(5)?.max(0) as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
    }
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.reference.cmp(&b.reference)));
    Ok(items)
}

fn scan_blocks(session: &Session, blocks: &[Value]) -> Vec<(Contribution, bool, Option<PathBuf>)> {
    let mut items: Vec<(Contribution, bool, Option<PathBuf>)> = Vec::new();
    let mut at = session.updated_at.max(0) as u64;
    for block in blocks {
        if block["role"] == "user" {
            if let Some(timestamp) = ["startedAt", "sentAt"]
                .iter()
                .filter_map(|key| block[key].as_u64())
                .max()
            {
                at = timestamp;
            }
        }
        if block["role"] != "tool" || block["tool"]["status"] != "completed" {
            continue;
        }
        let tool = &block["tool"];
        let output = tool["detail"].as_str().unwrap_or_default();
        let command = tool["command"]
            .as_str()
            .unwrap_or_else(|| block["text"].as_str().unwrap_or_default())
            .trim()
            .trim_matches('`');
        let call = tool["callId"]
            .as_str()
            .or_else(|| block["id"].as_str())
            .unwrap_or_default();
        let kind = tool["kind"].as_str().unwrap_or_default().to_lowercase();
        if let Some(action) = github_kind(&kind).or_else(|| {
            let action = GH_PR.captures(command)?;
            match &action[1] {
                "create" => Some("opened"),
                "review" => Some("review"),
                "merge"
                    if !command.contains("--auto")
                        && !output.to_ascii_lowercase().contains("automatically merge")
                        && output.to_ascii_lowercase().contains("merged") =>
                {
                    Some("merged")
                }
                _ => None,
            }
        }) {
            if let Some(reference) = pull_request(output) {
                let reference = if action == "review" {
                    format!("{reference}@{call}")
                } else {
                    reference
                };
                items.push((item(session, action, reference, at), false, None));
            }
        }
        let Some((checkouts, commands)) = commit_checkouts(command, session) else {
            continue;
        };
        let amends: Vec<_> = commands
            .into_iter()
            .filter(|(_, dry_run, _)| !dry_run)
            .map(|(amend, _, checkout)| (amend, checkout))
            .collect();
        if amends.is_empty() || output.to_ascii_lowercase().contains("nothing to commit") {
            continue;
        }
        let confirmed: Vec<_> = COMMIT_LINE
            .captures_iter(output)
            .map(|c| c[1].to_string())
            .collect();
        let fallback = confirmed.is_empty();
        let hashes = if fallback {
            QUIET_COMMIT
                .captures(output)
                .map(|c| vec![c[1].to_string()])
                .unwrap_or_default()
        } else {
            confirmed
        };
        let count = hashes.len();
        for (index, hash) in hashes.into_iter().enumerate() {
            let (amend, checkout) = if amends.len() == count {
                amends[index].clone()
            } else {
                (amends.last().unwrap().0, None)
            };
            let resolved = resolve(&hash, &checkouts);
            if fallback
                && !resolved.as_ref().is_some_and(|(_, at, _, _)| {
                    *at >= session.created_at.saturating_sub(60_000)
                        && *at <= (session.updated_at.max(0) as u64).saturating_add(60_000)
                })
            {
                continue;
            }
            let mut contribution = item(session, "commit", hash, at);
            if let Some((sha, at, additions, deletions)) = resolved {
                contribution.reference = sha;
                contribution.at = at;
                contribution.additions = additions;
                contribution.deletions = deletions;
            }
            if items
                .iter()
                .any(|(c, _, _)| c.kind == "commit" && c.reference == contribution.reference)
            {
                continue;
            }
            items.push((contribution, amend, checkout));
        }
    }
    items
}

fn item(session: &Session, kind: &str, reference: String, at: u64) -> Contribution {
    Contribution {
        session_id: session.id.clone(),
        kind: kind.into(),
        reference,
        at,
        additions: 0,
        deletions: 0,
    }
}

fn github_kind(name: &str) -> Option<&'static str> {
    if !name.contains("github") {
        return None;
    }
    match name.rsplit("__").next()?.trim_start_matches("github_") {
        "create_pull_request" => Some("opened"),
        "merge_pull_request" => Some("merged"),
        "create_pull_request_review"
        | "submit_pull_request_review"
        | "submit_pending_pull_request_review"
        | "add_review_to_pr" => Some("review"),
        // pull_request_review_write needs raw input to distinguish drafts and
        // deletions from submissions; that input is not saved in this app.
        _ => None,
    }
}

fn pull_request(text: &str) -> Option<String> {
    let capture = PR_URL.captures(text).or_else(|| PR_NAME.captures(text))?;
    let pr = format!("{}#{}", &capture[1], &capture[2]);
    pr_parts(&pr)?;
    Some(pr)
}

fn valid_sha(sha: &str) -> bool {
    SHA.is_match(sha)
}

fn pr_parts(pr: &str) -> Option<(&str, &str)> {
    if pr.starts_with('-') || !PR.is_match(pr) {
        return None;
    }
    let (repo, number) = pr.split_once('#')?;
    if matches!(repo.split('/').next_back()?, "." | "..") {
        return None;
    }
    number.parse::<u64>().ok()?;
    Some((repo, number))
}

/// First shell segment, keeping quoted separators literal. No shell runs.
fn shell_head(command: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in command.char_indices() {
        if escaped {
            escaped = false;
        } else if ch == '\\' && quote != Some('\'') {
            escaped = true;
        } else if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() {
            match ch {
                '\'' | '"' => quote = Some(ch),
                ';' | '&' | '|' | '\n' => return &command[..index],
                _ => {}
            }
        }
    }
    command
}

fn leading_cd(command: &str, base: &Path) -> Option<PathBuf> {
    let words = shlex::split(shell_head(command.trim_start()))?;
    let path = match words
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["cd", path] | ["cd", "--", path] => path.to_string(),
        _ => return None,
    };
    if path.contains(['$', '`']) {
        return None;
    }
    Some(base.join(path))
}

fn commit_checkouts(
    command: &str,
    session: &Session,
) -> Option<(Vec<PathBuf>, Vec<(bool, bool, Option<PathBuf>)>)> {
    let base = session.worktree_cwd.as_deref().unwrap_or(&session.cwd);
    let cd = leading_cd(command, base);
    let cwd_cd = leading_cd(command, &session.cwd);
    let mut checkouts = Vec::new();
    let mut commands = Vec::new();
    let mut segment_end = 0;
    let mut known_cwd = true;
    for candidate in GIT_COMMAND.captures_iter(command) {
        let start = candidate.name("git")?.start();
        if start < segment_end {
            continue;
        }
        // Infer a checkout only for plain commands or a successful literal cd.
        // Other shell context may hide a directory change.
        let mut prefix = &command[segment_end..start];
        if segment_end == 0 && cd.is_some() {
            prefix = prefix
                .trim_start()
                .strip_prefix(shell_head(command.trim_start()))
                .and_then(|tail| tail.trim_start().strip_prefix("&&"))
                .unwrap_or(prefix);
        }
        if prefix
            .chars()
            .any(|c| !c.is_whitespace() && !";&|".contains(c))
        {
            known_cwd = false;
        }
        let segment = shell_head(&command[start..]);
        segment_end = start + segment.len();
        // Read the prefix even if a heredoc message later defeats shlex. A
        // confirmed commit must not depend on parsing the message as shell words.
        let words = shlex::Shlex::new(segment);
        let mut path = cd.clone().unwrap_or_else(|| base.into());
        let mut cwd_path = cwd_cd.clone().unwrap_or_else(|| session.cwd.clone());
        let (mut explicit, mut literal) = (false, true);
        let mut args = words.skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "commit" => {
                    let options: Vec<_> = args.collect();
                    commands.push((
                        options.iter().any(|s| s == "--amend"),
                        options.iter().any(|s| s == "--dry-run"),
                        (literal && known_cwd).then(|| path.clone()),
                    ));
                    if explicit && literal {
                        for path in [path, cwd_path] {
                            if !checkouts.contains(&path) {
                                checkouts.push(path);
                            }
                        }
                    }
                    break;
                }
                "-C" => {
                    let Some(value) = args.next() else { break };
                    literal &= !value.contains(['$', '`']);
                    path.push(&value);
                    cwd_path.push(value);
                    explicit = true;
                }
                "-c" => {
                    if args.next().is_none() {
                        break;
                    }
                }
                arg if arg.starts_with("-C") => {
                    literal &= !arg.contains(['$', '`']);
                    path.push(&arg[2..]);
                    cwd_path.push(&arg[2..]);
                    explicit = true;
                }
                arg if arg.starts_with("-c") => {}
                _ => break,
            }
        }
    }
    for path in cd
        .iter()
        .chain(cwd_cd.iter())
        .chain(session.worktree_cwd.iter())
        .chain(std::iter::once(&session.cwd))
    {
        if !checkouts.contains(path) {
            checkouts.push(path.clone());
        }
    }
    (!commands.is_empty()).then_some((checkouts, commands))
}

fn resolve(sha: &str, checkouts: &[PathBuf]) -> Option<(String, u64, u64, u64)> {
    if !valid_sha(sha) {
        return None;
    }
    let path = crate::harness::cached_gui_search_path();
    for dir in checkouts {
        let mut cmd = Command::new(crate::harness::git_program(&path));
        crate::background_work::configure_child(&mut cmd);
        crate::hide_window_console(&mut cmd);
        let output = cmd
            .arg("-C")
            .arg(dir)
            .args([
                "show",
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "--no-renames",
                "--format=%H %ct",
                sha,
                "--",
            ])
            .env("PATH", &path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut lines = text.lines();
        let Some((id, time)) = lines.next().and_then(|l| l.split_once(' ')) else {
            continue;
        };
        let Some(at) = time.parse::<u64>().ok().and_then(|t| t.checked_mul(1000)) else {
            continue;
        };
        if id.len() != 40 || !valid_sha(id) {
            continue;
        }
        let (mut additions, mut deletions) = (0u64, 0u64);
        for line in lines {
            let mut parts = line.split('\t');
            if let (Some(a), Some(d)) = (parts.next(), parts.next()) {
                additions = additions.saturating_add(a.parse::<u64>().unwrap_or(0));
                deletions = deletions.saturating_add(d.parse::<u64>().unwrap_or(0));
            }
        }
        return Some((id.into(), at, additions, deletions));
    }
    None
}

fn check_landed(cache: &Connection, ids: &[String]) -> Result<(), String> {
    check_landed_with(cache, ids, merged_at)
}

fn check_landed_with(
    cache: &Connection,
    ids: &[String],
    mut merged_at: impl FnMut(&str) -> Option<u64>,
) -> Result<(), String> {
    let now = crate::session_store::now_millis().max(0) as u64;
    let items = cached(cache, ids, now.saturating_sub(MONTH_MS))?;
    let settled: HashSet<_> = items
        .iter()
        .filter(|c| matches!(c.kind.as_str(), "merged" | "landed"))
        .map(|c| c.reference.as_str())
        .collect();
    let mut checks = cache
        .prepare("SELECT checked_at FROM pr_checks WHERE reference=?1")
        .map_err(|e| e.to_string())?;
    let mut pending = items
        .iter()
        .filter(|c| c.kind == "opened" && !settled.contains(c.reference.as_str()))
        .map(|opened| {
            let checked = checks
                .query_row([&opened.reference], |r| r.get::<_, i64>(0))
                .optional()?
                .unwrap_or(0);
            Ok((checked, opened))
        })
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    pending.sort_by_key(|(checked, _)| *checked);
    for (_, opened) in pending.into_iter().take(10) {
        cache
            .execute(
                "INSERT INTO pr_checks VALUES(?1,?2)
            ON CONFLICT(reference) DO UPDATE SET checked_at=max(checked_at,excluded.checked_at)",
                params![opened.reference, now as i64],
            )
            .map_err(|e| e.to_string())?;
        if let Some(at) = merged_at(&opened.reference) {
            record(
                cache,
                &Contribution {
                    kind: "landed".into(),
                    at,
                    ..opened.clone()
                },
            )?;
        }
    }
    Ok(())
}

fn merged_at(pr: &str) -> Option<u64> {
    let (repo, number) = pr_parts(pr)?;
    let binary = crate::harness::resolve_gui_binary("gh")?;
    let mut cmd = Command::new(binary);
    cmd.args([
        "pr",
        "view",
        number,
        "--repo",
        repo,
        "--json",
        "state,mergedAt",
    ])
    .env("GH_PROMPT_DISABLED", "1")
    .env("PATH", crate::harness::cached_gui_search_path());
    let output = output_before(cmd, Duration::from_secs(15))?;
    let value: Value = serde_json::from_slice(&output).ok()?;
    if value["state"] != "MERGED" {
        return None;
    }
    let at = time::OffsetDateTime::parse(
        value["mergedAt"].as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    u64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// Drain stdout alongside the child so a pipe buffer cannot defeat the timeout.
fn output_before(mut cmd: Command, timeout: Duration) -> Option<Vec<u8>> {
    crate::background_work::configure_child(&mut cmd);
    crate::hide_window_console(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(64 * 1024).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => break None,
        }
    };
    let output = status.filter(|s| s.success()).and_then(|_| {
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .ok()
    });
    if output.is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Repo(PathBuf);

    impl Repo {
        fn new() -> Self {
            let repo = Self(
                std::env::temp_dir().join(format!("mono-contributions-{}", uuid::Uuid::new_v4())),
            );
            std::fs::create_dir_all(&repo.0).unwrap();
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.name", "Mono"]);
            repo.git(&["config", "user.email", "mono@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.git(&["config", "core.hooksPath", "/dev/null"]);
            std::fs::write(repo.0.join("a.txt"), "one\ntwo\n").unwrap();
            repo.git(&["add", "a.txt"]);
            repo.git(&["commit", "-qm", "initial"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap().trim().into()
        }

        fn session(&self) -> Session {
            let at = self
                .git(&["show", "-s", "--format=%ct", "HEAD"])
                .parse::<u64>()
                .unwrap()
                * 1000;
            Session {
                id: "s1".into(),
                cwd: self.0.clone(),
                worktree_cwd: None,
                created_at: at,
                updated_at: at as i64,
                blocks: Vec::new(),
            }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn block(command: &str, output: &str) -> Value {
        json!({"id":"block-1", "role":"tool", "text":format!("`{command}`"),
            "tool":{"callId":"call-1", "kind":"execute", "status":"completed", "detail":output}})
    }

    fn detect(
        session: &Session,
        command: &str,
        output: &str,
    ) -> Vec<(Contribution, bool, Option<PathBuf>)> {
        scan_blocks(session, &[block(command, output)])
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, worktree_cwd TEXT,
            created_at INTEGER, updated_at INTEGER, blocks_json TEXT);
            CREATE TABLE mono_blocks(session_id TEXT, seq INTEGER, block_json TEXT);",
        )
        .unwrap();
        conn
    }

    fn save(conn: &Connection, id: &str, at: i64, blocks: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO sessions VALUES(?1,'/missing',NULL,0,?2,?3)",
            params![id, at, blocks],
        )
        .unwrap();
    }

    fn cache() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_cache(&conn).unwrap();
        conn
    }

    fn collect_test(
        conn: &Connection,
        cache: &mut Connection,
        ids: &[&str],
        since: u64,
    ) -> MonoContributions {
        collect(
            cache,
            &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            since,
            false,
            |id, scanned| load_session(conn, id, scanned),
            |id, scanned| load_launches(conn, id, scanned),
        )
        .unwrap()
    }

    fn launch_block(action: &str, result: Value) -> Value {
        json!({"role":"tool", "text":format!("monocode app {action} --json '{{}}'"),
            "tool":{"status":"completed", "detail":json!({"ok":true,"result":result}).to_string()}})
    }

    #[test]
    fn launches_without_git_mentions_are_found_in_both_block_tables() {
        for mono in [false, true] {
            for launch in [
                json!({"role":"user", "monoSpawnedSessions":[{"sessionId":"app-child"}]}),
                launch_block("sessions.start", json!({"id":"app-child"})),
                launch_block(
                    "sessions.send",
                    json!({"sessionId":"app-child","submitted":true}),
                ),
            ] {
                let conn = db();
                let mut cache = cache();
                save(&conn, "parent", 1, "[]");
                save(&conn, "app-child", 2, "[]");
                assert!(!launch.to_string().contains("git"));
                if mono {
                    conn.execute(
                        "INSERT INTO mono_blocks VALUES('parent',0,?1)",
                        [launch.to_string()],
                    )
                    .unwrap();
                } else {
                    save(&conn, "parent", 1, &json!([launch]).to_string());
                }
                let result = collect_test(&conn, &mut cache, &["parent"], 0);
                assert_eq!(
                    result
                        .sessions
                        .iter()
                        .map(|s| s.id.as_str())
                        .collect::<Vec<_>>(),
                    ["parent", "app-child"]
                );
            }
        }
    }

    #[test]
    fn launched_commits_are_scanned_cached_and_removed_when_session_is_deleted() {
        let conn = db();
        conn.execute("DROP TABLE mono_blocks", []).unwrap();
        let mut cache = cache();
        save(
            &conn,
            "parent",
            1,
            &json!([launch_block("sessions.start", json!({"id":"app-child"}))]).to_string(),
        );
        save(
            &conn,
            "app-child",
            2,
            &json!([block("git commit -m child", "[main abcdef0] child")]).to_string(),
        );
        for _ in 0..2 {
            let result = collect_test(&conn, &mut cache, &["parent"], 0);
            assert_eq!(result.contributions.len(), 1);
            assert_eq!(result.contributions[0].session_id, "app-child");
            assert_eq!(result.contributions[0].reference, "abcdef0");
            assert_eq!(result.sessions.len(), 2);
        }
        conn.execute("DELETE FROM sessions WHERE id='app-child'", [])
            .unwrap();
        let result = collect_test(&conn, &mut cache, &["parent"], 0);
        assert!(result.contributions.is_empty());
        assert_eq!(result.sessions.len(), 1);
    }

    #[test]
    fn launches_are_expanded_one_level_and_deduplicated() {
        let conn = db();
        let mut cache = cache();
        save(&conn, "parent", 1, &json!([{"monoSpawnedSessions":[{"sessionId":"app-child"},{"sessionId":"parent"},{"sessionId":"app-child"}]}]).to_string());
        save(
            &conn,
            "app-child",
            2,
            &json!([{"monoSpawnedSessions":[{"sessionId":"grandchild"}]}]).to_string(),
        );
        save(&conn, "grandchild", 3, "[]");
        let result = collect_test(&conn, &mut cache, &["parent", "parent"], 0);
        assert_eq!(
            result
                .sessions
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["parent", "app-child"]
        );
        let result = collect_test(&conn, &mut cache, &["parent", "app-child"], 0);
        assert_eq!(
            result
                .sessions
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["parent", "app-child", "grandchild"]
        );
    }

    #[test]
    fn malformed_receipts_and_invalid_launched_ids_are_ignored() {
        let conn = db();
        let mut cache = cache();
        let mut bad_json = launch_block("sessions.start", json!({"id":"app-bad-json"}));
        bad_json["tool"]["detail"] = json!("{broken");
        let mut failed = launch_block("sessions.start", json!({"id":"app-failed"}));
        failed["tool"]["status"] = json!("failed");
        let mut not_ok = launch_block("sessions.start", json!({"id":"app-not-ok"}));
        not_ok["tool"]["detail"] = json!(r#"{"ok":false,"result":{"id":"app-not-ok"}}"#);
        let mut mention = launch_block("sessions.start", json!({"id":"app-mention"}));
        mention["text"] = json!("echo monocode app sessions.start");
        let mut blocks = vec![
            bad_json,
            failed,
            not_ok,
            mention,
            launch_block("sessions.list", json!({"id":"app-list"})),
            launch_block("sessions.start", json!({"id":"other"})),
            launch_block(
                "sessions.send",
                json!({"sessionId":"unsent","submitted":false}),
            ),
            launch_block("sessions.start", json!({"id":"app-../bad"})),
            launch_block(
                "sessions.send",
                json!({"sessionId":"../bad","submitted":true}),
            ),
            json!({"monoSpawnedSessions":[{"sessionId":""},{"sessionId":"../bad"},{"sessionId":42},{"sessionId":"valid"}]}),
        ];
        for command in [
            "monocode app sessions.start && echo extra",
            "monocode app sessions.start --unknown value",
            "monocode app sessions.start --json \"$(echo bad)\"",
        ] {
            let mut launch = launch_block("sessions.start", json!({"id":"app-compound"}));
            launch["text"] = json!(command);
            blocks.push(launch);
        }
        save(&conn, "parent", 1, &json!(blocks).to_string());
        for id in [
            "app-bad-json",
            "app-failed",
            "app-not-ok",
            "app-mention",
            "app-list",
            "other",
            "unsent",
            "app-../bad",
            "../bad",
            "app-compound",
            "valid",
        ] {
            save(&conn, id, 2, "[]");
        }
        let result = collect_test(&conn, &mut cache, &["parent"], 0);
        assert_eq!(
            result
                .sessions
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["parent", "valid"]
        );
    }

    #[test]
    fn launch_commands_use_shell_preview_title_and_wrapped_commands() {
        for command in [
            "monocode app sessions.start --json '{}'",
            "Running command: '/Applications/MonoCode App/monocode' app sessions.start --input -",
            "/bin/zsh -lc \"monocode app sessions.start --json '{}'\"",
            "\"C:\\Program Files\\MonoCode\\monocode.exe\" app sessions.start",
            "pwsh -Command monocode app sessions.start --json '{}'",
            "cmd.exe /c monocode app sessions.start --input -",
        ] {
            for source in ["text", "title", "preview"] {
                let conn = db();
                let mut cache = cache();
                let mut launch = launch_block("sessions.start", json!({"id":"app-child"}));
                launch["tool"]["status"] = json!("success");
                launch["text"] = json!("Start a session");
                if source == "text" {
                    launch["text"] = json!(command);
                } else if source == "title" {
                    launch["tool"]["title"] = json!(command);
                } else {
                    launch["tool"]["title"] = json!("Start a session");
                    launch["tool"]["preview"] = json!({"kind":"shell","title":command});
                }
                save(&conn, "parent", 1, &json!([launch]).to_string());
                save(&conn, "app-child", 2, "[]");
                assert_eq!(
                    collect_test(&conn, &mut cache, &["parent"], 0)
                        .sessions
                        .len(),
                    2,
                    "{source}: {command}"
                );
            }
        }
    }

    #[test]
    fn expanded_limit_reserves_space_for_every_requested_id() {
        let conn = db();
        let mut cache = cache();
        let ids: Vec<_> = (0..2000).map(|i| format!("requested-{i}")).collect();
        for id in &ids {
            save(&conn, id, 1, "[]");
        }
        save(
            &conn,
            &ids[0],
            1,
            &json!([{"monoSpawnedSessions":[{"sessionId":"launch-1"},{"sessionId":"launch-2"}]}])
                .to_string(),
        );
        for id in ["launch-1", "launch-2"] {
            save(&conn, id, 2, "[]");
        }
        let requested: Vec<_> = ids.iter().map(String::as_str).collect();
        let result = collect_test(&conn, &mut cache, &requested[..1999], 0);
        assert_eq!(result.sessions.len(), 2000);
        assert_eq!(result.sessions[1998].id, ids[1998]);
        assert_eq!(result.sessions[1999].id, "launch-1");
        let result = collect_test(&conn, &mut cache, &requested, 0);
        assert_eq!(
            result
                .sessions
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            requested
        );
    }

    #[test]
    fn unchanged_sessions_do_not_read_launch_blocks_again() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        let conn = db();
        let mut cache = cache();
        save(
            &conn,
            "parent",
            1,
            &json!([{"monoSpawnedSessions":[{"sessionId":"app-child"}]}]).to_string(),
        );
        save(&conn, "app-child", 2, "[]");
        assert_eq!(
            collect_test(&conn, &mut cache, &["parent"], 0)
                .sessions
                .len(),
            2
        );
        conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
            AuthAction::Read {
                table_name: "sessions",
                column_name: "blocks_json",
            }
            | AuthAction::Read {
                table_name: "mono_blocks",
                ..
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }))
        .unwrap();
        assert_eq!(
            collect_test(&conn, &mut cache, &["parent"], 0)
                .sessions
                .len(),
            2
        );
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        save(
            &conn,
            "parent",
            3,
            &json!([{"monoSpawnedSessions":[{"sessionId":"new-child"}]}]).to_string(),
        );
        save(&conn, "new-child", 4, "[]");
        let result = collect_test(&conn, &mut cache, &["parent"], 0);
        assert_eq!(
            result
                .sessions
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["parent", "new-child"]
        );
    }

    #[test]
    fn confirmed_commit_survives_missing_git_and_resolves_when_available() {
        let repo = Repo::new();
        let mut session = repo.session();
        let sha = repo.git(&["rev-parse", "HEAD"]);
        let output = format!("[main (root-commit) {}] initial", &sha[..7]);
        let found = detect(&session, "git commit -m initial", &output);
        assert_eq!(found[0].0.reference, sha);
        assert_eq!(found[0].0.additions, 2);
        assert_eq!(found[0].0.deletions, 0);
        session.cwd = repo.0.join("gone");
        let found = detect(&session, "git commit -m initial", &output);
        assert_eq!(found[0].0.reference, sha[..7]);
        assert_eq!(found[0].0.at, session.updated_at as u64);
        assert_eq!(found[0].0.additions, 0);
    }

    #[test]
    fn quiet_commit_uses_only_first_hash_and_requires_resolution_in_session_window() {
        let repo = Repo::new();
        let mut session = repo.session();
        let sha = repo.git(&["rev-parse", "HEAD"]);
        let output = format!("notice\n{} initial\n{sha}\n", &sha[..7]);
        let command = "git commit -q -m initial && git log --oneline -1";
        let found = detect(&session, command, &output);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0.reference, sha);
        assert_eq!(found[0].0.additions, 2);
        session.created_at += 60_001;
        session.updated_at += 60_001;
        assert!(detect(&session, command, &output).is_empty());
        session.created_at -= 120_002;
        session.updated_at -= 120_002;
        assert!(detect(&session, command, &output).is_empty());
        session = repo.session();
        assert!(detect(&session, command, "deadbee missing\n").is_empty());
        assert!(detect(&session, command, &format!("deadbee first\n{sha} valid")).is_empty());
        session.cwd = repo.0.join("gone");
        assert!(detect(&session, command, &output).is_empty());
    }

    #[test]
    fn unsuccessful_noop_and_dry_run_commands_are_ignored() {
        let repo = Repo::new();
        let session = repo.session();
        let sha = repo.git(&["rev-parse", "HEAD"]);
        for output in [
            format!("nothing to commit\n{sha}"),
            format!("nothing to commit\n[main {}] x", &sha[..7]),
        ] {
            assert!(detect(&session, "git commit -q", &output).is_empty());
        }
        assert!(detect(&session, "git commit --dry-run", &sha).is_empty());
        assert!(detect(&session, "git status", &format!("[main {}] x", &sha[..7])).is_empty());
        for status in ["failed", "running", "cancelled"] {
            let mut tool = block("git commit -q", &sha);
            tool["tool"]["status"] = json!(status);
            assert!(scan_blocks(&session, &[tool]).is_empty());
        }
        let mut tool = block("git status", &sha);
        tool["tool"]["command"] = json!("git commit -q");
        assert_eq!(scan_blocks(&session, &[tool]).len(), 1);
    }

    #[test]
    fn literal_checkouts_precede_missing_worktree_and_session_folder() {
        let repo = Repo::new();
        let mut session = repo.session();
        let sha = repo.git(&["rev-parse", "HEAD"]);
        let quoted = shlex::try_quote(repo.0.to_str().unwrap()).unwrap();
        session.cwd = repo.0.join("missing");
        session.worktree_cwd = Some(repo.0.join("removed-worktree"));
        for command in [
            format!("cd {quoted} && git commit -q"),
            format!("git -C {quoted} commit -q"),
        ] {
            assert_eq!(detect(&session, &command, &sha)[0].0.reference, sha);
        }
        session.cwd = repo.0.parent().unwrap().into();
        session.worktree_cwd = None;
        let relative = repo.0.file_name().unwrap().to_str().unwrap();
        session.worktree_cwd = Some(session.cwd.join("removed-worktree"));
        assert_eq!(
            detect(&session, &format!("cd '{relative}'; git commit -q"), &sha)[0]
                .0
                .reference,
            sha
        );
        assert_eq!(
            detect(&session, &format!("git -C '{relative}' commit -q"), &sha)[0]
                .0
                .reference,
            sha
        );
        assert!(leading_cd("cd $W && git commit -q", &session.cwd).is_none());
        assert!(leading_cd("cd `pwd` && git commit -q", &session.cwd).is_none());
        session.cwd = repo.0.clone();
        session.worktree_cwd = Some(repo.0.join("gone"));
        assert_eq!(detect(&session, "git commit -q", &sha)[0].0.reference, sha);
    }

    #[test]
    fn an_earlier_command_hides_the_amend_checkout_but_not_where_to_look() {
        let session = Repo::new().session();
        let (checkouts, commands) =
            commit_checkouts("npm test && git -C /other commit -m x", &session).unwrap();
        assert!(checkouts.contains(&PathBuf::from("/other")));
        assert_eq!(commands, [(false, false, None)]);
    }

    #[test]
    fn gh_pr_kinds_reviews_and_output_only_github_tools() {
        let session = Repo::new().session();
        for (cmd, out, kind) in [
            (
                "gh pr create --fill",
                "https://github.com/acme/app/pull/42",
                "opened",
            ),
            (
                "gh pr merge 42 --squash",
                "Merged pull request acme/app#42",
                "merged",
            ),
            (
                "gh pr review 42 --approve",
                "Approved pull request acme/app#42",
                "review",
            ),
        ] {
            let found = detect(&session, cmd, out);
            assert_eq!(found[0].0.kind, kind);
            assert_eq!(
                found[0].0.reference,
                if kind == "review" {
                    "acme/app#42@call-1"
                } else {
                    "acme/app#42"
                }
            );
        }
        assert!(detect(&session, "gh pr merge 42 --auto", "Merged acme/app#42").is_empty());
        assert!(detect(
            &session,
            "gh pr merge 42",
            "Will automatically merge acme/app#42"
        )
        .is_empty());
        let mut review = block("gh pr review 42", "Approved acme/app#42");
        let first = scan_blocks(&session, &[review.clone()]);
        review["tool"]["callId"] = json!("call-2");
        assert_ne!(
            first[0].0.reference,
            scan_blocks(&session, &[review.clone()])[0].0.reference
        );
        review["tool"]["kind"] = json!("mcp__github__create_pull_request_review");
        review["text"] = json!("");
        assert_eq!(scan_blocks(&session, &[review.clone()])[0].0.kind, "review");
        review["tool"]["kind"] = json!("mcp__github__get_pull_request_reviews");
        assert!(scan_blocks(&session, &[review.clone()]).is_empty());
        review["tool"]["kind"] = json!("mcp__github__create_pull_request");
        review["tool"]["detail"] = json!("No PR named");
        assert!(scan_blocks(&session, &[review]).is_empty());
    }

    #[test]
    fn amend_replaces_latest_commit_and_replaying_history_is_idempotent() {
        let conn = db();
        let mut cache = cache();
        let a = block("git commit -m a", "[main aaaaaaa] a");
        let b = block("git commit --amend -m b", "[main bbbbbbb] b");
        let c = block("git commit -m c", "[main ccccccc] c");
        save(&conn, "s1", 1, &json!([a]).to_string());
        collect_test(&conn, &mut cache, &["s1"], 0);
        save(&conn, "s1", 2, &json!([a, b, c]).to_string());
        let all = collect_test(&conn, &mut cache, &["s1"], 0);
        assert_eq!(all.contributions.len(), 2);
        assert!(!all.contributions.iter().any(|c| c.reference == "aaaaaaa"));
        save(&conn, "s1", 3, &json!([a, b, c]).to_string());
        assert_eq!(
            collect_test(&conn, &mut cache, &["s1"], 0)
                .contributions
                .len(),
            2
        );
    }

    #[test]
    fn amends_keep_commits_from_other_or_unknown_checkouts() {
        for (first, amend) in [
            (
                "git -C /checkout-a commit -m a",
                "git -C /checkout-b commit --amend -m b",
            ),
            (
                "cd /checkout-a && git commit -m a",
                "cd /checkout-b && git commit --amend -m b",
            ),
            (
                "git commit -m a",
                "git -C \"$CHECKOUT\" commit --amend -m b",
            ),
            (
                "git -C \"$CHECKOUT\" commit -m a",
                "git commit --amend -m b",
            ),
            (
                "git commit -m a",
                "cd \"$CHECKOUT\" && git commit --amend -m b",
            ),
            (
                "git -C \"$CHECKOUT\" commit -m a",
                "git -C \"$CHECKOUT\" commit --amend -m b",
            ),
            (
                "git commit -m a",
                "(cd /checkout-b && git commit --amend -m b)",
            ),
            (
                "git commit -m a",
                "sh -c 'cd /checkout-b && git commit --amend -m b'",
            ),
            (
                "git commit -m a",
                "env -C /checkout-b git commit --amend -m b",
            ),
        ] {
            for full_history in [false, true] {
                let conn = db();
                let mut cache = cache();
                let a = block(first, "[main aaaaaaa] a");
                let b = block(amend, "[main bbbbbbb] b");
                save(&conn, "s1", 1, &json!([a]).to_string());
                collect_test(&conn, &mut cache, &["s1"], 0);
                let history = if full_history {
                    json!([a, b])
                } else {
                    json!([b])
                };
                for at in [2, 3] {
                    save(&conn, "s1", at, &history.to_string());
                    let result = collect_test(&conn, &mut cache, &["s1"], 0);
                    assert_eq!(
                        result.contributions.len(),
                        2,
                        "{first}; {amend}; full={full_history}"
                    );
                    assert!(result
                        .contributions
                        .iter()
                        .any(|c| c.reference == "aaaaaaa"));
                    assert!(result
                        .contributions
                        .iter()
                        .any(|c| c.reference == "bbbbbbb"));
                }
            }
        }
    }

    #[test]
    fn contribution_dates_follow_user_blocks_in_both_block_tables() {
        let monday = 1_767_571_200_000u64;
        let tuesday = monday + 24 * 60 * 60 * 1000;
        for mono in [false, true] {
            let conn = db();
            let mut cache = cache();
            let blocks = vec![
                block("gh pr create", "acme/app#1"),
                json!({"role":"user", "text":"start", "startedAt":monday}),
                block("gh pr create", "acme/app#2"),
                block("git commit -m a", "[main aaaaaaa] a"),
                json!({"role":"user", "text":"continue"}),
                block("gh pr create", "acme/app#3"),
                json!({"role":"user", "text":"joined", "sentAt":tuesday}),
                block("gh pr create", "acme/app#4"),
                json!({"role":"user", "startedAt":monday, "sentAt":tuesday + 1000}),
                block("gh pr create", "acme/app#5"),
                block("echo unrelated", "irrelevant tool output"),
            ];
            save(&conn, "s1", (tuesday + 2000) as i64, "[]");
            if mono {
                for (seq, block) in blocks.iter().enumerate() {
                    conn.execute(
                        "INSERT INTO mono_blocks VALUES('s1',?1,?2)",
                        params![seq as i64, block.to_string()],
                    )
                    .unwrap();
                }
                let loaded = load_session(&conn, "s1", None).unwrap().unwrap();
                assert_eq!(loaded.blocks.len(), blocks.len() - 1);
            } else {
                save(
                    &conn,
                    "s1",
                    (tuesday + 2000) as i64,
                    &json!(blocks).to_string(),
                );
            }
            let result = collect_test(&conn, &mut cache, &["s1"], 0);
            for (reference, expected) in [
                ("acme/app#1", tuesday + 2000),
                ("acme/app#2", monday),
                ("aaaaaaa", monday),
                ("acme/app#3", monday),
                ("acme/app#4", tuesday),
                ("acme/app#5", tuesday + 1000),
            ] {
                assert_eq!(
                    result
                        .contributions
                        .iter()
                        .find(|c| c.reference == reference)
                        .unwrap()
                        .at,
                    expected,
                    "{reference}; mono={mono}"
                );
            }
        }
        let repo = Repo::new();
        let session = repo.session();
        let sha = repo.git(&["rev-parse", "HEAD"]);
        let found = scan_blocks(
            &session,
            &[
                json!({"role":"user", "startedAt":monday}),
                block(
                    "git commit -m initial",
                    &format!("[main {}] initial", &sha[..7]),
                ),
            ],
        );
        assert_eq!(found[0].0.at, session.updated_at as u64);
    }

    #[test]
    fn landed_checks_rotate_past_ten_open_pull_requests() {
        let cache = cache();
        let now = crate::session_store::now_millis().max(0) as u64;
        for number in 1..=13 {
            let opened = Contribution {
                session_id: "s1".into(),
                kind: "opened".into(),
                reference: format!("acme/app#{number}"),
                at: now - 20 + number,
                additions: 0,
                deletions: 0,
            };
            record(&cache, &opened).unwrap();
            if number >= 12 {
                record(
                    &cache,
                    &Contribution {
                        kind: if number == 12 { "merged" } else { "landed" }.into(),
                        ..opened
                    },
                )
                .unwrap();
            }
        }
        let ids = vec!["s1".into()];
        let mut checked = Vec::new();
        check_landed_with(&cache, &ids, |pr| {
            checked.push(pr.to_string());
            None
        })
        .unwrap();
        assert_eq!(checked.len(), 10);
        assert!(!checked.iter().any(|pr| pr == "acme/app#1"));
        checked.clear();
        check_landed_with(&cache, &ids, |pr| {
            checked.push(pr.to_string());
            (pr == "acme/app#1").then_some(now)
        })
        .unwrap();
        assert_eq!(checked.len(), 10);
        assert!(checked.iter().any(|pr| pr == "acme/app#1"));
        assert!(!checked
            .iter()
            .any(|pr| pr == "acme/app#12" || pr == "acme/app#13"));
        let items = cached(&cache, &ids, 0).unwrap();
        assert!(items
            .iter()
            .any(|c| c.kind == "landed" && c.reference == "acme/app#1" && c.at == now));
    }

    #[test]
    fn cache_rescans_only_changed_timestamps_and_skips_unparseable_sessions() {
        let conn = db();
        let mut cache = cache();
        save(&conn, "s1", 10, "[]");
        assert!(collect_test(&conn, &mut cache, &["s1"], 0)
            .contributions
            .is_empty());
        let blocks = json!([block("gh pr create", "acme/app#1")]).to_string();
        save(&conn, "s1", 10, &blocks);
        assert!(collect_test(&conn, &mut cache, &["s1"], 0)
            .contributions
            .is_empty());
        save(&conn, "s1", 11, &blocks);
        let result = collect_test(&conn, &mut cache, &["s1", "missing"], 11);
        assert_eq!(result.contributions.len(), 1);
        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].updated_at, 11);
        assert!(collect_test(&conn, &mut cache, &["s1"], 12)
            .contributions
            .is_empty());
        save(&conn, "bad", 12, "[broken git commit");
        assert_eq!(
            collect_test(&conn, &mut cache, &["bad", "s1"], 0)
                .contributions
                .len(),
            1
        );
        conn.execute("DELETE FROM sessions WHERE id='s1'", [])
            .unwrap();
        let result = collect_test(&conn, &mut cache, &["s1"], 0);
        assert!(result.sessions.is_empty());
        assert!(result.contributions.is_empty());
        assert_eq!(
            cache
                .query_row("SELECT count(*) FROM contributions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn mono_blocks_and_normal_blocks_are_both_scanned_and_sorted_newest_first() {
        let conn = db();
        let mut cache = cache();
        save(&conn, "mono", 20, "[]");
        save(
            &conn,
            "normal",
            10,
            &json!([block("gh pr create", "acme/app#1")]).to_string(),
        );
        conn.execute(
            "INSERT INTO mono_blocks VALUES('mono',0,?1)",
            [block("gh pr create", "acme/app#2").to_string()],
        )
        .unwrap();
        let result = collect_test(&conn, &mut cache, &["mono", "normal"], 0);
        assert_eq!(
            result
                .contributions
                .iter()
                .map(|c| c.reference.as_str())
                .collect::<Vec<_>>(),
            ["acme/app#2", "acme/app#1"]
        );
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["contributions"][0]["sessionId"], "mono");
        assert_eq!(value["sessions"][0]["updatedAt"], 20);
        assert!(collect_test(&conn, &mut cache, &[], 0).sessions.is_empty());
    }

    #[test]
    fn argv_and_request_validation_is_strict() {
        assert!(valid_sha("abcdef0123"));
        for sha in [
            "",
            "abc",
            "--help",
            "abcdef0;pwd",
            "abcdef0\n",
            "ABCDEF0",
            "HEAD",
        ] {
            assert!(!valid_sha(sha), "{sha:?}");
        }
        assert!(pr_parts("owner/repo.name-1#12").is_some());
        assert!(pr_parts("owner/.github#12").is_some());
        assert!(pr_parts("owner/_repo#12").is_some());
        for pr in [
            "-o/repo#12",
            "o/-repo#12",
            "o/r#-1",
            "o/r#0",
            "o/r#12 --help",
            "o/r#12\n",
            "../r#12",
            "o/r/extra#12",
            "o/r#12@call",
        ] {
            assert!(pr_parts(pr).is_none(), "{pr:?}");
        }
        assert!(validate_ids(&["good-id_1".into()]).is_ok());
        assert!(validate_ids(&["../bad".into()]).is_err());
        assert!(validate_ids(&vec!["s1".into(); 2001]).is_err());
        assert!(validate_ids(&vec!["s1".into(); 2000]).is_ok());
    }

    #[test]
    fn a_disappearing_checkout_does_not_duplicate_an_already_resolved_commit() {
        let repo = Repo::new();
        let session = repo.session();
        let sha = repo.git(&["rev-parse", "HEAD"]);
        let conn = db();
        let mut cache = cache();
        let blocks = json!([block(
            "git commit -m initial",
            &format!("[main {}] initial", &sha[..7])
        )])
        .to_string();
        conn.execute(
            "INSERT INTO sessions VALUES('s1',?1,NULL,?2,?2,?3)",
            params![repo.0.to_str().unwrap(), session.updated_at, blocks],
        )
        .unwrap();
        let initial = collect_test(&conn, &mut cache, &["s1"], 0);
        assert_eq!(initial.contributions[0].reference, sha);
        conn.execute(
            "UPDATE sessions SET cwd='/missing',updated_at=updated_at+1",
            [],
        )
        .unwrap();
        let missing = collect_test(&conn, &mut cache, &["s1"], 0);
        assert_eq!(missing.contributions.len(), 1);
        assert_eq!(missing.contributions[0].reference, sha);
        assert_eq!(missing.contributions[0].additions, 2);
    }

    #[test]
    fn initial_scans_preserve_commits_before_each_amend_chain() {
        let a = block("git commit -m a", "[main aaaaaaa] a");
        let b = block("git commit -m b", "[main bbbbbbb] b");
        let c = block("git commit --amend -m c", "[main ccccccc] c");
        let d = block("git commit -m d", "[main ddddddd] d");
        let e = block("git commit --amend -m e", "[main eeeeeee] e");
        for (blocks, expected) in [
            (json!([a, b, c]), vec!["aaaaaaa", "ccccccc"]),
            (
                json!([a, b, c, d, e]),
                vec!["aaaaaaa", "ccccccc", "eeeeeee"],
            ),
        ] {
            let conn = db();
            let mut cache = cache();
            for at in [1, 2] {
                save(&conn, "s1", at, &blocks.to_string());
                let result = collect_test(&conn, &mut cache, &["s1"], 0);
                assert_eq!(
                    result
                        .contributions
                        .iter()
                        .map(|c| c.reference.as_str())
                        .collect::<Vec<_>>(),
                    expected
                );
            }
        }
    }

    #[test]
    fn batched_commits_keep_their_own_amend_and_dry_run_flags() {
        let conn = db();
        let mut cache = cache();
        save(
            &conn,
            "s1",
            1,
            &json!([
                block("git commit -m a", "[main aaaaaaa] a"),
                block(
                    "git commit -m b && git commit --amend --no-edit",
                    "[main bbbbbbb] b\n[main ccccccc] b"
                ),
                block("git commit --dry-run; git commit -m d", "[main ddddddd] d"),
            ])
            .to_string(),
        );
        let result = collect_test(&conn, &mut cache, &["s1"], 0);
        assert_eq!(
            result
                .contributions
                .iter()
                .map(|c| c.reference.as_str())
                .collect::<Vec<_>>(),
            ["aaaaaaa", "ccccccc", "ddddddd"]
        );
    }

    #[test]
    fn confirmation_is_kept_when_a_heredoc_message_is_not_shlex_parseable() {
        let session = Repo::new().session();
        let command = "git commit -m \"$(cat <<'EOF'\nHandle \"won't fix\" state\nEOF\n)\"";
        assert!(shlex::split(command).is_none());
        assert_eq!(detect(&session, command, "[main abcdef0] fix").len(), 1);
    }

    #[test]
    fn commit_messages_are_not_parsed_as_additional_git_commands() {
        let conn = db();
        let mut cache = cache();
        save(
            &conn,
            "s1",
            1,
            &json!([
                block("git commit -m a", "[main aaaaaaa] a"),
                block(
                    "git commit -m \"Explain git commit --amend usage\"",
                    "[main bbbbbbb] Explain usage"
                ),
            ])
            .to_string(),
        );
        assert_eq!(
            collect_test(&conn, &mut cache, &["s1"], 0)
                .contributions
                .len(),
            2
        );
    }

    #[test]
    fn sql_prefilter_keeps_git_config_options_and_named_github_review_tools() {
        let conn = db();
        let mut cache = cache();
        let mut review = block("", "https://github.com/acme/app/pull/1");
        review["tool"]["kind"] = json!("mcp__codex_apps__github_add_review_to_pr");
        save(
            &conn,
            "s1",
            1,
            &json!([
                block(
                    "git -c commit.gpgsign=false commit -m a",
                    "[main aaaaaaa] a"
                ),
                review,
            ])
            .to_string(),
        );
        let result = collect_test(&conn, &mut cache, &["s1"], 0);
        assert_eq!(result.contributions.len(), 2);
        assert!(result.contributions.iter().any(|c| c.kind == "review"));
    }

    #[cfg(unix)]
    #[test]
    fn gh_child_output_is_drained_and_its_deadline_is_enforced() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '%s' '{\"state\":\"MERGED\"} '"]);
        assert!(output_before(command, Duration::from_secs(1)).is_some());
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5"]);
        let start = Instant::now();
        assert!(output_before(command, Duration::from_millis(50)).is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 1"]);
        assert!(output_before(command, Duration::from_secs(1)).is_none());
    }
}
