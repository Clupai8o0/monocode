//! Fork feature: the home lab controls. Reads and sets which sessions start
//! Remote Control through the vault's `remote_control.py`, and opens an RDP
//! file built from the address and user a lab machine handed over.
//!
//! The script path is fixed here, under the home folder; the webview only
//! passes a scope, a time and a short name, all checked first.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::Manager;

use crate::dirs_home;
use crate::fork_stacks::{last_line, run};

const SCRIPT: &str =
    "Documents/Obsidian/brain/30-resources/_meta/claude-shared/hooks/remote_control.py";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BY: usize = 80;
const MAX_RDP: usize = 4 * 1024;
const OPEN_WAIT: Duration = Duration::from_secs(10);
const MISSING: &str = "The vault's remote_control.py was not found";

/// What `remote_control.py status --json` printed.
#[tauri::command]
pub async fn fork_lab_rc_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || rc_status(&script_path()?).map(with_machine))
        .await
        .map_err(|e| e.to_string())?
}

/// Sets the scope with the time and name it came with, then applies it.
#[tauri::command]
pub async fn fork_lab_rc_apply(
    scope: String,
    updated_at: u64,
    by: String,
) -> Result<Value, String> {
    check_apply(&scope, &by)?;
    tauri::async_runtime::spawn_blocking(move || {
        rc_apply(&script_path()?, &scope, updated_at, &by).map(with_machine)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Builds an RDP file from the address and user in the host's text, writes
/// it under the app's data folder and opens it. Nothing else the host sent
/// reaches the file.
#[tauri::command]
pub async fn fork_lab_open_rdp(
    app: tauri::AppHandle,
    name: String,
    rdp: String,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = write_rdp(&dir, &name, &rdp)?;
        open_file(&file)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds this Mac's name, as the lab machines see it, for the settings page.
fn with_machine(mut status: Value) -> Value {
    if let Value::Object(map) = &mut status {
        let name = crate::remote_ssh::device_name();
        let name = name
            .strip_prefix("MonoCode on ")
            .unwrap_or(&name)
            .to_string();
        map.insert("machine".into(), Value::String(name));
    }
    status
}

fn script_path() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or(MISSING)?;
    Ok(PathBuf::from(home).join(SCRIPT))
}

fn rc_status(script: &Path) -> Result<Value, String> {
    call(script, &["status", "--json"])
}

fn rc_apply(script: &Path, scope: &str, updated_at: u64, by: &str) -> Result<Value, String> {
    check_apply(scope, by)?;
    let at = updated_at.to_string();
    call(script, &["set", scope, "--at", &at, "--by", by, "--json"])
}

fn check_apply(scope: &str, by: &str) -> Result<(), String> {
    if !matches!(scope, "all" | "lab") {
        return Err("scope must be all or lab".into());
    }
    if by.chars().count() > MAX_BY {
        return Err("name is too long".into());
    }
    if by.contains('\0') {
        return Err("name has a bad character".into());
    }
    Ok(())
}

/// Runs the script and reads the one JSON object it prints.
fn call(script: &Path, args: &[&str]) -> Result<Value, String> {
    if !script.is_file() {
        return Err(MISSING.into());
    }
    let (ok, out) = run(script, args, TIMEOUT)?;
    if !ok {
        return Err(error_text(&out));
    }
    serde_json::from_slice(&out).map_err(|e| format!("remote_control.py printed bad JSON: {e}"))
}

/// The `{"error"}` message when stdout has one, else the last output line.
fn error_text(out: &[u8]) -> String {
    let text = String::from_utf8_lossy(out);
    for line in text.lines() {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(Value::String(msg)) = map.get("error") {
                return msg.chars().take(300).collect();
            }
        }
    }
    last_line(out).unwrap_or_else(|| "remote_control.py failed".into())
}

fn safe_name(name: &str) -> &str {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.chars().all(|c| c == '.');
    if ok {
        name
    } else {
        "lab"
    }
}

/// The Tailscale address and user from an RDP file's text; every other
/// line is ignored.
fn parse_rdp(rdp: &str) -> Result<(Ipv4Addr, u16, String), String> {
    if rdp.len() > MAX_RDP {
        return Err("The remote desktop file is too big".into());
    }
    let mut address = None;
    let mut user = None;
    for line in rdp.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(value) = line.strip_prefix("full address:s:") {
            address = Some(value);
        } else if let Some(value) = line.strip_prefix("username:s:") {
            user = Some(value);
        }
    }
    let address = address.ok_or("The remote desktop file has no address")?;
    let (ip, port) = address
        .rsplit_once(':')
        .ok_or("The remote desktop address has no port")?;
    let ip: Ipv4Addr = ip
        .parse()
        .map_err(|_| "The remote desktop address is not an IPv4 address")?;
    if !is_tailscale(ip) {
        return Err("The remote desktop address is not a Tailscale address".into());
    }
    let port = Some(port)
        .filter(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or("The remote desktop port is not valid")?;
    let user = user.ok_or("The remote desktop file has no user")?;
    if !valid_user(user) {
        return Err("The remote desktop user name is not valid".into());
    }
    Ok((ip, port, user.to_string()))
}

/// 100.64.0.0/10, the range Tailscale hands out.
fn is_tailscale(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

fn valid_user(user: &str) -> bool {
    (1..=32).contains(&user.len())
        && user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !user.starts_with(['-', '.'])
}

/// The whole file: the address, the user, and fixed settings that keep
/// drives, printers and devices on this Mac.
fn build_rdp(ip: Ipv4Addr, port: u16, user: &str) -> String {
    [
        format!("full address:s:{ip}:{port}"),
        format!("username:s:{user}"),
        "prompt for credentials:i:1".into(),
        "authentication level:i:2".into(),
        "screen mode id:i:2".into(),
        "redirectclipboard:i:1".into(),
        "drivestoredirect:s:".into(),
        "redirectprinters:i:0".into(),
        "redirectcomports:i:0".into(),
        "redirectsmartcards:i:0".into(),
        "devicestoredirect:s:".into(),
        "camerastoredirect:s:".into(),
        "usbdevicestoredirect:s:".into(),
        "audiocapturemode:i:0".into(),
    ]
    .iter()
    .map(|line| format!("{line}\r\n"))
    .collect()
}

fn write_rdp(data_dir: &Path, name: &str, rdp: &str) -> Result<PathBuf, String> {
    let (ip, port, user) = parse_rdp(rdp)?;
    let dir = data_dir.join("rdp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't make the RDP folder: {e}"))?;
    let file = dir.join(format!("{}.rdp", safe_name(name)));
    std::fs::write(&file, build_rdp(ip, port, &user))
        .map_err(|e| format!("couldn't write the RDP file: {e}"))?;
    Ok(file)
}

fn open_file(file: &Path) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(opener);
    command.arg(file);
    wait_for_opener(command, opener, OPEN_WAIT)
}

/// Waits up to `limit` for the opener. One still running then (xdg-open can
/// stay) is left to run and reaped on a thread of its own.
fn wait_for_opener(mut command: Command, opener: &str, limit: Duration) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{opener} failed to start: {e}"))?;
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(format!("{opener} couldn't open the RDP file")),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(e) => return Err(format!("{opener} failed: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fork-lab-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake remote_control.py that echoes its arguments, or fails on "boom".
    fn fake_script(dir: &Path) -> PathBuf {
        let path = dir.join("remote_control.py");
        std::fs::write(
            &path,
            r#"import json, sys
args = sys.argv[1:]
if "boom" in args:
    print(json.dumps({"error": "lock is held"}))
    sys.exit(1)
if "crash" in args:
    sys.stderr.write("first\nTraceback last line\n")
    sys.exit(2)
out = {"scope": "lab", "updatedAt": 5, "by": "mac", "lab": False, "wanted": True,
       "accounts": [{"account": "main", "enabled": True}], "args": args}
if args and args[0] == "set":
    out.update(scope=args[1], updatedAt=int(args[3]), by=args[5], changed=True)
print(json.dumps(out))
"#,
        )
        .unwrap();
        path
    }

    #[test]
    fn checks_scope_and_name() {
        assert!(check_apply("all", "mac").is_ok());
        assert!(check_apply("lab", "").is_ok());
        assert!(check_apply("none", "mac").is_err());
        assert!(check_apply("ALL", "mac").is_err());
        assert!(check_apply("all", &"a".repeat(80)).is_ok());
        assert!(check_apply("all", &"a".repeat(81)).is_err());
        assert!(check_apply("all", "a\0b").is_err());
    }

    #[test]
    fn cleans_rdp_names() {
        assert_eq!(safe_name("vivobook"), "vivobook");
        assert_eq!(safe_name("lab-1.home_2"), "lab-1.home_2");
        assert_eq!(safe_name(""), "lab");
        assert_eq!(safe_name("../etc"), "lab");
        assert_eq!(safe_name("a b"), "lab");
        assert_eq!(safe_name(".."), "lab");
        assert_eq!(safe_name(&"a".repeat(64)), "a".repeat(64));
        assert_eq!(safe_name(&"a".repeat(65)), "lab");
    }

    #[test]
    fn writes_rdp_files_it_builds_itself() {
        let dir = temp_dir();
        let rdp = "full address:s:100.64.0.2:3389\r\nusername:s:clupai\r\n";
        let file = write_rdp(&dir, "vivobook", rdp).unwrap();
        assert_eq!(file, dir.join("rdp").join("vivobook.rdp"));
        let written = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            written,
            build_rdp(Ipv4Addr::new(100, 64, 0, 2), 3389, "clupai")
        );
        assert!(written.starts_with(
            "full address:s:100.64.0.2:3389\r\nusername:s:clupai\r\nprompt for credentials:i:1\r\n"
        ));
        assert!(written.ends_with("audiocapturemode:i:0\r\n"));
        assert_eq!(written.lines().count(), 14);
        let file = write_rdp(&dir, "../x", rdp).unwrap();
        assert_eq!(file, dir.join("rdp").join("lab.rdp"));

        // What else the host sent never reaches the file.
        let hostile = "full address:s:100.127.255.254:65535\nusername:s:a.b_c-1\n\
                       drivestoredirect:s:*\nredirectprinters:i:1\ngatewayhostname:s:evil\n";
        let file = write_rdp(&dir, "x", hostile).unwrap();
        let written = std::fs::read_to_string(&file).unwrap();
        assert!(written.contains("full address:s:100.127.255.254:65535\r\n"));
        assert!(written.contains("drivestoredirect:s:\r\n"));
        assert!(written.contains("redirectprinters:i:0\r\n"));
        assert!(!written.contains("evil") && !written.contains('*'));

        assert!(write_rdp(&dir, "a", "username:s:x").is_err());
        let big = format!(
            "full address:s:100.64.0.2:3389\nusername:s:u\n{}",
            "x".repeat(MAX_RDP)
        );
        assert!(write_rdp(&dir, "a", &big).is_err());
        assert!(!dir.join("rdp").join("a.rdp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn takes_only_tailscale_addresses_and_plain_users() {
        let rdp = |address: &str, user: &str| {
            parse_rdp(&format!("full address:s:{address}\nusername:s:{user}\n"))
        };
        assert_eq!(
            rdp("100.100.1.2:3389", "u").unwrap(),
            (Ipv4Addr::new(100, 100, 1, 2), 3389, "u".into())
        );
        assert_eq!(
            rdp("100.64.0.0:1", "a").unwrap(),
            (Ipv4Addr::new(100, 64, 0, 0), 1, "a".into())
        );
        let tailscale = "The remote desktop address is not a Tailscale address";
        for address in ["100.128.0.1:3389", "100.63.255.255:3389", "10.0.0.2:3389"] {
            assert_eq!(rdp(address, "u").unwrap_err(), tailscale, "{address}");
        }
        for address in [
            "100.64.0.2:0",
            "100.64.0.2:65536",
            "100.64.0.2:+3389",
            "100.64.0.2:",
            "100.64.0.2",
            "vivobook:3389",
            "[fd7a::1]:3389",
        ] {
            assert!(rdp(address, "u").is_err(), "{address}");
        }
        assert!(rdp("100.64.0.2:3389", &"a".repeat(32)).is_ok());
        for user in ["", "-x", ".x", "a b", "a;b", "a/b", &"a".repeat(33)] {
            assert!(rdp("100.64.0.2:3389", user).is_err(), "{user}");
        }
        assert!(parse_rdp("full address:s:100.64.0.2:3389\n").is_err());
        // CRLF and LF both read; a stray CR inside a value does not pass.
        assert!(parse_rdp("full address:s:100.64.0.2:3389\r\nusername:s:u\r\n").is_ok());
        assert!(parse_rdp("full address:s:100.64.0.2:3389\rusername:s:u\n").is_err());
    }

    #[test]
    fn waits_for_the_opener_only_so_long() {
        let limit = Duration::from_millis(300);
        assert!(wait_for_opener(Command::new("true"), "true", limit).is_ok());
        assert!(wait_for_opener(Command::new("false"), "false", limit).is_err());
        let mut slow = Command::new("sleep");
        slow.arg("5");
        let started = Instant::now();
        assert!(wait_for_opener(slow, "sleep", limit).is_ok());
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(wait_for_opener(Command::new("/nonexistent/opener"), "x", limit).is_err());
    }

    #[test]
    fn reads_status_and_applies() {
        let dir = temp_dir();
        let script = fake_script(&dir);
        let status = rc_status(&script).unwrap();
        assert_eq!(status["scope"], "lab");
        assert_eq!(status["args"], serde_json::json!(["status", "--json"]));

        let applied = rc_apply(&script, "all", 1_700_000_000_000, "phone").unwrap();
        assert_eq!(applied["scope"], "all");
        assert_eq!(applied["updatedAt"], 1_700_000_000_000u64);
        assert_eq!(applied["by"], "phone");
        assert_eq!(applied["changed"], true);
        assert!(rc_apply(&script, "bad", 1, "phone").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_script_errors() {
        let dir = temp_dir();
        let script = fake_script(&dir);
        assert_eq!(
            rc_apply(&script, "all", 1, "boom").unwrap_err(),
            "lock is held"
        );
        assert_eq!(
            rc_apply(&script, "all", 1, "crash").unwrap_err(),
            "Traceback last line"
        );
        assert_eq!(rc_status(&dir.join("missing.py")).unwrap_err(), MISSING);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
