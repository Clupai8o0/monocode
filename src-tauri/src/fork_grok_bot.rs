//! Fork feature: hand a task to the Grok Bot desktop app through its URL scheme.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    GrokBotStatus { installed: installed(), allowed, policy }
}

/// Async so the `open` call stays off the main thread.
#[tauri::command]
pub async fn fork_grok_bot_open(text: Option<String>, cwd: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_grok_bot(text, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn open_grok_bot(text: Option<String>, cwd: Option<String>) -> Result<(), String> {
    if let Some(folder) = cwd.as_deref() {
        let (policy, allowed) = folder_policy(Some(folder));
        if !allowed {
            return Err(format!(
                "Grok Bot is off for this folder: its privacy policy is {policy}."
            ));
        }
    }
    if !installed() {
        return Err("Grok Bot is not installed.".into());
    }
    let output = Command::new("/usr/bin/open")
        .arg(prompt_url(text.as_deref())?)
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

fn folder_policy(cwd: Option<&str>) -> (String, bool) {
    let home = dirs_home().map(PathBuf::from).unwrap_or_default();
    policy_for(read_policy(&home).as_deref(), &home, cwd)
}

fn read_policy(home: &Path) -> Option<String> {
    if home.as_os_str().is_empty() {
        return None;
    }
    std::fs::read_to_string(home.join(POLICY_FILE)).ok()
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
        return home.join(rest).to_string_lossy().trim_end_matches('/').to_string();
    }
    if path == "~" {
        return home.to_string_lossy().trim_end_matches('/').to_string();
    }
    path.trim_end_matches('/').to_string()
}

/// The policy a folder falls under, and whether Grok may see it.
fn policy_for(policy_json: Option<&str>, home: &Path, cwd: Option<&str>) -> (String, bool) {
    let Some(json) = policy_json else {
        return ("none".to_string(), true);
    };
    let Ok(file) = serde_json::from_str::<PolicyFile>(json) else {
        return ("none".to_string(), true);
    };
    let default = file.default.unwrap_or_else(|| "confidential".to_string());
    let policy = match cwd.filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => file
            .rules
            .iter()
            .filter_map(|rule| {
                let path = expand_rule_path(&rule.path, home);
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

fn prompt_url(text: Option<&str>) -> Result<String, String> {
    let text = text.map(str::trim).unwrap_or_default();
    if text.is_empty() {
        return Ok("grokbot://app/v1/open".to_string());
    }
    if text.encode_utf16().count() > MAX_PROMPT_CHARS {
        return Err("Grok Bot prompts are limited to 1000 characters.".to_string());
    }
    let encoded: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    Ok(format!("grokbot://app/v1/prompt?text={encoded}"))
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
    fn no_policy_file_allows_everything() {
        assert_eq!(policy_for(None, Path::new(HOME), Some("/x")), ("none".to_string(), true));
    }

    #[test]
    fn the_longest_matching_rule_wins() {
        assert_eq!(policy("/Users/sam/Documents/projects/monocode/src"), ("personal".to_string(), true));
        assert_eq!(policy("/Users/sam/Documents/projects/upwork"), ("confidential".to_string(), false));
        assert_eq!(policy("/x/monocode-worktrees/foo"), ("confidential".to_string(), false));
        assert_eq!(policy("/elsewhere"), ("confidential".to_string(), false));
    }

    #[test]
    fn urls_encode_and_cap_the_text() {
        assert_eq!(prompt_url(None).unwrap(), "grokbot://app/v1/open");
        assert_eq!(prompt_url(Some("  \n ")).unwrap(), "grokbot://app/v1/open");
        let text = "summarise src/lib.rs & tell me\nwhy";
        let url = prompt_url(Some(text)).unwrap();
        let query = url.split_once('?').unwrap().1;
        let parsed: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(parsed, vec![("text".to_string(), text.to_string())]);
        assert!(prompt_url(Some("😀".repeat(MAX_PROMPT_CHARS / 2).as_str())).is_ok());
        assert!(prompt_url(Some("😀".repeat(MAX_PROMPT_CHARS / 2 + 1).as_str())).is_err());
        let too_long = "a".repeat(MAX_PROMPT_CHARS + 1);
        assert_eq!(
            prompt_url(Some(too_long.as_str())),
            Err("Grok Bot prompts are limited to 1000 characters.".to_string())
        );
    }
}
