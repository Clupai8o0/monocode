//! Fork feature: run the person's own Claude Code status line for a session.
//!
//! The command comes from `~/.claude/settings.json` (`statusLine.command`), read
//! here and never from the webview. The webview only supplies the session JSON
//! that Claude Code would pipe on stdin, and the folder to run in.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::dirs_home;

const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: u64 = 16 * 1024;

/// The first line the status line printed, or `None` when none is set up.
#[tauri::command]
pub async fn fork_statusline(cwd: String, input: String) -> Result<Option<String>, String> {
    if input.len() > MAX_INPUT {
        return Err("status line input too large".into());
    }
    tauri::async_runtime::spawn_blocking(move || run(&cwd, &input))
        .await
        .map_err(|e| e.to_string())?
}

fn run(cwd: &str, input: &str) -> Result<Option<String>, String> {
    let Some(home) = dirs_home().map(PathBuf::from) else {
        return Ok(None);
    };
    let Some(command) = statusline_command(&home.join(".claude/settings.json")) else {
        return Ok(None);
    };
    let dir = Path::new(cwd);
    let dir = if dir.is_absolute() && dir.is_dir() { dir } else { home.as_path() };
    let input = with_transcript_path(input, &home);
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .current_dir(dir)
        .env("PATH", crate::harness::gui_search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("status line failed to start: {e}"))?;

    // Feed stdin and drain stdout on their own threads so a full pipe never
    // blocks the timeout below.
    let mut stdin = child.stdin.take();
    let body = input;
    let writer = std::thread::spawn(move || {
        if let Some(stdin) = stdin.as_mut() {
            let _ = stdin.write_all(body.as_bytes());
        }
    });
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(MAX_OUTPUT).read_to_end(&mut out);
        }
        out
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("status line timed out".into());
            }
        }
    }
    let _ = writer.join();
    let out = reader.join().unwrap_or_default();
    Ok(first_line(&out))
}

/// Adds Claude Code's transcript path, so the status line can read effort,
/// context and compactions from the transcript as it does in the terminal.
fn with_transcript_path(input: &str, home: &Path) -> String {
    let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(input) else {
        return input.to_owned();
    };
    let sid = map.get("session_id").and_then(Value::as_str).unwrap_or("");
    let cwd = map.get("cwd").and_then(Value::as_str).unwrap_or("");
    let safe = !sid.is_empty() && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if safe && !cwd.is_empty() {
        let folder: String = cwd
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let path = home.join(".claude/projects").join(folder).join(format!("{sid}.jsonl"));
        map.insert("transcript_path".into(), Value::String(path.to_string_lossy().into_owned()));
    }
    Value::Object(map).to_string()
}

fn statusline_command(settings: &Path) -> Option<String> {
    let text = std::fs::read_to_string(settings).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let line = value.get("statusLine")?;
    if line.get("type").and_then(Value::as_str) != Some("command") {
        return None;
    }
    let command = line.get("command")?.as_str()?.trim();
    (!command.is_empty()).then(|| command.to_owned())
}

fn first_line(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    Some(line.trim_end().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_command_status_lines() {
        let dir = std::env::temp_dir().join(format!("fork-statusline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        std::fs::write(&file, r#"{"statusLine":{"type":"command","command":" ~/s.py "}}"#).unwrap();
        assert_eq!(statusline_command(&file).as_deref(), Some("~/s.py"));
        std::fs::write(&file, r#"{"statusLine":{"type":"static","command":"x"}}"#).unwrap();
        assert_eq!(statusline_command(&file), None);
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(statusline_command(&file), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adds_a_transcript_path_only_for_safe_ids() {
        let home = Path::new("/Users/me");
        let out: Value = serde_json::from_str(&with_transcript_path(
            r#"{"session_id":"ab-12","cwd":"/a/b.c"}"#,
            home,
        ))
        .unwrap();
        assert_eq!(out["transcript_path"], "/Users/me/.claude/projects/-a-b-c/ab-12.jsonl");
        let out: Value = serde_json::from_str(&with_transcript_path(
            r#"{"session_id":"../x","cwd":"/a"}"#,
            home,
        ))
        .unwrap();
        assert!(out.get("transcript_path").is_none());
    }

    #[test]
    fn keeps_the_first_non_empty_line() {
        assert_eq!(first_line(b"\n  \nmodel | ctx\nmore\n").as_deref(), Some("model | ctx"));
        assert_eq!(first_line(b""), None);
    }
}
