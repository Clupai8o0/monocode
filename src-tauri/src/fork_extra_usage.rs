//! Fork feature: plan usage for agents MonoCode has no usage API for.
//!
//! Muse and Antigravity print theirs without a model turn (`muse usage
//! --json`, `agy -p /quota --output-format json`). DeepSeek reports the
//! prepaid balance of the key `dsh` uses (Keychain item `deepseek-api`).
//! The raw JSON goes back to the webview, which parses it.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::fork_statusline::{exited_by, kill_group};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUTPUT: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ExtraUsage {
    Ok { body: String },
    Unavailable { message: String },
    Error { message: String },
}

#[tauri::command]
pub async fn fork_extra_usage(provider: String) -> ExtraUsage {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "muse" => cli("muse", &["usage", "--json"]),
        "antigravity" => cli("agy", &["-p", "/quota", "--output-format", "json"]),
        "deepseek" => deepseek_balance(),
        _ => unavailable("No usage source for this provider"),
    })
    .await
    .unwrap_or_else(|_| error("Could not read usage"))
}

fn unavailable(message: &str) -> ExtraUsage {
    ExtraUsage::Unavailable {
        message: message.into(),
    }
}

fn error(message: &str) -> ExtraUsage {
    ExtraUsage::Error {
        message: message.into(),
    }
}

/// Runs one CLI from a neutral folder, so it never records the project.
fn cli(program: &str, args: &[&str]) -> ExtraUsage {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::harness::gui_search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return unavailable(&format!("{program} is not installed"));
        }
        Err(e) => return error(&format!("{program} failed to start: {e}")),
    };
    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(MAX_OUTPUT).read_to_end(&mut out);
        }
        let _ = tx.send(out);
    });
    let deadline = Instant::now() + TIMEOUT;
    let out = rx.recv_timeout(TIMEOUT).ok();
    let exited = out.is_some() && exited_by(&mut child, deadline);
    if !exited {
        kill_group(&mut child);
    }
    let status = child.wait().ok();
    match out {
        Some(out) if exited && status.is_some_and(|s| s.success()) => ExtraUsage::Ok {
            body: String::from_utf8_lossy(&out).into_owned(),
        },
        Some(_) if exited => error(&format!(
            "{program} could not report usage; is it signed in?"
        )),
        _ => error(&format!("{program} timed out")),
    }
}

#[cfg(target_os = "macos")]
fn deepseek_balance() -> ExtraUsage {
    // Timed: a locked Keychain must not leave the footer loading forever.
    let key = crate::rate_limits::security_output(&[
        "find-generic-password".into(),
        "-s".into(),
        "deepseek-api".into(),
        "-w".into(),
    ])
    .map(|key| key.trim().to_owned())
    .unwrap_or_default();
    if key.is_empty() {
        return unavailable("No DeepSeek key in the Keychain (deepseek-api)");
    }
    let response = ureq::get("https://api.deepseek.com/user/balance")
        .set("Authorization", &format!("Bearer {key}"))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .call();
    match response {
        Ok(response) => {
            let mut body = String::new();
            match response
                .into_reader()
                .take(MAX_OUTPUT)
                .read_to_string(&mut body)
            {
                Ok(_) => ExtraUsage::Ok { body },
                Err(_) => error("DeepSeek's balance could not be read"),
            }
        }
        Err(ureq::Error::Status(code, _)) => error(&format!("DeepSeek answered HTTP {code}")),
        Err(_) => error("Could not reach DeepSeek"),
    }
}

#[cfg(not(target_os = "macos"))]
fn deepseek_balance() -> ExtraUsage {
    unavailable("The DeepSeek balance reads its key from the macOS Keychain")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_what_the_cli_printed() {
        match cli("sh", &["-c", "printf '{\"ok\":1}'"]) {
            ExtraUsage::Ok { body } => assert_eq!(body, "{\"ok\":1}"),
            other => panic!("expected output, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_cli_is_unavailable_and_a_failing_one_an_error() {
        assert!(matches!(
            cli("monocode-no-such-usage-cli", &[]),
            ExtraUsage::Unavailable { .. }
        ));
        assert!(matches!(
            cli("sh", &["-c", "exit 3"]),
            ExtraUsage::Error { .. }
        ));
    }
}
