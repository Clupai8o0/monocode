//! Fork feature: read Grok Bot's local cache (bots and chats), read only.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const CACHE_DIR: &str = "Library/Application Support/Grok Bot/sand-client-persistence";
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

const NO_DATA: &str = "Grok Bot has no saved data on this Mac.";
const NO_HOME: &str = "No home folder.";
const INVALID_BOT_ID: &str = "Invalid bot id.";
const ROSTER_FORMAT: &str = "Grok Bot's saved bot list has an unknown format.";
const ROSTER_TOO_LARGE: &str = "Grok Bot's saved bot list is too large to read.";
const CHAT_FORMAT: &str = "Grok Bot's saved chat has an unknown format.";
const CHAT_TOO_LARGE: &str = "That chat is too large to read.";
const NO_CHAT: &str = "No saved chat for that bot.";

const ROSTER_SLICE: &str = "roster.last-roster";
const TRANSCRIPT_PREFIX: &str = "transcript.replicas.";
const KEY_PREFIX: &str = "sand.client.slice.account.";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokBotBot {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub title: Option<String>,
    pub last_activity_at: Option<i64>,
    pub last_preview: Option<String>,
    pub unread_count: i64,
    pub has_unread: bool,
    pub awaiting_reply: bool,
    pub hidden: bool,
    pub has_chat: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokBotRoster {
    pub schema_version: i64,
    pub saved_at: Option<i64>,
    pub bots: Vec<GrokBotBot>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokBotEntry {
    pub id: String,
    pub seq: i64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub text: Option<String>,
    pub at: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub streaming: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_agent: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokBotChat {
    pub bot_id: String,
    pub schema_version: i64,
    pub persisted_at: Option<i64>,
    pub total: usize,
    pub more_before: bool,
    pub entries: Vec<GrokBotEntry>,
}

#[derive(Debug, Clone, Copy)]
pub struct ReadOptions {
    pub limit: usize,
    pub since_ms: Option<i64>,
    pub before_seq: Option<i64>,
    pub max_chars: usize,
}

/// Decode a cache file name into its key.
pub fn decode_blob_name(file_name: &str) -> Option<String> {
    let name = file_name.strip_suffix(".blob")?;
    if name.is_empty() {
        return None;
    }
    let mut bytes = Vec::with_capacity(name.len() * 5 / 8);
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for byte in name.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => {
                return None;
            }
        };
        buffer = (buffer << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= (1u32 << bits) - 1;
        }
    }
    String::from_utf8(bytes).ok()
}

/// Split a decoded key into its account and slice.
/// The account can hold dots (an email login, say), so the known slices are
/// found from the right first.
pub fn split_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix(KEY_PREFIX)?;
    let roster = format!(".{ROSTER_SLICE}");
    let transcript = format!(".{TRANSCRIPT_PREFIX}");
    let cut = if rest.ends_with(&roster) {
        rest.len() - roster.len()
    } else if let Some(at) = rest.rfind(&transcript) {
        at
    } else {
        rest.find('.')?
    };
    let (account, slice) = (&rest[..cut], &rest[cut + 1..]);
    if account.is_empty() || slice.is_empty() {
        return None;
    }
    Some((account.to_string(), slice.to_string()))
}

/// Parse the saved roster JSON.
pub fn parse_roster(json: &str) -> Result<(i64, Vec<GrokBotBot>), String> {
    let document =
        serde_json::from_str::<serde_json::Value>(json).map_err(|_| ROSTER_FORMAT.to_string())?;
    if !document.is_object() {
        return Err(ROSTER_FORMAT.to_string());
    }
    let schema_version = document
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let rows = document
        .get("value")
        .and_then(|value| value.get("rows"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ROSTER_FORMAT.to_string())?;

    let mut bots = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let last_activity_at = int_field(row, "lastActivityAt")
            .or_else(|| int_field(row, "localActivityAt"))
            .or_else(|| int_field(row, "updatedAt"));
        let unread_count = int_field(row, "unreadCount").unwrap_or(0);
        let last_preview = row
            .get("lastEntry")
            .and_then(|entry| entry.get("text"))
            .and_then(serde_json::Value::as_str)
            .and_then(preview_text);
        let has_unread = bool_field(row, "hasUnread") || unread_count > 0;
        let hidden =
            bool_field(row, "isHiddenFromSidebar") || bool_field(row, "isRemovedFromSidebar");
        bots.push(GrokBotBot {
            id: id.to_string(),
            name: string_field(row, "name").unwrap_or_default().to_string(),
            description: non_empty_string(row, "description"),
            title: non_empty_string(row, "title"),
            last_activity_at,
            last_preview,
            unread_count,
            has_unread,
            // Grok Bot stores what the bot is waiting on; null or false means nothing.
            awaiting_reply: row
                .get("awaitingUserResponse")
                .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false)),
            hidden,
            has_chat: false,
        });
    }
    bots.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok((schema_version, bots))
}

/// Parse one saved chat, applying the caller's filters and limit.
pub fn parse_chat(json: &str, bot_id: &str, options: &ReadOptions) -> Result<GrokBotChat, String> {
    let document =
        serde_json::from_str::<serde_json::Value>(json).map_err(|_| CHAT_FORMAT.to_string())?;
    if !document.is_object() {
        return Err(CHAT_FORMAT.to_string());
    }
    let schema_version = document
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let value = document
        .get("value")
        .filter(|value| value.is_object())
        .ok_or_else(|| CHAT_FORMAT.to_string())?;
    let persisted_at = value.get("persistedAt").and_then(serde_json::Value::as_i64);
    let raw_entries = value
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| CHAT_FORMAT.to_string())?;

    let mut entries = Vec::new();
    for (index, raw) in raw_entries.iter().enumerate() {
        if !raw.is_object() {
            continue;
        }
        let fallback_seq = i64::try_from(index).unwrap_or(i64::MAX);
        let kind = string_field(raw, "kind").unwrap_or_default();
        let (text, truncated) = clip_text(entry_text(kind, raw), options.max_chars);
        let streaming = kind == "message" && bool_field(raw, "isStreaming");
        let to_agent = if kind == "message" {
            raw.get("toAgent")
                .and_then(|agent| agent.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        } else {
            None
        };
        entries.push(GrokBotEntry {
            id: string_field(raw, "id").unwrap_or_default().to_string(),
            seq: int_field(raw, "seq").unwrap_or(fallback_seq),
            kind: kind.to_string(),
            role: if kind == "message" {
                string_field(raw, "role").map(str::to_string)
            } else {
                None
            },
            text,
            at: int_field(raw, "timestampMs"),
            streaming,
            to_agent,
            truncated,
        });
    }
    entries.sort_by_key(|entry| entry.seq);

    let mut filtered = Vec::new();
    for entry in entries {
        if let Some(since_ms) = options.since_ms {
            if entry.at.is_none_or(|at| at <= since_ms) {
                continue;
            }
        }
        if let Some(before_seq) = options.before_seq {
            if entry.seq >= before_seq {
                continue;
            }
        }
        filtered.push(entry);
    }
    let total = filtered.len();
    let keep_from = total.saturating_sub(options.limit);
    let entries = filtered.split_off(keep_from);
    Ok(GrokBotChat {
        bot_id: bot_id.to_string(),
        schema_version,
        persisted_at,
        total,
        more_before: total > entries.len(),
        entries,
    })
}

/// Read the newest account's roster from a cache folder.
pub fn load_roster(dir: &Path) -> Result<GrokBotRoster, String> {
    let scan = scan_cache(dir)?;
    let roster = newest_roster(&scan)?;
    if roster.size > MAX_FILE_BYTES {
        return Err(ROSTER_TOO_LARGE.to_string());
    }
    let (schema_version, mut bots) = read_twice(&roster.path, ROSTER_FORMAT, parse_roster)?;
    let chats: HashSet<String> = scan
        .transcripts
        .iter()
        .filter(|file| file.account == roster.account)
        .filter_map(|file| file.slice.strip_prefix(TRANSCRIPT_PREFIX))
        .map(str::to_string)
        .collect();
    for bot in &mut bots {
        bot.has_chat = chats.contains(&bot.id);
    }
    Ok(GrokBotRoster {
        schema_version,
        saved_at: roster.modified.as_ref().and_then(system_time_ms),
        bots,
    })
}

/// Read one bot's chat from the newest account's cache.
pub fn load_chat(dir: &Path, bot_id: &str, options: &ReadOptions) -> Result<GrokBotChat, String> {
    let scan = scan_cache(dir)?;
    let roster = newest_roster(&scan)?;
    let wanted = format!("{TRANSCRIPT_PREFIX}{bot_id}");
    let transcript = scan
        .transcripts
        .iter()
        .find(|file| file.account == roster.account && file.slice == wanted)
        .ok_or_else(|| NO_CHAT.to_string())?;
    if transcript.size > MAX_FILE_BYTES {
        return Err(CHAT_TOO_LARGE.to_string());
    }
    read_twice(&transcript.path, CHAT_FORMAT, |json| {
        parse_chat(json, bot_id, options)
    })
}

/// Grok Bot may be rewriting a file while we read it, so a file that won't
/// read or parse gets one more try a moment later.
fn read_twice<T>(
    path: &Path,
    unreadable: &str,
    parse: impl Fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    let attempt = || {
        std::fs::read_to_string(path)
            .map_err(|_| unreadable.to_string())
            .and_then(|json| parse(&json))
    };
    attempt().or_else(|_| {
        std::thread::sleep(std::time::Duration::from_millis(150));
        attempt()
    })
}

/// List the saved bots for the TS side.
#[tauri::command]
pub async fn fork_grok_bot_bots() -> Result<GrokBotRoster, String> {
    let home = home_folder()?;
    tauri::async_runtime::spawn_blocking(move || load_roster(&cache_dir(&home)))
        .await
        .map_err(|error| error.to_string())?
}

/// Read one saved chat for the TS side.
#[tauri::command]
pub async fn fork_grok_bot_chat(
    bot_id: String,
    limit: Option<u32>,
    since: Option<i64>,
    before: Option<i64>,
    max_chars: Option<u32>,
) -> Result<GrokBotChat, String> {
    if !valid_bot_id(&bot_id) {
        return Err(INVALID_BOT_ID.to_string());
    }
    let home = home_folder()?;
    let options = ReadOptions {
        limit: limit.unwrap_or(20).clamp(1, 200) as usize,
        since_ms: since,
        before_seq: before,
        max_chars: max_chars.unwrap_or(4000).clamp(200, 20_000) as usize,
    };
    tauri::async_runtime::spawn_blocking(move || load_chat(&cache_dir(&home), &bot_id, &options))
        .await
        .map_err(|error| error.to_string())?
}

struct CacheFile {
    account: String,
    slice: String,
    path: PathBuf,
    modified: Option<SystemTime>,
    size: u64,
}

struct CacheScan {
    rosters: Vec<CacheFile>,
    transcripts: Vec<CacheFile>,
}

fn scan_cache(dir: &Path) -> Result<CacheScan, String> {
    let entries = std::fs::read_dir(dir).map_err(|_| NO_DATA.to_string())?;
    let mut rosters = Vec::new();
    let mut transcripts = Vec::new();
    for entry in entries.flatten() {
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(key) = decode_blob_name(&file_name) else {
            continue;
        };
        let Some((account, slice)) = split_key(&key) else {
            continue;
        };
        let is_roster = slice == ROSTER_SLICE;
        let is_transcript = slice.starts_with(TRANSCRIPT_PREFIX);
        if !is_roster && !is_transcript {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let file = CacheFile {
            account,
            slice,
            path: entry.path(),
            modified: metadata.modified().ok(),
            size: metadata.len(),
        };
        if is_roster {
            rosters.push(file);
        } else {
            transcripts.push(file);
        }
    }
    Ok(CacheScan {
        rosters,
        transcripts,
    })
}

fn newest_roster(scan: &CacheScan) -> Result<&CacheFile, String> {
    scan.rosters
        .iter()
        .max_by(|a, b| {
            a.modified
                .cmp(&b.modified)
                .then_with(|| b.account.cmp(&a.account))
        })
        .ok_or_else(|| NO_DATA.to_string())
}

fn system_time_ms(time: &SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn home_folder() -> Result<String, String> {
    match crate::dirs_home() {
        Some(home) if !home.is_empty() => Ok(home),
        _ => Err(NO_HOME.to_string()),
    }
}

fn cache_dir(home: &str) -> PathBuf {
    PathBuf::from(home).join(CACHE_DIR)
}

fn valid_bot_id(bot_id: &str) -> bool {
    !bot_id.is_empty()
        && bot_id.len() <= 128
        && bot_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn string_field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(serde_json::Value::as_str)
}

fn non_empty_string(value: &serde_json::Value, key: &str) -> Option<String> {
    string_field(value, key)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn int_field(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(serde_json::Value::as_i64)
}

fn bool_field(value: &serde_json::Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn preview_text(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(200).collect())
}

fn entry_text(kind: &str, entry: &serde_json::Value) -> Option<String> {
    match kind {
        "message" => string_field(entry, "content").map(str::to_string),
        "send-message" => entry.get("message").and_then(send_message_text),
        "event" => entry.get("event").and_then(event_text),
        "notice" => string_field(entry, "text").map(str::to_string),
        "user-attachment" => string_field(entry, "file_name")
            .filter(|name| !name.is_empty())
            .map(|name| format!("Attachment: {name}")),
        _ => None,
    }
}

/// A bot's message to the user. Only text messages carry words; the rest get
/// a short label so a reader knows something was there.
fn send_message_text(message: &serde_json::Value) -> Option<String> {
    let named = |key: &str| non_empty_string(message, key);
    match string_field(message, "type").unwrap_or("text") {
        "text" => string_field(message, "content").map(str::to_string),
        "attachment" => Some(named("file_name").map_or_else(
            || "[attachment]".to_string(),
            |name| format!("[attachment: {name}]"),
        )),
        "cursor-agent" => Some(named("title").map_or_else(
            || "[Cursor agent]".to_string(),
            |title| format!("[Cursor agent: {title}]"),
        )),
        "connector" => Some(named("connector").map_or_else(
            || "[asks to connect an app]".to_string(),
            |name| format!("[asks to connect {name}]"),
        )),
        "user-form" => Some("[form for the user to fill in]".to_string()),
        "local-tool-permission" => {
            Some("[asks permission to run something on the Mac]".to_string())
        }
        "widget" => Some("[widget]".to_string()),
        other => Some(format!("[{other}]")),
    }
}

fn event_text(event: &serde_json::Value) -> Option<String> {
    let kind = string_field(event, "type").filter(|text| !text.is_empty());
    let action = string_field(event, "action").filter(|text| !text.is_empty());
    let name = string_field(event, "automationName").filter(|text| !text.is_empty());
    let mut head = String::new();
    if let Some(kind) = kind {
        head.push_str(kind);
    }
    if let Some(action) = action {
        if !head.is_empty() {
            head.push(' ');
        }
        head.push_str(action);
    }
    match (head.is_empty(), name) {
        (true, Some(name)) => Some(name.to_string()),
        (true, None) => None,
        (false, Some(name)) => Some(format!("{head}: {name}")),
        (false, None) => Some(head),
    }
}

fn clip_text(text: Option<String>, max_chars: usize) -> (Option<String>, bool) {
    let Some(text) = text else {
        return (None, false);
    };
    if text.is_empty() {
        return (None, false);
    }
    let count = text.chars().count();
    if count <= max_chars {
        return (Some(text), false);
    }
    if max_chars == 0 {
        return (None, true);
    }
    let mut clipped: String = text.chars().take(max_chars - 1).collect();
    clipped.push('…');
    (Some(clipped), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    fn base32_encode(text: &str) -> String {
        let mut encoded = String::new();
        let mut buffer = 0u32;
        let mut bits = 0u8;
        for byte in text.bytes() {
            buffer = (buffer << 8) | u32::from(byte);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                encoded.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
            }
        }
        if bits > 0 {
            encoded.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
        }
        encoded.to_ascii_lowercase()
    }

    fn temp_dir(name: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "monocode-grokbot-cache-{name}-{}-{id}",
            std::process::id()
        ));
        if dir.exists() {
            fs::remove_dir_all(&dir).unwrap();
        }
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn blob_file_name(key: &str) -> String {
        format!("{}.blob", base32_encode(key))
    }

    fn write_blob(dir: &Path, key: &str, json: &str) {
        fs::write(dir.join(blob_file_name(key)), json).unwrap();
    }

    fn options(limit: usize, max_chars: usize) -> ReadOptions {
        ReadOptions {
            limit,
            since_ms: None,
            before_seq: None,
            max_chars,
        }
    }

    #[test]
    fn decodes_blob_names_and_rejects_bad_ones() {
        let key = "sand.client.slice.account.github%7Cuser_ABC123.roster.last-roster";
        let name = blob_file_name(key);
        assert_eq!(decode_blob_name(&name), Some(key.to_string()));
        assert_eq!(decode_blob_name("not-a-blob"), None);
        assert_eq!(decode_blob_name("!!!!.blob"), None);
        assert_eq!(decode_blob_name(".blob"), None);
    }

    #[test]
    fn splits_keys_only_after_the_account_prefix() {
        assert_eq!(
            split_key("sand.client.slice.account.github%7Cuser.transcript.replicas.bot-1"),
            Some((
                "github%7Cuser".to_string(),
                "transcript.replicas.bot-1".to_string()
            ))
        );
        assert_eq!(split_key("other.account.github.transcript"), None);
        assert_eq!(
            split_key("sand.client.slice.account..roster.last-roster"),
            None
        );
        assert_eq!(split_key("sand.client.slice.account.account"), None);
        assert_eq!(
            split_key("sand.client.slice.account.sam.l%40x.com.roster.last-roster"),
            Some((
                "sam.l%40x.com".to_string(),
                "roster.last-roster".to_string()
            ))
        );
        assert_eq!(
            split_key("sand.client.slice.account.a.b.transcript.replicas.bot-1"),
            Some(("a.b".to_string(), "transcript.replicas.bot-1".to_string()))
        );
        assert_eq!(
            split_key("sand.client.slice.account..transcript.replicas.x"),
            None
        );
    }

    #[test]
    fn parses_roster_fields_fallbacks_and_order() {
        let json = r#"{
            "schemaVersion": 4,
            "value": {"rows": [
                {"id": "old", "name": "Old", "localActivityAt": 10, "updatedAt": 99,
                 "lastEntry": {"text": "  hello\n there  "},
                 "unreadCount": 2, "hasUnread": false,
                 "isRemovedFromSidebar": true},
                {"id": "new", "name": "New", "lastActivityAt": 30, "updatedAt": 1,
                 "description": "", "title": "Title",
                 "awaitingUserResponse": false},
                {"id": "fallback", "name": "Fallback", "updatedAt": 20},
                {"id": "none", "name": "None"},
                {"name": "No id"},
                {"id": "wrong", "name": 42, "lastActivityAt": "30",
                 "localActivityAt": true, "updatedAt": 5,
                 "description": 7, "title": {},
                 "unreadCount": "3", "hasUnread": "yes",
                 "awaitingUserResponse": null}
            ]}
        }"#;
        let (schema, bots) = parse_roster(json).unwrap();
        assert_eq!(schema, 4);
        assert_eq!(
            bots.iter().map(|bot| bot.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "fallback", "old", "wrong", "none"]
        );
        assert_eq!(bots[0].description, None);
        assert_eq!(bots[0].title.as_deref(), Some("Title"));
        assert!(!bots[0].awaiting_reply);
        assert_eq!(bots[1].last_activity_at, Some(20));
        assert_eq!(bots[2].last_preview.as_deref(), Some("hello there"));
        assert_eq!(bots[2].unread_count, 2);
        assert!(bots[2].has_unread);
        assert!(bots[2].hidden);
        assert_eq!(bots[3].name, "");
        assert_eq!(bots[3].last_activity_at, Some(5));
        assert_eq!(bots[3].unread_count, 0);
        assert!(!bots[3].has_unread);
        assert!(!bots[3].awaiting_reply);
        assert_eq!(bots[4].last_activity_at, None);

        let long = "x".repeat(205);
        let json = format!(
            r#"{{"value":{{"rows":[{{"id":"long","name":"Long","lastEntry":{{"text":"{long}"}}}}]}}}}"#
        );
        let (_, bots) = parse_roster(&json).unwrap();
        assert_eq!(bots[0].last_preview.as_ref().unwrap().chars().count(), 200);

        let awaiting = r#"{"value":{"rows":[{"id":"waiting","awaitingUserResponse":0}]}}"#;
        let (_, bots) = parse_roster(awaiting).unwrap();
        assert!(bots[0].awaiting_reply);

        assert_eq!(parse_roster("[]"), Err(ROSTER_FORMAT.to_string()));
        assert_eq!(
            parse_roster(r#"{"value":{"rows":{}}}"#),
            Err(ROSTER_FORMAT.to_string())
        );
    }

    #[test]
    fn parses_chat_texts_sorting_filters_and_limits() {
        let json = format!(
            r#"{{"schemaVersion":1,"value":{{"persistedAt":500,"entries":[
                {{"id":"m","kind":"message","seq":9,"timestampMs":60,
                 "role":"assistant","content":"hi","isStreaming":true,
                 "toAgent":{{"id":"a","name":"Helper","kind":"agent"}}}},
                {{"id":"s","kind":"send-message","seq":3,"timestampMs":10,
                 "message":{{"type":"text","content":"sent"}}}},
                {{"id":"e","kind":"event","seq":4,"timestampMs":20,
                 "event":{{"type":"automation","action":"created","automationId":"x","automationName":"Daily digest"}}}},
                {{"id":"e2","kind":"event","seq":5,"timestampMs":30,
                 "event":{{"type":"automation"}}}},
                {{"id":"n","kind":"notice","seq":6,"timestampMs":40,"text":"note"}},
                {{"id":"a","kind":"user-attachment","seq":7,"timestampMs":50,"file_name":"photo.png"}},
                {{"id":"u","kind":"mystery","seq":8,"timestampMs":55,"text":"ignored"}}
            ]}}}}"#
        );
        let chat = parse_chat(&json, "bot-1", &options(20, 4000)).unwrap();
        assert_eq!(chat.bot_id, "bot-1");
        assert_eq!(chat.schema_version, 1);
        assert_eq!(chat.persisted_at, Some(500));
        assert_eq!(chat.total, 7);
        assert!(!chat.more_before);
        assert_eq!(
            chat.entries
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            vec![3, 4, 5, 6, 7, 8, 9]
        );
        assert_eq!(chat.entries[0].text.as_deref(), Some("sent"));
        assert_eq!(
            chat.entries[1].text.as_deref(),
            Some("automation created: Daily digest")
        );
        assert_eq!(chat.entries[2].text.as_deref(), Some("automation"));
        assert_eq!(chat.entries[3].text.as_deref(), Some("note"));
        assert_eq!(
            chat.entries[4].text.as_deref(),
            Some("Attachment: photo.png")
        );
        assert_eq!(chat.entries[5].kind, "mystery");
        assert_eq!(chat.entries[5].text, None);
        assert_eq!(chat.entries[6].role.as_deref(), Some("assistant"));
        assert!(chat.entries[6].streaming);
        assert_eq!(chat.entries[6].to_agent.as_deref(), Some("Helper"));
        assert_eq!(chat.entries[6].at, Some(60));

        let before = ReadOptions {
            limit: 20,
            since_ms: Some(20),
            before_seq: Some(8),
            max_chars: 4000,
        };
        let chat = parse_chat(&json, "bot-1", &before).unwrap();
        assert_eq!(
            chat.entries
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            vec![5, 6, 7]
        );
        assert_eq!(chat.total, 3);
        assert!(!chat.more_before);

        let limited = ReadOptions {
            limit: 2,
            since_ms: None,
            before_seq: None,
            max_chars: 4000,
        };
        let chat = parse_chat(&json, "bot-1", &limited).unwrap();
        assert_eq!(chat.total, 7);
        assert!(chat.more_before);
        assert_eq!(
            chat.entries
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            vec![8, 9]
        );
    }

    #[test]
    fn falls_back_to_array_indexes_and_clips_emoji() {
        let json = r#"{"value":{"entries":[
            {"id":"a","kind":"notice","text":"abcdef"},
            {"id":"b","kind":"message","role":"user","content":"😀😀😀😀😀"},
            {"id":"c","kind":"event","event":{"type":"x","automationName":"Y"}}
        ]}}"#;
        let options = ReadOptions {
            limit: 10,
            since_ms: None,
            before_seq: None,
            max_chars: 4,
        };
        let chat = parse_chat(json, "bot", &options).unwrap();
        assert_eq!(
            chat.entries
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(chat.entries[0].text.as_deref(), Some("abc…"));
        assert!(chat.entries[0].truncated);
        assert_eq!(chat.entries[1].text.as_deref(), Some("😀😀😀…"));
        assert_eq!(chat.entries[2].text.as_deref(), Some("x: Y"));
        assert_eq!(
            parse_chat("[]", "bot", &options),
            Err(CHAT_FORMAT.to_string())
        );
        assert_eq!(
            parse_chat(r#"{"value":{"entries":{}}}"#, "bot", &options),
            Err(CHAT_FORMAT.to_string())
        );
    }

    #[test]
    fn loads_the_newest_account_and_marks_chats() {
        let dir = temp_dir("load");
        let old_key = "sand.client.slice.account.github%7Cold.roster.last-roster";
        let new_key = "sand.client.slice.account.github%7Cnew.roster.last-roster";
        write_blob(
            &dir,
            old_key,
            r#"{"schemaVersion":4,"value":{"rows":[{"id":"old-bot","name":"Old"}]}}"#,
        );
        std::thread::sleep(Duration::from_millis(20));
        write_blob(
            &dir,
            new_key,
            r#"{"schemaVersion":4,"value":{"rows":[
                {"id":"with-chat","name":"With"},
                {"id":"without-chat","name":"Without"}
            ]}}"#,
        );
        write_blob(
            &dir,
            "sand.client.slice.account.github%7Cnew.transcript.replicas.with-chat",
            r#"{"schemaVersion":1,"value":{"entries":[{"id":"m","kind":"notice","text":"hello"}]}}"#,
        );
        write_blob(
            &dir,
            "sand.client.slice.account.github%7Cold.transcript.replicas.old-bot",
            r#"{"schemaVersion":1,"value":{"entries":[]}}"#,
        );
        fs::write(dir.join("not-base32.blob"), "{}").unwrap();
        fs::write(dir.join("ignored.txt"), "{}").unwrap();

        let roster = load_roster(&dir).unwrap();
        assert_eq!(
            roster
                .bots
                .iter()
                .map(|bot| bot.id.as_str())
                .collect::<Vec<_>>(),
            vec!["with-chat", "without-chat"]
        );
        assert!(roster.bots[0].has_chat);
        assert!(!roster.bots[1].has_chat);
        assert!(roster.saved_at.is_some());

        let chat = load_chat(&dir, "with-chat", &options(20, 4000)).unwrap();
        assert_eq!(chat.entries.len(), 1);
        assert_eq!(chat.entries[0].text.as_deref(), Some("hello"));
        assert_eq!(
            load_chat(&dir, "without-chat", &options(20, 4000)),
            Err(NO_CHAT.to_string())
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_folder_has_no_saved_data() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-grokbot-cache-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert_eq!(load_roster(&dir), Err(NO_DATA.to_string()));
    }

    #[test]
    fn labels_bot_messages_that_are_not_text() {
        let json = r#"{"schemaVersion":1,"value":{"entries":[
            {"id":"a","kind":"send-message","seq":1,"message":{"type":"text","content":"hi"}},
            {"id":"b","kind":"send-message","seq":2,"message":{"type":"attachment","file_name":"a.pdf","url":"x"}},
            {"id":"c","kind":"send-message","seq":3,"message":{"type":"widget","widget":{}}},
            {"id":"d","kind":"send-message","seq":4,"message":{"type":"connector","connector":"Gmail"}},
            {"id":"e","kind":"send-message","seq":5,"message":{"type":"local-tool-permission","ask":{}}},
            {"id":"f","kind":"send-message","seq":6,"message":{"type":"brand-new"}},
            {"id":"g","kind":"send-message","seq":7,"message":{"content":"no type"}}
        ]}}"#;
        let options = ReadOptions {
            limit: 20,
            since_ms: None,
            before_seq: None,
            max_chars: 4000,
        };
        let chat = parse_chat(json, "bot", &options).unwrap();
        let texts: Vec<_> = chat
            .entries
            .iter()
            .map(|entry| entry.text.as_deref())
            .collect();
        assert_eq!(
            texts,
            vec![
                Some("hi"),
                Some("[attachment: a.pdf]"),
                Some("[widget]"),
                Some("[asks to connect Gmail]"),
                Some("[asks permission to run something on the Mac]"),
                Some("[brand-new]"),
                Some("no type"),
            ]
        );
    }
}
