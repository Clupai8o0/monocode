//! Fork feature: the message log, this Mac's side. Reads what Claude sessions
//! sent each other from their transcripts, by the rules in
//! src/fork/messageLog/messageLogProtocol.ts. Read-only, nothing saved; no
//! socket path, pid or token leaves this Mac.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const NOTICE_PREFIX: &str = "[Cross-session delivery notice]";
const LINE_HINTS: [&str; 4] = ["SendMessage", "cross-session", "\"peer\"", "delivery notice"];
const PREVIEW_MAX: usize = 600;
const KEY_MAX: usize = 160;
const SUMMARY_MAX: usize = 200;
const ERROR_MAX: usize = 300;
const EVENTS_MAX: usize = 2000;
const TAIL_MAX_BYTES: u64 = 64 * 1024 * 1024;
const WINDOW_HOURS_DEFAULT: i64 = 24;
const WINDOW_HOURS_MAX: i64 = 168;
const HOUR_MS: i64 = 3_600_000;
const ACCOUNTS: [(&str, &str); 3] = [(".claude", "main"), (".claude-exec", "cx"), (".claude-cx", "cx")];

// ---- shapes ----

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Since {
    pub epoch: String,
    pub cursor: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLogParams {
    pub since: Option<Since>,
    pub window_hours: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<&'static str>,
}

/// A send or a receive; the fields of the other kind stay None.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub kind: &'static str,
    pub id: String,
    pub rev: u64,
    pub at: i64,
    pub updated_at: i64,
    pub session_id: String,
    pub account: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_address: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Resolved>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_address: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<Resolved>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub preview: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The raw "uds:…" or "bridge:…" address; never sent on.
    #[serde(skip)]
    address: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSession {
    pub session_id: String,
    pub account: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub cwd: String,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogProxy {
    pub name: String,
    pub machine: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLogAnswer {
    pub version: u8,
    pub machine: String,
    pub epoch: String,
    pub cursor: u64,
    pub full: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    pub window_hours: i64,
    pub scanned_at: i64,
    pub sessions: Vec<LogSession>,
    pub proxies: Vec<LogProxy>,
    pub events: Vec<LogEvent>,
}

// ---- text rules ----

fn is_ws(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ')
}

fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

fn take(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((at, _)) => &s[..at],
        None => s,
    }
}

fn socket_stop(c: char) -> bool {
    is_ws(c) || matches!(c, '\'' | '"' | ')' | ',' | ';')
}

/// Socket addresses become "uds:…", quoted absolute paths "'…'", and any
/// other path ending in ".sock" "…" (SCRUB_SOCK_PATH).
pub(crate) fn scrub(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("uds:") {
        let after = &rest[at + 4..];
        let run = &after[..after.find(socket_stop).unwrap_or(after.len())];
        let kept = run.trim_end_matches([':', '.']);
        if kept.is_empty() {
            out.push_str(&rest[..at + 4]);
        } else {
            out.push_str(&rest[..at]);
            out.push_str("uds:…");
        }
        rest = &after[kept.len()..];
    }
    out.push_str(rest);
    let mut done = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(at) = rest.find("'/") {
        let after = &rest[at + 2..];
        let Some(end) = after.find('\'') else {
            break;
        };
        done.push_str(&rest[..at]);
        done.push_str("'…'");
        rest = &after[end + 1..];
    }
    done.push_str(rest);
    scrub_sock_paths(&done)
}

/// `/[^\t\n\x0B\x0C\r '"),;]*\.sock/g` -> "…": from a "/", the longest run
/// of path characters that ends in ".sock".
fn scrub_sock_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut from = 0;
    while let Some(found) = rest[from..].find('/') {
        let at = from + found;
        let run = &rest[at + 1..];
        let run = &run[..run.find(socket_stop).unwrap_or(run.len())];
        match run.rfind(".sock") {
            Some(end) => {
                out.push_str(&rest[..at]);
                out.push('…');
                rest = &rest[at + 1 + end + 5..];
                from = 0;
            }
            None => from = at + 1,
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn preview_of(body: &str) -> String {
    let scrubbed = scrub(body);
    take(trim(&scrubbed), PREVIEW_MAX)
        .trim_end_matches(is_ws)
        .to_string()
}

/// The text a send, its receive and a relay hop share.
pub(crate) fn key_of(body: &str) -> String {
    let scrubbed = scrub(body);
    let mut joined = String::with_capacity(scrubbed.len());
    let mut gap = false;
    for c in trim(&scrubbed).chars() {
        if is_ws(c) {
            gap = true;
            continue;
        }
        if gap {
            joined.push(' ');
            gap = false;
        }
        joined.push(c);
    }
    take(&joined, KEY_MAX).trim_end_matches(is_ws).to_string()
}

pub(crate) fn clip(text: &str, max: usize) -> Option<String> {
    let scrubbed = scrub(text);
    let cut = take(trim(&scrubbed), max).trim_end_matches(is_ws);
    (!cut.is_empty()).then(|| cut.to_string())
}

/// The body inside the first `<cross-session-message …>` wrapper, with the
/// opening tag.
pub(crate) fn wrapper(text: &str) -> Option<(&str, &str)> {
    let start = text.find("<cross-session-message")?;
    let rest = &text[start..];
    let open_end = rest.find('>')?;
    let body = &rest[open_end + 1..];
    let close = body.find("</cross-session-message>")?;
    Some((&rest[..open_end], &body[..close]))
}

pub(crate) fn attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let at = tag.find(&needle)? + needle.len();
    let rest = &tag[at..];
    Some(rest[..rest.find('"')?].to_string())
}

fn session_file(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn subagent_id(id: &str) -> bool {
    id.len() >= 16
        && id.starts_with('a')
        && id[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn address_kind(address: &str) -> &'static str {
    if address.starts_with("uds:") {
        "socket"
    } else if address.starts_with("bridge:") {
        "bridge"
    } else {
        "name"
    }
}

fn parse_at(value: &Value) -> Option<i64> {
    let text = value.as_str()?;
    let at = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    Some((at.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn content_text(message: &Value) -> Option<String> {
    match &message["content"] {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

fn str_of(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

// ---- registries ----

#[derive(Clone, Debug)]
struct Entry {
    relay: bool,
    machine: String,
    session_id: String,
    account: Option<&'static str>,
    name: Option<String>,
    socket: Option<String>,
    bridge: Option<String>,
    updated_at: Option<i64>,
    cwd: String,
    status: Option<String>,
    live: bool,
}

impl Entry {
    fn resolved(&self, route: &'static str) -> Resolved {
        Resolved {
            machine: Some(self.machine.clone()),
            session_id: Some(self.session_id.clone()),
            account: self.account,
            name: self.name.clone(),
            route: Some(if route == "bridge" {
                route
            } else if self.relay {
                "relay"
            } else {
                "local"
            }),
        }
    }
}

fn relay_account(text: Option<&str>) -> Option<&'static str> {
    match text {
        Some(".claude") => Some("main"),
        Some(".claude-exec") | Some(".claude-cx") => Some("cx"),
        _ => None,
    }
}

fn parse_entry(v: &Value, account: &'static str, machine: &str, live: &dyn Fn(&Value) -> bool) -> Option<Entry> {
    let relay = crate::fork_relay::is_relay_entry(v);
    let text = |key: &str| v[key].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let mut entry = Entry {
        relay,
        machine: machine.to_string(),
        session_id: text("sessionId").unwrap_or_default(),
        account: Some(account),
        name: text("name"),
        socket: text("messagingSocketPath"),
        bridge: text("bridgeSessionId"),
        updated_at: v["updatedAt"].as_i64().or_else(|| v["updatedAt"].as_f64().map(|f| f as i64)),
        cwd: text("cwd").unwrap_or_default(),
        status: text("status"),
        live: false,
    };
    if relay {
        let r = &v["monocodeRelay"];
        entry.machine = r["machine"]
            .as_str()
            .map(str::to_string)
            .or_else(|| v["pidDomain"].as_str().and_then(|d| d.strip_prefix("relay:")).map(str::to_string))
            .unwrap_or_default();
        if let Some(remote) = r["remoteSessionId"].as_str() {
            entry.session_id = remote.to_string();
        }
        entry.account = relay_account(r["account"].as_str());
    } else {
        entry.live = live(v);
    }
    (!entry.session_id.is_empty()).then_some(entry)
}

fn registry_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

/// The account folders to read, each real folder once.
fn accounts(home: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (dir, account) in ACCOUNTS {
        let path = home.join(dir);
        let Ok(real) = std::fs::canonicalize(&path) else {
            continue;
        };
        if seen.insert(real) {
            out.push((path, account));
        }
    }
    out
}

fn read_entries(home: &Path, machine: &str, live: &dyn Fn(&Value) -> bool) -> Vec<Entry> {
    let mut out = Vec::new();
    for (dir, account) in accounts(home) {
        let Ok(files) = std::fs::read_dir(dir.join("sessions")) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = files.flatten().map(|e| e.path()).filter(|p| registry_file(p)).collect();
        paths.sort();
        for path in paths {
            let Some(v) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            else {
                continue;
            };
            if let Some(entry) = parse_entry(&v, account, machine, live) {
                out.push(entry);
            }
        }
    }
    out
}

fn same_path(a: &str, b: &str) -> bool {
    a == b
        || match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
}

fn resolve(entries: &[Entry], address: Option<&str>, name: Option<&str>) -> Option<Resolved> {
    if let Some(path) = address.and_then(|a| a.strip_prefix("uds:")) {
        if let Some(e) = entries
            .iter()
            .find(|e| e.socket.as_deref().is_some_and(|s| same_path(s, path)))
        {
            return Some(e.resolved("socket"));
        }
    }
    if let Some(id) = address.and_then(|a| a.strip_prefix("bridge:")) {
        if let Some(e) = entries.iter().find(|e| e.bridge.as_deref() == Some(id)) {
            return Some(e.resolved("bridge"));
        }
    }
    let name = name.filter(|n| !n.is_empty())?;
    entries
        .iter()
        .filter(|e| e.name.as_deref() == Some(name))
        .max_by_key(|e| e.updated_at.unwrap_or(0))
        .map(|e| e.resolved("name"))
}

// ---- transcripts ----

#[derive(Default)]
struct FileState {
    offset: u64,
    inode: u64,
    events: HashMap<String, LogEvent>,
    /// tool_use id -> event id, for sends still waiting for their result.
    waiting: HashMap<String, String>,
}

fn inode(meta: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.ino()
    }
    #[cfg(not(unix))]
    {
        meta.created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos() as u64)
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

struct Ctx<'a> {
    session_id: &'a str,
    account: &'static str,
    scan: u64,
}

impl FileState {
    fn line(&mut self, ctx: &Ctx, raw: &[u8], offset: u64) {
        let Ok(text) = std::str::from_utf8(raw) else {
            return;
        };
        let hinted = LINE_HINTS.iter().any(|h| text.contains(h))
            || self.waiting.keys().any(|id| text.contains(id.as_str()));
        if !hinted {
            return;
        }
        let Ok(rec) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let Some(at) = parse_at(&rec["timestamp"]) else {
            return;
        };
        match rec["type"].as_str() {
            Some("assistant") => self.sends(ctx, &rec, at),
            Some("user") => {
                self.results(ctx, &rec, at);
                let body = content_text(&rec["message"]);
                if let Some(body) = &body {
                    if body.starts_with(NOTICE_PREFIX) {
                        self.notice(ctx, body, at);
                        return;
                    }
                }
                self.receive(ctx, &rec, body.as_deref(), at, offset);
            }
            _ => {}
        }
    }

    fn sends(&mut self, ctx: &Ctx, rec: &Value, at: i64) {
        let Some(parts) = rec["message"]["content"].as_array() else {
            return;
        };
        for part in parts {
            if part["type"] != "tool_use" || part["name"] != "SendMessage" {
                continue;
            }
            let (Some(tool), input) = (part["id"].as_str(), &part["input"]) else {
                continue;
            };
            let Some(to) = input["to"].as_str().or_else(|| input["recipient"].as_str()) else {
                continue;
            };
            let body = input["message"]
                .as_str()
                .or_else(|| input["content"].as_str())
                .unwrap_or("");
            if subagent_id(to) || input["recipient_kind"] == "agent" || trim(body).is_empty() {
                continue;
            }
            let kind = address_kind(to);
            let id = format!("{}:{tool}", ctx.session_id);
            let event = LogEvent {
                kind: "send",
                id: id.clone(),
                rev: ctx.scan,
                at,
                updated_at: at,
                session_id: ctx.session_id.to_string(),
                account: ctx.account,
                to: Some(if kind == "name" { scrub(to) } else { String::new() }),
                to_address: Some(kind),
                to_name: None,
                target: None,
                from_name: None,
                from_address: None,
                sender: None,
                summary: input["summary"].as_str().and_then(|s| clip(s, SUMMARY_MAX)),
                preview: preview_of(body),
                key: key_of(body),
                msg_id: None,
                status: Some("pending"),
                error: None,
                address: (kind != "name").then(|| to.to_string()),
            };
            self.events.insert(id.clone(), event);
            self.waiting.insert(tool.to_string(), id);
        }
    }

    fn results(&mut self, ctx: &Ctx, rec: &Value, at: i64) {
        let Some(parts) = rec["message"]["content"].as_array() else {
            return;
        };
        for part in parts {
            if part["type"] != "tool_result" {
                continue;
            }
            let Some(event_id) = part["tool_use_id"].as_str().and_then(|t| self.waiting.remove(t)) else {
                continue;
            };
            let part_text = match &part["content"] {
                Value::String(s) => Some(s.clone()),
                Value::Array(items) => items
                    .iter()
                    .find(|i| i["type"] == "text")
                    .and_then(|i| str_of(&i["text"])),
                _ => None,
            };
            let result = if rec["toolUseResult"].is_object() {
                Some(rec["toolUseResult"].clone())
            } else {
                part_text
                    .as_deref()
                    .and_then(|t| serde_json::from_str::<Value>(t).ok())
                    .filter(Value::is_object)
            };
            let message = result.as_ref().and_then(|r| str_of(&r["message"]));
            let said = message.clone().or_else(|| part_text.clone()).unwrap_or_default();
            let subagent = result
                .as_ref()
                .is_some_and(|r| !r["pin"].is_null() || !r["resumedAgentId"].is_null())
                || said.starts_with("Resuming agent")
                || said.starts_with("Message queued for delivery to");
            if subagent {
                self.events.remove(&event_id);
                continue;
            }
            let Some(event) = self.events.get_mut(&event_id) else {
                continue;
            };
            event.updated_at = at;
            event.rev = ctx.scan;
            let failed = result.as_ref().is_some_and(|r| r["success"] == false) || part["is_error"] == true;
            if failed {
                let words = match &result {
                    Some(_) => message,
                    None => part_text.map(|t| {
                        let t = trim(&t);
                        let t = t.strip_prefix("<tool_use_error>").unwrap_or(t);
                        let t = t.strip_suffix("</tool_use_error>").unwrap_or(t);
                        t.to_string()
                    }),
                };
                event.status = Some("failed");
                event.error = Some(
                    words
                        .and_then(|w| clip(&w, ERROR_MAX))
                        .unwrap_or_else(|| "Not sent".to_string()),
                );
                continue;
            }
            event.status = Some("sent");
            event.msg_id = result
                .as_ref()
                .and_then(|r| str_of(&r["msg_id"]))
                .filter(|m| !m.is_empty());
            if event.address.is_some() {
                event.to_name = message.as_deref().and_then(to_name);
            }
        }
    }

    fn notice(&mut self, ctx: &Ctx, text: &str, at: i64) {
        let Some(start) = text.find("msg_id: ") else {
            return;
        };
        let id = take(&text[start + 8..], 36);
        if id.chars().count() != 36 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return;
        }
        const PHRASES: [(&str, &str, Option<&str>); 5] = [
            ("held by that session", "held", None),
            ("approved and released", "released", None),
            ("not approved before expiry", "expired", None),
            ("denied by the recipient user", "failed", Some("Denied by that session's user")),
            (
                "refused",
                "failed",
                Some("Refused: that session is not accepting messages from other sessions"),
            ),
        ];
        let Some((_, status, error)) = PHRASES
            .iter()
            .filter_map(|p| text.find(p.0).map(|at| (at, p)))
            .min_by_key(|(at, _)| *at)
            .map(|(_, p)| *p)
        else {
            return;
        };
        let Some(event) = self
            .events
            .values_mut()
            .find(|e| e.kind == "send" && e.msg_id.as_deref() == Some(id))
        else {
            return;
        };
        event.status = Some(status);
        event.error = error.map(str::to_string);
        event.updated_at = at;
        event.rev = ctx.scan;
    }

    fn receive(&mut self, ctx: &Ctx, rec: &Value, text: Option<&str>, at: i64, offset: u64) {
        let origin = &rec["origin"];
        let peer = origin["kind"] == "peer";
        let wrapped = text.and_then(wrapper);
        if !peer && !(origin.is_null() && wrapped.is_some()) {
            return;
        }
        let body = origin["body"]
            .as_str()
            .map(str::to_string)
            .or_else(|| wrapped.map(|(_, b)| b.to_string()))
            .unwrap_or_default();
        if trim(&body).is_empty() {
            return;
        }
        let from = str_of(&origin["from"]).or_else(|| wrapped.and_then(|(tag, _)| attr(tag, "from")));
        let from_name = str_of(&origin["name"])
            .or_else(|| wrapped.and_then(|(tag, _)| attr(tag, "from-name")))
            .map(|n| scrub(&n))
            .filter(|n| !n.is_empty());
        let id = match rec["uuid"].as_str() {
            Some(uuid) => format!("{}:{uuid}", ctx.session_id),
            None => format!("{}:r{offset}", ctx.session_id),
        };
        let kind = from.as_deref().map_or("name", address_kind);
        let event = LogEvent {
            kind: "receive",
            id: id.clone(),
            rev: ctx.scan,
            at,
            updated_at: at,
            session_id: ctx.session_id.to_string(),
            account: ctx.account,
            to: None,
            to_address: None,
            to_name: None,
            target: None,
            from_name,
            from_address: Some(kind),
            sender: None,
            summary: None,
            preview: preview_of(&body),
            key: key_of(&body),
            msg_id: str_of(&origin["msg_id"]).filter(|m| !m.is_empty()),
            status: None,
            error: None,
            address: from.filter(|_| kind != "name"),
        };
        self.events.insert(id, event);
    }
}

/// The name a send result gives for a send to an address.
fn to_name(message: &str) -> Option<String> {
    let after = match message.find("” → ") {
        Some(at) => &message[at + "” → ".len()..],
        None => message.strip_prefix("→ ")?,
    };
    let end = [after.find(" ("), after.find(';'), after.find('\n')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(after.len());
    let name = scrub(trim(&after[..end]));
    let name = trim(&name);
    (!name.is_empty() && !name.starts_with("uds:") && !name.starts_with("bridge:")).then(|| name.to_string())
}

// ---- the reader ----

pub(crate) struct Scan<'a> {
    pub home: &'a Path,
    pub machine: &'a str,
    pub now: i64,
    pub live: &'a dyn Fn(&Value) -> bool,
}

pub(crate) struct Reader {
    epoch: String,
    scan: u64,
    last_window: Option<i64>,
    tail_max: u64,
    files: HashMap<PathBuf, FileState>,
}

impl Reader {
    pub fn new() -> Reader {
        Reader {
            epoch: uuid::Uuid::new_v4().to_string(),
            scan: 0,
            last_window: None,
            tail_max: TAIL_MAX_BYTES,
            files: HashMap::new(),
        }
    }

    pub fn run(&mut self, scan: &Scan, params: &MessageLogParams) -> MessageLogAnswer {
        self.scan += 1;
        let window = params
            .window_hours
            .map_or(WINDOW_HOURS_DEFAULT, |h| (h.floor() as i64).clamp(1, WINDOW_HOURS_MAX));
        let from = scan.now - window * HOUR_MS;
        let entries = read_entries(scan.home, scan.machine, scan.live);

        for (dir, account) in accounts(scan.home) {
            let Ok(projects) = std::fs::read_dir(dir.join("projects")) else {
                continue;
            };
            for project in projects.flatten() {
                let Ok(files) = std::fs::read_dir(project.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    let Some(id) = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.strip_suffix(".jsonl"))
                        .filter(|id| session_file(id))
                        .map(str::to_string)
                    else {
                        continue;
                    };
                    let Ok(meta) = std::fs::metadata(&path) else {
                        continue;
                    };
                    if !meta.is_file() || mtime_ms(&meta) < from {
                        continue;
                    }
                    self.read_file(&path, &meta, &id, account);
                }
            }
        }

        let forget = scan.now - WINDOW_HOURS_MAX * HOUR_MS;
        let mut events = Vec::new();
        for state in self.files.values_mut() {
            state.events.retain(|_, e| e.at >= forget);
            for event in state.events.values_mut() {
                if event.rev == self.scan {
                    if event.kind == "send" {
                        let name = if event.address.is_some() {
                            event.to_name.clone()
                        } else {
                            event.to.clone()
                        };
                        event.target = resolve(&entries, event.address.as_deref(), name.as_deref());
                    } else {
                        event.sender = resolve(&entries, event.address.as_deref(), event.from_name.as_deref());
                    }
                }
                events.push(event.clone());
            }
        }

        let same = params.since.as_ref().filter(|s| s.epoch == self.epoch);
        let full = same.is_none() || self.last_window != Some(window);
        self.last_window = Some(window);
        let cursor = same.map_or(0, |s| s.cursor);
        events.retain(|e| e.at >= from && (full || e.rev > cursor));
        events.sort_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)));
        let mut truncated = None;
        if full && events.len() > EVENTS_MAX {
            events.drain(..events.len() - EVENTS_MAX);
            truncated = Some(true);
        }

        let mut sessions: HashMap<&str, &Entry> = HashMap::new();
        let mut proxies: HashMap<(&str, &str), &Entry> = HashMap::new();
        for e in &entries {
            if e.relay {
                proxies.entry((&e.machine, &e.session_id)).or_insert(e);
            } else if e.live {
                match sessions.get(e.session_id.as_str()) {
                    Some(old) if old.updated_at >= e.updated_at => {}
                    _ => {
                        sessions.insert(&e.session_id, e);
                    }
                }
            }
        }
        let mut sessions: Vec<LogSession> = sessions
            .into_values()
            .map(|e| LogSession {
                session_id: e.session_id.clone(),
                account: e.account.unwrap_or("main"),
                name: e.name.clone(),
                cwd: e.cwd.clone(),
                project: e.cwd.rsplit('/').find(|p| !p.is_empty()).unwrap_or("").to_string(),
                status: e.status.clone(),
                updated_at: e.updated_at,
            })
            .collect();
        sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        let mut proxies: Vec<LogProxy> = proxies
            .into_values()
            .map(|e| LogProxy {
                name: e.name.clone().unwrap_or_default(),
                machine: e.machine.clone(),
                session_id: e.session_id.clone(),
                account: e.account,
            })
            .collect();
        proxies.sort_by(|a, b| (&a.session_id, &a.machine).cmp(&(&b.session_id, &b.machine)));

        MessageLogAnswer {
            version: 1,
            machine: scan.machine.to_string(),
            epoch: self.epoch.clone(),
            cursor: self.scan,
            full,
            truncated,
            window_hours: window,
            scanned_at: scan.now,
            sessions,
            proxies,
            events,
        }
    }

    fn read_file(&mut self, path: &Path, meta: &std::fs::Metadata, id: &str, account: &'static str) {
        let size = meta.len();
        let ino = inode(meta);
        let known = self.files.contains_key(path);
        let state = self.files.entry(path.to_path_buf()).or_default();
        let mut start = state.offset;
        let mut skip_partial = false;
        if !known || state.inode != ino || size < state.offset {
            *state = FileState {
                inode: ino,
                ..FileState::default()
            };
            start = 0;
            if size > self.tail_max {
                start = size - self.tail_max;
                skip_partial = true;
            }
        }
        if size <= start {
            state.offset = start.max(state.offset);
            return;
        }
        let Ok(mut file) = File::open(path) else {
            return;
        };
        if file.seek(SeekFrom::Start(start)).is_err() {
            return;
        }
        let mut bytes = Vec::new();
        if file.take(size - start).read_to_end(&mut bytes).is_err() {
            return;
        }
        let mut pos = 0usize;
        if skip_partial {
            match bytes.iter().position(|&b| b == b'\n') {
                Some(at) => pos = at + 1,
                None => {
                    return;
                }
            }
        }
        let Some(last) = bytes.iter().rposition(|&b| b == b'\n') else {
            state.offset = start + pos as u64;
            return;
        };
        let ctx = Ctx {
            session_id: id,
            account,
            scan: self.scan,
        };
        while pos <= last {
            let end = pos + bytes[pos..].iter().position(|&b| b == b'\n').unwrap_or(last - pos);
            state.line(&ctx, &bytes[pos..end], start + pos as u64);
            pos = end + 1;
        }
        state.offset = start + last as u64 + 1;
    }
}

// ---- command ----

static READER: LazyLock<Mutex<Option<Reader>>> = LazyLock::new(|| Mutex::new(None));

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn system_scan(params: MessageLogParams) -> MessageLogAnswer {
    use crate::fork_external_sessions::{is_live, Env};
    let env = Env::system();
    let live = |v: &Value| {
        let pid = v["pid"].as_i64().or_else(|| v["pid"].as_f64().map(|f| f as i64)).unwrap_or(0);
        let start = match &v["procStart"] {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        };
        is_live(&env, pid, start.as_deref())
    };
    let machine = crate::fork_relay::relay_machine_name();
    let home = env.home.clone();
    let scan = Scan {
        home: &home,
        machine: &machine,
        now: now_ms(),
        live: &live,
    };
    let mut slot = READER.lock().unwrap_or_else(PoisonError::into_inner);
    slot.get_or_insert_with(Reader::new).run(&scan, &params)
}

/// The message log on this Mac.
#[tauri::command]
pub async fn fork_message_log(params: Option<MessageLogParams>) -> Result<MessageLogAnswer, String> {
    let params = params.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || system_scan(params))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/message-log")
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), &target).unwrap();
            }
        }
    }

    fn touch_all(dir: &Path, when: SystemTime) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                touch_all(&entry.path(), when);
            } else {
                File::options()
                    .append(true)
                    .open(entry.path())
                    .unwrap()
                    .set_modified(when)
                    .unwrap();
            }
        }
    }

    fn at_ms(text: &str) -> i64 {
        parse_at(&Value::String(text.into())).unwrap()
    }

    #[test]
    fn runs_every_fixture_step() {
        let fx = fixture();
        // git ignores home/.claude in some checkouts; the script writes it again.
        if !fx.join("home/.claude").exists() {
            let ok = std::process::Command::new("python3")
                .arg(fx.join("make_fixture.py"))
                .status()
                .is_ok_and(|s| s.success());
            assert!(ok, "make_fixture.py failed");
        }
        let expected: Value = serde_json::from_slice(&std::fs::read(fx.join("expected.json")).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("monocode-msglog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        copy_dir(&fx.join("home"), &dir.join("home"));
        let home = dir.join("home");
        let machine = expected["machine"].as_str().unwrap();
        let live = |v: &Value| !crate::fork_relay::is_relay_entry(v);
        let mut reader = Reader::new();
        let mut previous: Option<(String, u64)> = None;
        let mut all = String::new();
        for step in expected["steps"].as_array().unwrap() {
            let now = at_ms(step["now"].as_str().unwrap());
            for append in step["append"].as_array().into_iter().flatten() {
                let to = dir.join(append["to"].as_str().unwrap());
                let text = std::fs::read(fx.join(append["from"].as_str().unwrap())).unwrap();
                File::options().append(true).open(&to).unwrap().write_all(&text).unwrap();
            }
            touch_all(&home, UNIX_EPOCH + std::time::Duration::from_millis(now as u64));
            let p = &step["params"];
            let since = match &p["since"] {
                Value::String(s) if s == "previous" => previous.clone().map(|(epoch, cursor)| Since { epoch, cursor }),
                Value::Object(_) => Some(Since {
                    epoch: p["since"]["epoch"].as_str().unwrap().into(),
                    cursor: p["since"]["cursor"].as_u64().unwrap(),
                }),
                _ => None,
            };
            let params = MessageLogParams {
                since,
                window_hours: p["windowHours"].as_f64(),
            };
            let scan = Scan {
                home: &home,
                machine,
                now,
                live: &live,
            };
            let answer = reader.run(&scan, &params);
            previous = Some((answer.epoch.clone(), answer.cursor));
            let mut got = serde_json::to_value(&answer).unwrap();
            all.push_str(&got.to_string());
            got.as_object_mut().unwrap().remove("epoch");
            let mut want = step["expect"].clone();
            let w = want.as_object_mut().unwrap();
            w.insert("version".into(), 1.into());
            w.insert("machine".into(), machine.into());
            w.insert("scannedAt".into(), now.into());
            w.entry("sessions").or_insert(expected["sessions"].clone());
            w.entry("proxies").or_insert(expected["proxies"].clone());
            if got != want {
                let (g, w) = (&got["events"], &want["events"]);
                for i in 0..g.as_array().unwrap().len().max(w.as_array().unwrap().len()) {
                    assert_eq!(g[i], w[i], "step {}: event {i}", step["name"]);
                }
                assert_eq!(got, want, "step {}", step["name"]);
            }
        }
        for word in expected["forbidden"].as_array().unwrap() {
            assert!(!all.contains(word.as_str().unwrap()), "answer holds {word}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scrubs_sockets_and_quoted_paths() {
        assert_eq!(scrub("to uds:/tmp/a.sock: gone"), "to uds:…: gone");
        assert_eq!(scrub("uds:/x/y.sock."), "uds:….");
        assert_eq!(scrub("uds: nothing"), "uds: nothing");
        assert_eq!(scrub("(uds:/a/b),uds:/c;"), "(uds:…),uds:…;");
        assert_eq!(scrub("lstat '/tmp/1.sock' and 'rel' 'x"), "lstat '…' and 'rel' 'x");
        assert_eq!(scrub("uds:..: a"), "uds:..: a");
        assert_eq!(scrub("connect ECONNREFUSED /tmp/cc-socks/777.sock"), "connect ECONNREFUSED …");
        assert_eq!(scrub("(/a/b.sock), /c.sock;/d.sock.x"), "(…), …;….x");
        assert_eq!(scrub("/a.sock/b.sock/c and /x/y"), "…/c and /x/y");
        assert_eq!(scrub("a/b c/d.sock"), "a/b c…");
        assert_eq!(scrub("/.sock é/ü.sock"), "… é…");
        assert_eq!(scrub("/tmp/x.socket"), "…et");
    }

    #[test]
    fn cuts_by_code_points_and_collapses_whitespace() {
        let body = format!("  {}\u{a0}x\t\n y  ", "🙂".repeat(170));
        assert_eq!(key_of(&body).chars().count(), 160);
        assert!(key_of(&body).chars().all(|c| c == '🙂'));
        assert_eq!(key_of(" a \u{b}\u{c} b\r\nc "), "a b c");
        // A no-break space is not whitespace here.
        assert_eq!(key_of("a\u{a0} b"), "a\u{a0} b");
        assert_eq!(preview_of(&"é".repeat(700)).chars().count(), 600);
        assert_eq!(clip("   ", 10), None);
        assert_eq!(clip(&format!("{} z", "a".repeat(9)), 10).as_deref(), Some("aaaaaaaaa"));
    }

    #[test]
    fn reads_only_the_tail_of_a_big_file() {
        let dir = std::env::temp_dir().join(format!("monocode-msglog-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join(".claude/projects/-p/abcdefgh-1234.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let line = |uuid: &str| {
            format!(
                "{{\"type\":\"user\",\"uuid\":\"{uuid}\",\"timestamp\":\"2026-10-29T08:00:00.000Z\",\"origin\":{{\"kind\":\"peer\",\"body\":\"hi\"}}}}\n"
            )
        };
        let first = line("old-one");
        std::fs::write(&file, format!("{first}{}", line("new-one"))).unwrap();
        let mut reader = Reader::new();
        reader.tail_max = (line("new-one").len() + 5) as u64;
        let live = |_: &Value| true;
        let scan = Scan {
            home: &dir,
            machine: "m",
            now: at_ms("2026-10-29T09:00:00.000Z"),
            live: &live,
        };
        let answer = reader.run(&scan, &MessageLogParams::default());
        let ids: Vec<&str> = answer.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["abcdefgh-1234:new-one"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drops_subagent_sends_by_plain_text_and_leaves_empty_fields_out() {
        // The same transcript is in host/messages.test.ts.
        let dir = std::env::temp_dir().join(format!("monocode-msglog-parity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join(".claude/projects/-p/abcdefgh-1234.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let at = "2026-10-29T08:00:00.000Z";
        let lines = [
            serde_json::json!({"type": "assistant", "timestamp": at, "message": {"content": [
                {"type": "tool_use", "name": "SendMessage", "id": "toolu_Q", "input": {"to": "worker", "message": "go"}},
                {"type": "tool_use", "name": "SendMessage", "id": "toolu_S", "input": {"to": "peer", "message": "hi"}},
            ]}}),
            serde_json::json!({"type": "user", "timestamp": at, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "toolu_Q", "content": "Message queued for delivery to worker"},
                {"type": "tool_result", "tool_use_id": "toolu_S", "content": "{\"success\":true,\"msg_id\":\"\"}"},
            ]}}),
            serde_json::json!({"type": "user", "uuid": "u-empty", "timestamp": at, "origin": {"kind": "peer", "body": "  ", "name": "x"}}),
            serde_json::json!({"type": "user", "uuid": "u-blank", "timestamp": at, "origin": {"kind": "peer", "body": "yo", "name": "", "msg_id": ""}}),
        ];
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(&file, text).unwrap();
        let live = |_: &Value| true;
        let scan = Scan {
            home: &dir,
            machine: "m",
            now: at_ms("2026-10-29T09:00:00.000Z"),
            live: &live,
        };
        let answer = Reader::new().run(&scan, &MessageLogParams::default());
        let ids: Vec<&str> = answer.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["abcdefgh-1234:toolu_S", "abcdefgh-1234:u-blank"]);
        let got = serde_json::to_value(&answer.events).unwrap();
        assert_eq!(got[0]["status"], "sent");
        assert!(got[0].get("msgId").is_none());
        assert!(got[1].get("fromName").is_none());
        assert!(got[1].get("msgId").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
