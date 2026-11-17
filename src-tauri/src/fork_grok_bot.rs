//! Fork feature: hand a task to the Grok Bot desktop app through its URL scheme.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::dirs_home;

const POLICY_FILE: &str =
    "Documents/Obsidian/brain/30-resources/_meta/claude-shared/model-policy.json";
/// Grok Bot measures prompt length as a JavaScript string (UTF-16 units).
const MAX_PROMPT_CHARS: usize = 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokBotStatus {
    installed: bool,
    allowed: bool,
    /// Policy name that matched: "personal", "open", "confidential", or "none" when no policy file exists.
    policy: String,
}

#[derive(Debug, Deserialize)]
struct PolicyFile {
    default: Option<String>,
    #[serde(default)]
    routes: HashMap<String, Vec<String>>,
    #[serde(default)]
    rules: Vec<PolicyRule>,
}

#[derive(Debug, Deserialize)]
struct PolicyRule {
    path: String,
    policy: String,
}

#[tauri::command]
pub async fn fork_grok_bot_status(cwd: Option<String>) -> GrokBotStatus {
    let (policy, allowed) = folder_policy(cwd.as_deref());
    GrokBotStatus {
        installed: installed(),
        allowed,
        policy,
    }
}

/// Async so the `open` call stays off the main thread.
#[tauri::command]
pub async fn fork_grok_bot_open(
    text: Option<String>,
    cwd: Option<String>,
    bot_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_grok_bot(text, cwd, bot_id))
        .await
        .map_err(|e| e.to_string())?
}

fn open_grok_bot(
    text: Option<String>,
    cwd: Option<String>,
    bot_id: Option<String>,
) -> Result<(), String> {
    // No folder means the default policy, never a free pass.
    let (policy, allowed) = folder_policy(cwd.as_deref());
    if !allowed {
        return Err(format!(
            "Grok Bot is off for this folder: its privacy policy is {policy}."
        ));
    }
    if !installed() {
        return Err("Grok Bot is not installed.".into());
    }
    let output = Command::new("/usr/bin/open")
        .arg(prompt_url(text.as_deref(), bot_id.as_deref())?)
        .output()
        .map_err(|e| format!("Grok Bot could not be opened: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Grok Bot could not be opened (exit {}).", output.status)
    } else {
        stderr
    })
}

/// Also used by `fork_grok_bot_webhook.rs`.
pub(crate) fn folder_policy(cwd: Option<&str>) -> (String, bool) {
    let home = dirs_home().map(PathBuf::from).unwrap_or_default();
    let Ok(real) = real_cwd(cwd) else {
        return ("unresolved".to_string(), false);
    };
    match read_policy(&home) {
        Ok(json) => policy_for(json.as_deref(), &home, real.as_deref()),
        Err(()) => unreadable(),
    }
}

/// `Ok(None)` only when there is no policy file; any other failure is `Err`.
fn read_policy(home: &Path) -> Result<Option<String>, ()> {
    if home.as_os_str().is_empty() {
        return Ok(None);
    }
    match std::fs::read_to_string(home.join(POLICY_FILE)) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

/// A policy file that can't be read or parsed blocks Grok everywhere.
fn unreadable() -> (String, bool) {
    ("unreadable".to_string(), false)
}

/// Resolve `.` and `..` without touching the disk, so `a/allowed/../secret`
/// is judged as `a/secret`.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().unwrap_or_default()),
            Component::ParentDir => {
                parts.pop();
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    format!("/{}", parts.join("/"))
}

fn installed() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let home = dirs_home().unwrap_or_default();
    Path::new("/Applications/Grok Bot.app").is_dir()
        || (!home.is_empty() && Path::new(&home).join("Applications/Grok Bot.app").is_dir())
}

/// Expand a leading `~` and drop a trailing `/`, without touching the disk.
fn expand_rule_path(path: &str, home: &Path) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        return home
            .join(rest)
            .to_string_lossy()
            .trim_end_matches('/')
            .to_string();
    }
    if path == "~" {
        return home.to_string_lossy().trim_end_matches('/').to_string();
    }
    path.trim_end_matches('/').to_string()
}

/// Where the folder really is, so a symlink can't borrow a looser policy.
/// `Err` when it can't be resolved; the caller then blocks.
fn real_cwd(cwd: Option<&str>) -> Result<Option<String>, ()> {
    match cwd.filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => std::fs::canonicalize(cwd)
            .map(|path| Some(path.to_string_lossy().into_owned()))
            .map_err(|_| ()),
        None => Ok(None),
    }
}

/// A rule's folder as it really is on disk, when it exists, so it matches a
/// resolved working folder.
fn real_rule_path(path: String) -> String {
    match std::fs::canonicalize(&path) {
        Ok(real) => real.to_string_lossy().trim_end_matches('/').to_string(),
        Err(_) => path,
    }
}

/// The policy a folder falls under, and whether Grok may see it.
fn policy_for(policy_json: Option<&str>, home: &Path, cwd: Option<&str>) -> (String, bool) {
    let Some(json) = policy_json else {
        return ("none".to_string(), true);
    };
    let Ok(file) = serde_json::from_str::<PolicyFile>(json) else {
        return unreadable();
    };
    let default = file.default.unwrap_or_else(|| "confidential".to_string());
    let cwd = cwd.filter(|cwd| !cwd.is_empty()).map(normalize);
    let policy = match cwd.as_deref() {
        Some(cwd) => file
            .rules
            .iter()
            .filter_map(|rule| {
                let path = real_rule_path(expand_rule_path(&rule.path, home));
                let hit = !path.is_empty() && (cwd == path || cwd.starts_with(&format!("{path}/")));
                hit.then_some((path.len(), rule.policy.as_str()))
            })
            .max_by_key(|(length, _)| *length)
            .map_or(default, |(_, policy)| policy.to_string()),
        None => default,
    };
    let allowed = file
        .routes
        .get(&policy)
        .is_some_and(|routes| routes.iter().any(|route| route == "grok"));
    (policy, allowed)
}

/// Grok Bot's own pattern for a bot id in its links.
pub(crate) fn valid_bot_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `bot_id` picks the bot whose message box gets the text; without it Grok
/// Bot uses its main bot.
fn prompt_url(text: Option<&str>, bot_id: Option<&str>) -> Result<String, String> {
    let text = text.map(str::trim).unwrap_or_default();
    if let Some(id) = bot_id {
        if !valid_bot_id(id) {
            return Err("Invalid Grok Bot bot id.".to_string());
        }
        if text.is_empty() {
            return Err("A message for a Grok Bot bot can't be empty.".to_string());
        }
    }
    if text.is_empty() {
        return Ok("grokbot://app/v1/open".to_string());
    }
    if text.encode_utf16().count() > MAX_PROMPT_CHARS {
        return Err("Grok Bot prompts are limited to 1000 characters.".to_string());
    }
    let encoded: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    Ok(match bot_id {
        Some(id) => format!("grokbot://app/v1/prompt?text={encoded}&id={id}"),
        None => format!("grokbot://app/v1/prompt?text={encoded}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/sam";
    const POLICY: &str = r#"{"default":"confidential",
        "routes":{"confidential":["codex"],"personal":["codex","grok","cursor"]},
        "rules":[{"path":"~/Documents/projects","policy":"confidential"},
                 {"path":"~/Documents/projects/monocode","policy":"personal"},
                 {"path":"/x/monocode","policy":"personal"}]}"#;

    fn policy(cwd: &str) -> (String, bool) {
        policy_for(Some(POLICY), Path::new(HOME), Some(cwd))
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_is_judged_by_where_it_points() {
        let root = std::env::temp_dir().join(format!("grokbot-policy-{}", std::process::id()));
        let secret = root.join("secret");
        let open = root.join("open");
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::create_dir_all(&open).unwrap();
        let link = open.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let json = format!(
            r#"{{"default":"personal","routes":{{"personal":["grok"],"confidential":["codex"]}},
                "rules":[{{"path":"{}","policy":"confidential"}},{{"path":"{}","policy":"personal"}}]}}"#,
            secret.display(),
            open.display()
        );
        let real = real_cwd(Some(link.to_str().unwrap())).unwrap();
        assert_eq!(
            policy_for(Some(&json), Path::new(HOME), real.as_deref()),
            ("confidential".to_string(), false)
        );
        assert!(real_cwd(Some(root.join("missing").to_str().unwrap())).is_err());
        assert_eq!(real_cwd(None), Ok(None));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_policy_file_allows_everything() {
        assert_eq!(
            policy_for(None, Path::new(HOME), Some("/x")),
            ("none".to_string(), true)
        );
    }

    #[test]
    fn a_broken_policy_file_blocks_everything() {
        assert_eq!(
            policy_for(Some("{not json"), Path::new(HOME), Some("/x")),
            unreadable()
        );
        assert_eq!(
            policy_for(Some(r#"{"rules": 3}"#), Path::new(HOME), Some("/x")),
            unreadable()
        );
    }

    #[test]
    fn dot_dot_cannot_escape_an_allowed_folder() {
        assert_eq!(
            policy("/Users/sam/Documents/projects/monocode/../upwork"),
            ("confidential".to_string(), false)
        );
        assert_eq!(policy("/x/./monocode/src/"), ("personal".to_string(), true));
    }

    #[test]
    fn the_longest_matching_rule_wins() {
        assert_eq!(
            policy("/Users/sam/Documents/projects/monocode/src"),
            ("personal".to_string(), true)
        );
        assert_eq!(
            policy("/Users/sam/Documents/projects/upwork"),
            ("confidential".to_string(), false)
        );
        assert_eq!(
            policy("/x/monocode-worktrees/foo"),
            ("confidential".to_string(), false)
        );
        assert_eq!(policy("/elsewhere"), ("confidential".to_string(), false));
    }

    #[test]
    fn urls_encode_and_cap_the_text() {
        assert_eq!(prompt_url(None, None).unwrap(), "grokbot://app/v1/open");
        assert_eq!(
            prompt_url(Some("  \n "), None).unwrap(),
            "grokbot://app/v1/open"
        );
        let text = "summarise src/lib.rs & tell me\nwhy";
        let url = prompt_url(Some(text), None).unwrap();
        let query = url.split_once('?').unwrap().1;
        let parsed: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(parsed, vec![("text".to_string(), text.to_string())]);
        assert!(prompt_url(Some("😀".repeat(MAX_PROMPT_CHARS / 2).as_str()), None).is_ok());
        assert!(prompt_url(Some("😀".repeat(MAX_PROMPT_CHARS / 2 + 1).as_str()), None).is_err());
        let too_long = "a".repeat(MAX_PROMPT_CHARS + 1);
        assert_eq!(
            prompt_url(Some(too_long.as_str()), None),
            Err("Grok Bot prompts are limited to 1000 characters.".to_string())
        );
    }

    #[test]
    fn urls_can_name_a_bot() {
        let url = prompt_url(Some("hi there"), Some("8c1f-ab_C")).unwrap();
        assert_eq!(url, "grokbot://app/v1/prompt?text=hi+there&id=8c1f-ab_C");
        assert!(prompt_url(Some("hi"), Some("bad id")).is_err());
        assert!(prompt_url(Some("hi"), Some("a&text=x")).is_err());
        assert!(prompt_url(Some("hi"), Some("")).is_err());
        assert!(prompt_url(Some("hi"), Some("a".repeat(129).as_str())).is_err());
        assert!(prompt_url(Some("  "), Some("abc")).is_err());
    }
}
