//! Fork feature: plan usage for agents MonoCode has no usage API for.
//!
//! Muse and Antigravity print theirs without a model turn (`muse usage
//! --json`, `agy -p /quota --output-format json`). Cursor reports Auto and
//! API pools from its dashboard API with the Agent CLI's access token.
//! Grok reads the same credits endpoint and login as its `/usage` screen.
//! DeepSeek reports the prepaid balance of the key `dsh` uses (Keychain
//! item `deepseek-api`). The raw JSON goes back to the webview, which parses it.

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
        "cursor" => cursor_usage(),
        "deepseek" => deepseek_balance(),
        "grok" => grok_usage(),
        _ => unavailable("No usage source for this provider"),
    })
    .await
    .unwrap_or_else(|_| error("Could not read usage"))
}

const CURSOR_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

// Matches Grok Build's official OIDC login slot; never use an arbitrary
// custom-provider token from auth.json against the first-party endpoint.
const GROK_AUTH_SLOT: &str = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const GROK_USAGE_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

fn read_grok_auth_file(path: &std::path::Path) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let auth = value.get(GROK_AUTH_SLOT)?;
    let token = auth.get("key")?.as_str()?.trim();
    let user_id = auth.get("user_id")?.as_str()?.trim();
    if token.is_empty() || user_id.is_empty() {
        return None;
    }
    Some((token.to_owned(), user_id.to_owned()))
}

/// Same request as xai-grok-shell's `x.ai/billing` extension, without
/// starting a model turn. Credentials remain in the native process.
fn grok_usage() -> ExtraUsage {
    let home = std::env::var_os("GROK_HOME")
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| crate::dirs_home().map(|home| std::path::PathBuf::from(home).join(".grok")));
    let auth = home.and_then(|home| read_grok_auth_file(&home.join("auth.json")));
    let Some((token, user_id)) = auth else {
        return unavailable("Grok Build is not signed in; run `grok login`");
    };
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let response = agent
        .get(GROK_USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("X-XAI-Token-Auth", "xai-grok-cli")
        .set("x-userid", &user_id)
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .call();
    match response {
        Ok(response) => {
            let mut body = String::new();
            match response
                .into_reader()
                .take(MAX_OUTPUT + 1)
                .read_to_string(&mut body)
            {
                Ok(_) if body.len() as u64 <= MAX_OUTPUT => ExtraUsage::Ok { body },
                _ => error("Grok's usage could not be read"),
            }
        }
        Err(ureq::Error::Status(401 | 403, _)) => {
            unavailable("Open Grok Build to refresh usage; if needed, run `grok login`")
        }
        Err(ureq::Error::Status(code, _)) => error(&format!("Grok answered HTTP {code}")),
        Err(_) => error("Could not reach Grok"),
    }
}

/// Cursor Agent's plan meters. The CLI stores the same Bearer token the
/// dashboard uses; on macOS that secret usually lives only in the Keychain.
fn cursor_usage() -> ExtraUsage {
    let Some(token) = cursor_access_token() else {
        return unavailable("Cursor Agent is not signed in");
    };
    let response = ureq::post(CURSOR_USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Connect-Protocol-Version", "1")
        .timeout(Duration::from_secs(15))
        .send_string("{}");
    match response {
        Ok(response) => {
            let mut body = String::new();
            match response
                .into_reader()
                .take(MAX_OUTPUT)
                .read_to_string(&mut body)
            {
                Ok(_) => ExtraUsage::Ok { body },
                Err(_) => error("Cursor's usage could not be read"),
            }
        }
        Err(ureq::Error::Status(401 | 403, _)) => {
            unavailable("Cursor Agent sign-in expired; run `agent login`")
        }
        Err(ureq::Error::Status(code, _)) => error(&format!("Cursor answered HTTP {code}")),
        Err(_) => error("Could not reach Cursor"),
    }
}

fn cursor_access_token() -> Option<String> {
    for path in cursor_auth_paths() {
        if let Some(token) = read_cursor_auth_file(&path) {
            return Some(token);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let token = crate::rate_limits::security_output(&[
            "find-generic-password".into(),
            "-s".into(),
            "cursor-access-token".into(),
            "-a".into(),
            "cursor-user".into(),
            "-w".into(),
        ])
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty());
        if token.is_some() {
            return token;
        }
    }
    None
}

fn cursor_auth_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        paths.push(std::path::PathBuf::from(xdg).join("cursor/auth.json"));
    }
    if let Some(home) = crate::dirs_home() {
        let home = std::path::PathBuf::from(home);
        paths.push(home.join(".config/cursor/auth.json"));
        paths.push(home.join(".cursor/auth.json"));
    }
    paths
}

fn read_cursor_auth_file(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let token = value
        .get("accessToken")
        .and_then(|token| token.as_str())?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
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
    use std::io::Write;

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

    #[test]
    fn reads_the_cursor_access_token_from_auth_json() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-cursor-auth-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("auth.json");
        let mut file = std::fs::File::create(&path).unwrap();
        write!(file, r#"{{"accessToken":" cursor-token-1 "}}"#).unwrap();
        assert_eq!(
            read_cursor_auth_file(&path).as_deref(),
            Some("cursor-token-1")
        );
        assert_eq!(
            read_cursor_auth_file(&dir.join("missing.json")),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grok_credentials_use_only_the_official_cli_login() {
        let path = std::env::temp_dir().join(format!("mc-grok-auth-{}.json", std::process::id()));
        std::fs::write(&path, r#"{
            "https://other.example::custom": {"key":"wrong", "user_id":"other"},
            "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {"key":"token", "user_id":"user"}
        }"#).unwrap();
        assert_eq!(
            read_grok_auth_file(&path),
            Some(("token".into(), "user".into()))
        );
        for body in [
            "{}",
            "invalid",
            r#"{"key":"legacy-or-unknown"}"#,
            r#"{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"", "user_id":"user"}}"#,
        ] {
            std::fs::write(&path, body).unwrap();
            assert!(read_grok_auth_file(&path).is_none());
        }
        std::fs::remove_file(path).unwrap();
    }
}
