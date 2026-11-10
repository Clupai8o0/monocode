//! Fork feature: start a Grok Bot routine by POSTing to its webhook.
//!
//! The webhook URL and key stay in the system keychain and never reach the
//! webview. Grok Bot itself need not be installed: routines run in the cloud.

use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "MonoCode Grok Bot webhooks";
const KEYCHAIN_USER: &str = "webhooks";

const UNREADABLE: &str = "MonoCode could not read the saved Grok Bot webhooks from the keychain, so it won't change them. Restart MonoCode and allow keychain access.";
const URL_ERROR: &str = "Paste the routine's \"POST to\" address: an https:// link.";
const KEY_ERROR: &str =
    "That key doesn't look right: paste the routine's key or its Authorization header.";
const BOT_ID_ERROR: &str = "That is not a Grok Bot bot id.";
const REQUEST_ID_ERROR: &str = "requestId must be 1-64 letters, digits, - or _.";
const TEXT_ERROR: &str = "text must be 1 to 20000 characters.";
const NO_HOOK: &str = "No webhook is set up for this bot.";
const UNREACHABLE: &str = "Could not reach Grok Bot, so no run started. Check the connection.";
const UNKNOWN_DETAIL: &str =
    "The request went out but no answer came back, so the run may or may not have started.";

const MAX_URL_BYTES: usize = 2048;
const MAX_KEY_BYTES: usize = 4096;
const MIN_KEY_BYTES: usize = 8;
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_SNIPPET_BYTES: u64 = 2048;
const MAX_SNIPPET_CHARS: usize = 200;
const MIN_GAP_MS: u64 = 10_000;
const HOUR_MS: u64 = 3_600_000;
const MAX_RUNS_PER_HOUR: usize = 30;

/// What the settings list may see. The key and the full URL stay in Rust.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookInfo {
    bot_id: String,
    host: String,
    added_at: i64,
    last_run_at: Option<i64>,
}

/// The result of a run attempt. "unknown" means the request may have landed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    outcome: &'static str,
    status: Option<u16>,
    detail: Option<String>,
}

/// One bot's saved webhook. `last_run_at` lives in memory only.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hook {
    url: String,
    key: String,
    added_at: i64,
    #[serde(skip)]
    last_run_at: Option<i64>,
}

/// The keychain's JSON. Pure store methods never touch the keychain.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    bots: BTreeMap<String, Hook>,
}

impl Store {
    fn set(&mut self, bot_id: &str, url: String, key: String, added_at: i64) {
        self.bots.insert(
            bot_id.to_string(),
            Hook {
                url,
                key,
                added_at,
                last_run_at: None,
            },
        );
    }

    fn remove(&mut self, bot_id: &str) {
        self.bots.remove(bot_id);
    }

    fn infos(&self) -> Vec<WebhookInfo> {
        self.bots
            .iter()
            .map(|(bot_id, hook)| WebhookInfo {
                bot_id: bot_id.clone(),
                host: host_only(&hook.url),
                added_at: hook.added_at,
                last_run_at: hook.last_run_at,
            })
            .collect()
    }

    fn info(&self, bot_id: &str) -> Option<WebhookInfo> {
        self.bots.get(bot_id).map(|hook| WebhookInfo {
            bot_id: bot_id.to_string(),
            host: host_only(&hook.url),
            added_at: hook.added_at,
            last_run_at: hook.last_run_at,
        })
    }

    fn hook(&self, bot_id: &str) -> Option<&Hook> {
        self.bots.get(bot_id)
    }

    fn note_run(&mut self, bot_id: &str, at: i64) {
        if let Some(hook) = self.bots.get_mut(bot_id) {
            hook.last_run_at = Some(at);
        }
    }
}

enum State {
    Loaded(Store),
    Unreadable,
}

/// The keychain's answer for this launch. Outer `None`: not read yet.
static STORE_MEMORY: Mutex<Option<State>> = Mutex::new(None);

/// The rate guard, per bot and across all bots.
#[derive(Default)]
struct RunLog {
    runs: VecDeque<(u64, String)>,
}

impl RunLog {
    fn check(&self, bot: &str, now_ms: u64) -> Result<(), String> {
        if let Some(last) = self
            .runs
            .iter()
            .filter(|(_, ran)| ran == bot)
            .map(|(at, _)| *at)
            .max()
        {
            let elapsed = now_ms.saturating_sub(last);
            if elapsed < MIN_GAP_MS {
                let wait = (MIN_GAP_MS - elapsed).div_ceil(1_000);
                return Err(format!("Wait {wait} s before running this bot again."));
            }
        }
        let cutoff = now_ms.saturating_sub(HOUR_MS);
        let mut recent = 0;
        let mut oldest = now_ms;
        for (at, _) in &self.runs {
            if *at > cutoff {
                recent += 1;
                oldest = oldest.min(*at);
            }
        }
        if recent >= MAX_RUNS_PER_HOUR {
            let wait = oldest.saturating_add(HOUR_MS).saturating_sub(now_ms).max(1);
            let minutes = wait.div_ceil(60_000).max(1);
            return Err(format!(
                "MonoCode allows 30 Grok Bot runs an hour. Try again in {minutes} min."
            ));
        }
        Ok(())
    }

    fn record(&mut self, bot: &str, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(HOUR_MS);
        self.runs.retain(|(at, _)| *at > cutoff);
        self.runs.push_back((now_ms, bot.to_string()));
    }
}

static RUN_LOG: Mutex<RunLog> = Mutex::new(RunLog {
    runs: VecDeque::new(),
});

/// List the saved webhooks for the TS side.
#[tauri::command]
pub async fn fork_grok_bot_webhooks() -> Result<Vec<WebhookInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_infos)
        .await
        .map_err(|error| error.to_string())?
}

/// Save, or replace, one bot's webhook.
#[tauri::command]
pub async fn fork_grok_bot_webhook_set(
    bot_id: String,
    url: String,
    key: String,
) -> Result<WebhookInfo, String> {
    tauri::async_runtime::spawn_blocking(move || save_hook(&bot_id, &url, &key))
        .await
        .map_err(|error| error.to_string())?
}

/// Forget one bot's webhook. A missing bot is not an error.
#[tauri::command]
pub async fn fork_grok_bot_webhook_remove(bot_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_hook(&bot_id))
        .await
        .map_err(|error| error.to_string())?
}

/// Start one bot's routine through its saved webhook.
#[tauri::command]
pub async fn fork_grok_bot_run(
    bot_id: String,
    text: String,
    request_id: String,
    cwd: String,
) -> Result<RunOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || run_bot(&bot_id, &text, &request_id, &cwd))
        .await
        .map_err(|error| error.to_string())?
}

fn store_memory() -> MutexGuard<'static, Option<State>> {
    STORE_MEMORY
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn run_log() -> MutexGuard<'static, RunLog> {
    RUN_LOG.lock().unwrap_or_else(|error| error.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn host_only(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return String::new();
    };
    parsed.host_str().unwrap_or_default().to_string()
}

/// Reads the one keychain item, once per launch.
fn read_state() -> State {
    let text = match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .and_then(|entry| entry.get_password())
    {
        Ok(text) => text,
        Err(keyring::Error::NoEntry) => return State::Loaded(Store::default()),
        Err(_) => return State::Unreadable,
    };
    match serde_json::from_str(&text) {
        Ok(store) => State::Loaded(store),
        Err(_) => State::Unreadable,
    }
}

fn write_keychain(text: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .and_then(|entry| entry.set_password(text))
        .map_err(|_| "Could not save the Grok Bot webhook to the keychain.".to_string())
}

fn clear_keychain() -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .and_then(|entry| entry.delete_credential())
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the Grok Bot webhooks from the keychain.".to_string()),
    }
}

fn list_infos() -> Result<Vec<WebhookInfo>, String> {
    let mut memory = store_memory();
    match memory.get_or_insert_with(read_state) {
        State::Loaded(store) => Ok(store.infos()),
        State::Unreadable => Err(UNREADABLE.to_string()),
    }
}

fn save_hook(bot_id: &str, url: &str, key: &str) -> Result<WebhookInfo, String> {
    if !crate::fork_grok_bot::valid_bot_id(bot_id) {
        return Err(BOT_ID_ERROR.to_string());
    }
    let url = clean_url(url)?;
    let key = clean_key(key)?;
    let added_at = now_ms() as i64;
    let mut memory = store_memory();
    let store = match memory.get_or_insert_with(read_state) {
        State::Loaded(store) => store,
        State::Unreadable => return Err(UNREADABLE.to_string()),
    };
    // Keep memory unchanged until the keychain write has succeeded.
    let mut next = store.clone();
    next.set(bot_id, url, key, added_at);
    let info = next
        .info(bot_id)
        .ok_or_else(|| "Could not save the Grok Bot webhook to the keychain.".to_string())?;
    let text = serde_json::to_string(&next)
        .map_err(|_| "Could not save the Grok Bot webhook to the keychain.".to_string())?;
    write_keychain(&text)?;
    *store = next;
    Ok(info)
}

fn remove_hook(bot_id: &str) -> Result<(), String> {
    let mut memory = store_memory();
    let store = match memory.get_or_insert_with(read_state) {
        State::Loaded(store) => store,
        State::Unreadable => return Err(UNREADABLE.to_string()),
    };
    if store.hook(bot_id).is_none() {
        return Ok(());
    }
    let mut next = store.clone();
    next.remove(bot_id);
    if next.bots.is_empty() {
        clear_keychain()?;
    } else {
        let text = serde_json::to_string(&next)
            .map_err(|_| "Could not save the Grok Bot webhook to the keychain.".to_string())?;
        write_keychain(&text)?;
    }
    *store = next;
    Ok(())
}

fn hook_for(bot_id: &str) -> Result<(String, String), String> {
    let mut memory = store_memory();
    match memory.get_or_insert_with(read_state) {
        State::Loaded(store) => store
            .hook(bot_id)
            .map(|hook| (hook.url.clone(), hook.key.clone()))
            .ok_or_else(|| NO_HOOK.to_string()),
        State::Unreadable => Err(UNREADABLE.to_string()),
    }
}

fn note_run(bot_id: &str, at: i64) {
    let mut memory = store_memory();
    if let Some(State::Loaded(store)) = memory.as_mut() {
        store.note_run(bot_id, at);
    }
}

fn run_bot(bot_id: &str, text: &str, request_id: &str, cwd: &str) -> Result<RunOutcome, String> {
    if !crate::fork_grok_bot::valid_bot_id(bot_id) {
        return Err(BOT_ID_ERROR.to_string());
    }
    if !valid_request_id(request_id) {
        return Err(REQUEST_ID_ERROR.to_string());
    }
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err(TEXT_ERROR.to_string());
    }
    let (policy, allowed) = crate::fork_grok_bot::folder_policy(Some(cwd));
    if !allowed {
        return Err(format!(
            "Grok Bot is off for this folder: its privacy policy is {policy}."
        ));
    }
    let (url, key) = hook_for(bot_id)?;
    let now = now_ms();
    {
        let mut log = run_log();
        log.check(bot_id, now)?;
        log.record(bot_id, now);
    }
    let outcome = send(&url, &key, &body_json(text, request_id))?;
    note_run(bot_id, now_ms() as i64);
    Ok(outcome)
}

fn valid_request_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Trims and checks a routine's "POST to" URL, never keeping credentials or a
/// fragment. Loopback HTTP is allowed only in tests.
fn clean_url(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.len() > MAX_URL_BYTES {
        return Err(URL_ERROR.to_string());
    }
    let parsed = url::Url::parse(text).map_err(|_| URL_ERROR.to_string())?;
    let loopback_http =
        cfg!(test) && parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1");
    if parsed.scheme() != "https" && !loopback_http {
        return Err(URL_ERROR.to_string());
    }
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(URL_ERROR.to_string());
    }
    Ok(parsed.to_string())
}

/// Accepts a bare key, `Bearer <key>` or the whole `Authorization` header.
fn clean_key(raw: &str) -> Result<String, String> {
    let mut text = raw.trim();
    if text
        .get(..14)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("authorization:"))
    {
        text = text[14..].trim_start_matches(' ');
    }
    if text
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer"))
        && text.as_bytes().get(6) == Some(&b' ')
    {
        text = text[6..].trim_start_matches(' ');
    }
    text = text.trim();
    if text.len() < MIN_KEY_BYTES
        || text.len() > MAX_KEY_BYTES
        || !text.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(KEY_ERROR.to_string());
    }
    Ok(text.to_string())
}

fn body_json(text: &str, request_id: &str) -> String {
    serde_json::json!({
        "task": text,
        "requestId": request_id,
        "from": "MonoCode",
    })
    .to_string()
}

fn send(url: &str, key: &str, body: &str) -> Result<RunOutcome, String> {
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build();
    let response = agent
        .post(url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .set("User-Agent", "MonoCode")
        .send_string(body);
    match response {
        Ok(response) => {
            let status = response.status();
            if (200..=299).contains(&status) {
                Ok(RunOutcome {
                    outcome: "started",
                    status: Some(status),
                    detail: None,
                })
            } else {
                Err(format!(
                    "Grok Bot answered HTTP {status}, so no run started."
                ))
            }
        }
        Err(ureq::Error::Status(code, response)) => {
            Err(status_message(code, &read_snippet(response, key)))
        }
        Err(ureq::Error::Transport(error)) => match error.kind() {
            ureq::ErrorKind::Dns
            | ureq::ErrorKind::ConnectionFailed
            | ureq::ErrorKind::InvalidUrl
            | ureq::ErrorKind::UnknownScheme
            | ureq::ErrorKind::InsecureRequestHttpsOnly
            | ureq::ErrorKind::InvalidProxyUrl
            | ureq::ErrorKind::ProxyConnect
            | ureq::ErrorKind::ProxyUnauthorized => Err(UNREACHABLE.to_string()),
            _ => Ok(RunOutcome {
                outcome: "unknown",
                status: None,
                detail: Some(UNKNOWN_DETAIL.to_string()),
            }),
        },
    }
}

fn status_message(code: u16, snippet: &str) -> String {
    let mut message = match code {
        401 | 403 => format!(
            "Grok Bot refused the webhook key (HTTP {code}), so no run started. The routine may have a new key: paste it again in MonoCode Settings > Connections."
        ),
        404 | 410 => format!(
            "No webhook routine at that address (HTTP {code}), so no run started. It may be deleted or paused."
        ),
        429 => {
            "Grok Bot's run limit was hit (HTTP 429), so no run started. Try again later.".to_string()
        }
        _ => format!("Grok Bot answered HTTP {code}, so no run started."),
    };
    if !snippet.is_empty() {
        message.push_str(&format!(" Grok Bot said: \"{snippet}\""));
    }
    message
}

/// At most 2048 body bytes, the key masked, whitespace and controls folded.
fn read_snippet(response: ureq::Response, key: &str) -> String {
    let mut bytes = Vec::new();
    let _ = response
        .into_reader()
        .take(MAX_SNIPPET_BYTES)
        .read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    let replaced = if key.is_empty() {
        text.into_owned()
    } else {
        text.replace(key, "[key]")
    };
    let mut folded = String::new();
    let mut spaced = false;
    for c in replaced.chars() {
        if c.is_whitespace() || c.is_control() {
            if !spaced {
                folded.push(' ');
                spaced = true;
            }
        } else {
            folded.push(c);
            spaced = false;
        }
    }
    folded.trim().chars().take(MAX_SNIPPET_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    use super::*;

    fn answer(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn serve(response: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap_or(0);
                }
                request.push_str(&line);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            request.push_str(&String::from_utf8_lossy(&body));
            let _ = stream.write_all(response.as_bytes());
            request
        });
        (url, worker)
    }

    #[test]
    fn clean_url_accepts_https_and_test_loopback() {
        assert_eq!(
            clean_url(" https://example.com/hook?x=1 ").unwrap(),
            "https://example.com/hook?x=1"
        );
        assert_eq!(
            clean_url("http://127.0.0.1:8765/hook").unwrap(),
            "http://127.0.0.1:8765/hook"
        );
    }

    #[test]
    fn clean_url_rejects_unsafe_or_unusable_links() {
        for raw in [
            "http://example.com/hook",
            "ftp://example.com/hook",
            "https://",
            "https://user:pass@example.com/hook",
            "https://example.com/hook#fragment",
            "not a url",
            "http://127.0.0.1.example.com/hook",
        ] {
            assert_eq!(clean_url(raw).unwrap_err(), URL_ERROR, "{raw}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(clean_url(&long).unwrap_err(), URL_ERROR);
    }

    #[test]
    fn clean_key_accepts_bare_bearer_and_header_forms() {
        assert_eq!(clean_key("abc12345").unwrap(), "abc12345");
        assert_eq!(clean_key("Bearer abc12345").unwrap(), "abc12345");
        assert_eq!(
            clean_key("Authorization: Bearer abc12345").unwrap(),
            "abc12345"
        );
        assert_eq!(
            clean_key("AUTHORIZATION:    bearer    abc12345   ").unwrap(),
            "abc12345"
        );
        assert_eq!(
            clean_key("authorization:bearer abc12345").unwrap(),
            "abc12345"
        );
    }

    #[test]
    fn clean_key_rejects_spaces_controls_and_short_values() {
        for raw in ["short", "abc 12345", "abc12\n345", "abc1234\u{7}5"] {
            assert_eq!(clean_key(raw).unwrap_err(), KEY_ERROR, "{raw}");
        }
    }

    #[test]
    fn body_json_has_exactly_the_three_fields() {
        let value: serde_json::Value =
            serde_json::from_str(&body_json("do the thing", "req-1")).unwrap();
        assert_eq!(value["task"], "do the thing");
        assert_eq!(value["requestId"], "req-1");
        assert_eq!(value["from"], "MonoCode");
        assert_eq!(value.as_object().unwrap().len(), 3);
    }

    #[test]
    fn store_sets_replaces_lists_and_removes() {
        let mut store = Store::default();
        assert!(store.infos().is_empty());
        store.set(
            "b-bot",
            "https://b.example/hook".to_string(),
            "b-secret-key".to_string(),
            1_000,
        );
        store.set(
            "a-bot",
            "https://a.example/private/path".to_string(),
            "a-secret-key".to_string(),
            2_000,
        );
        let infos = store.infos();
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].bot_id, "a-bot");
        assert_eq!(infos[0].host, "a.example");
        assert_eq!(infos[0].added_at, 2_000);
        assert!(infos[0].last_run_at.is_none());
        let json = serde_json::to_string(&infos).unwrap();
        assert!(!json.contains("secret-key"));
        assert!(!json.contains("/private/path"));
        assert!(!json.contains("https://"));
        assert!(json.contains("\"host\":\"a.example\""));

        store.set(
            "a-bot",
            "https://new.example/other".to_string(),
            "new-secret-key".to_string(),
            3_000,
        );
        assert_eq!(store.infos().len(), 2);
        assert_eq!(store.infos()[0].host, "new.example");
        assert_eq!(store.infos()[0].added_at, 3_000);

        store.note_run("a-bot", 4_000);
        assert_eq!(store.infos()[0].last_run_at, Some(4_000));
        assert!(!serde_json::to_string(&store).unwrap().contains("lastRunAt"));

        store.remove("a-bot");
        store.remove("missing");
        assert_eq!(store.infos().len(), 1);
        assert_eq!(store.infos()[0].bot_id, "b-bot");
    }

    #[test]
    fn store_reads_the_camel_case_keychain_shape() {
        let store: Store = serde_json::from_str(
            r#"{"bots":{"bot-1":{"url":"https://example.com/hook","key":"abcdefgh","addedAt":7}}}"#,
        )
        .unwrap();
        let infos = store.infos();
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].bot_id, "bot-1");
        assert_eq!(infos[0].host, "example.com");
        assert_eq!(infos[0].added_at, 7);
        assert_eq!(infos[0].last_run_at, None);
    }

    #[test]
    fn run_log_enforces_the_per_bot_gap() {
        let mut log = RunLog::default();
        log.check("a", 10_000).unwrap();
        log.record("a", 10_000);
        assert_eq!(
            log.check("a", 10_500).unwrap_err(),
            "Wait 10 s before running this bot again."
        );
        assert_eq!(
            log.check("a", 19_001).unwrap_err(),
            "Wait 1 s before running this bot again."
        );
        log.check("a", 20_000).unwrap();
        log.check("b", 10_500).unwrap();
    }

    #[test]
    fn run_log_allows_only_thirty_runs_an_hour() {
        let mut log = RunLog::default();
        for i in 0..MAX_RUNS_PER_HOUR {
            let bot = format!("bot-{i}");
            log.check(&bot, 1_000).unwrap();
            log.record(&bot, 1_000);
        }
        assert_eq!(
            log.check("extra", 1_000).unwrap_err(),
            "MonoCode allows 30 Grok Bot runs an hour. Try again in 60 min."
        );
        log.check("extra", 1_000 + HOUR_MS).unwrap();
    }

    #[test]
    fn run_log_prunes_old_entries() {
        let mut log = RunLog::default();
        for i in 0..MAX_RUNS_PER_HOUR {
            log.record(&format!("bot-{i}"), 1_000);
        }
        assert_eq!(log.runs.len(), MAX_RUNS_PER_HOUR);
        log.record("new-bot", 1_000 + HOUR_MS + 1);
        assert_eq!(log.runs.len(), 1);
        assert_eq!(log.runs[0], (1_000 + HOUR_MS + 1, "new-bot".to_string()));
        log.check("new-bot", 1_000 + HOUR_MS + 10_001).unwrap();
    }

    #[test]
    fn send_reports_started_and_sends_the_expected_request() {
        let key = "sk-test-key";
        let (url, worker) = serve(answer("200 OK", "", ""));
        let outcome = send(&url, key, &body_json("hello", "req-1")).unwrap();
        assert_eq!(outcome.outcome, "started");
        assert_eq!(outcome.status, Some(200));
        assert_eq!(outcome.detail, None);
        let request = worker.join().unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer sk-test-key"));
        assert!(lower.contains("content-type: application/json"));
        assert!(lower.contains("user-agent: monocode"));
        assert!(request.contains("\"task\":\"hello\""));
        assert!(request.contains("\"requestId\":\"req-1\""));
    }

    #[test]
    fn send_masks_the_key_in_an_error_body() {
        let key = "sk-secret-key";
        let body = format!("the key {key} was rejected");
        let (url, worker) = serve(answer("401 Unauthorized", "", &body));
        let error = send(&url, key, "{}").unwrap_err();
        assert!(error.to_ascii_lowercase().contains("refused"));
        assert!(error.contains("[key]"));
        assert!(!error.contains(key));
        worker.join().unwrap();
    }

    #[test]
    fn send_does_not_follow_redirects() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let location = format!(
            "Location: http://{}/second\r\n",
            target.local_addr().unwrap()
        );
        let (url, worker) = serve(answer("302 Found", &location, "moved"));
        let error = send(&url, "sk-test-key", "{}").unwrap_err();
        assert_eq!(error, "Grok Bot answered HTTP 302, so no run started.");
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        worker.join().unwrap();
    }

    #[test]
    fn send_reports_unknown_when_the_connection_closes() {
        let (url, worker) = serve(String::new());
        let outcome = send(&url, "sk-test-key", "{}").unwrap();
        assert_eq!(outcome.outcome, "unknown");
        assert_eq!(outcome.status, None);
        assert!(outcome.detail.unwrap().contains("may or may not"));
        worker.join().unwrap();
    }

    #[test]
    fn send_reports_unreachable_when_nothing_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("http://{address}/hook");
        assert_eq!(
            send(&url, "sk-test-key", "{}").unwrap_err(),
            "Could not reach Grok Bot, so no run started. Check the connection."
        );
    }
}
