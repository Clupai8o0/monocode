//! Fork feature: the home lab controls. Reads and sets which sessions start
//! Remote Control through the vault's `remote_control.py`, and opens an RDP
//! file a lab machine handed over.
//!
//! The script path is fixed here, under the home folder; the webview only
//! passes a scope, a time and a short name, all checked first.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;
use tauri::Manager;

use crate::dirs_home;
use crate::fork_stacks::{last_line, run};

const SCRIPT: &str =
    "Documents/Obsidian/brain/30-resources/_meta/claude-shared/hooks/remote_control.py";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BY: usize = 80;
const MAX_RDP: usize = 4 * 1024;
const RDP_PREFIX: &str = "full address:s:";
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

/// Writes the RDP file under the app's data folder and opens it.
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

fn write_rdp(data_dir: &Path, name: &str, rdp: &str) -> Result<PathBuf, String> {
    if rdp.len() > MAX_RDP {
        return Err("RDP file is too big".into());
    }
    if !rdp.starts_with(RDP_PREFIX) {
        return Err("RDP file must start with full address".into());
    }
    if rdp.contains('\0') {
        return Err("RDP file has a bad character".into());
    }
    let dir = data_dir.join("rdp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't make the RDP folder: {e}"))?;
    let file = dir.join(format!("{}.rdp", safe_name(name)));
    std::fs::write(&file, rdp).map_err(|e| format!("couldn't write the RDP file: {e}"))?;
    Ok(file)
}

fn open_file(file: &Path) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let status = Command::new(opener)
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("{opener} failed to start: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{opener} couldn't open the RDP file"))
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
    fn writes_rdp_files() {
        let dir = temp_dir();
        let rdp = "full address:s:100.64.0.2:3389\nusername:s:clupai\n";
        let file = write_rdp(&dir, "vivobook", rdp).unwrap();
        assert_eq!(file, dir.join("rdp").join("vivobook.rdp"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), rdp);
        let file = write_rdp(&dir, "../x", rdp).unwrap();
        assert_eq!(file, dir.join("rdp").join("lab.rdp"));

        assert!(write_rdp(&dir, "a", "username:s:x").is_err());
        let big = format!("{RDP_PREFIX}{}", "x".repeat(MAX_RDP));
        assert!(write_rdp(&dir, "a", &big).is_err());
        assert!(write_rdp(&dir, "a", "full address:s:x\0").is_err());
        assert!(!dir.join("rdp").join("a.rdp").exists());
        let _ = std::fs::remove_dir_all(&dir);
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
