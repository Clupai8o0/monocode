//! Fork feature: the agent time zone. The owner can pick a zone for every
//! agent and terminal the desktop starts, or follow this Mac's own zone (the
//! default; nothing is set and children read /etc/localtime themselves).
//! The pick is kept in `<app_data_dir>/fork-agent-time-zone.json`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE_NAME: &str = "fork-agent-time-zone.json";
const ZONEINFO: &str = "/usr/share/zoneinfo";
pub const CHANGED_EVENT: &str = "fork-agent-tz-changed";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTz {
    zone: Option<String>,
    system_zone: Option<String>,
    effective_zone: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    zone: Option<String>,
}

/// The picked zone, loaded from disk the first time it is asked for.
static PICKED: Mutex<Option<Option<String>>> = Mutex::new(None);

/// The zone name rule shared with the host and the web side: 1-64 chars,
/// segments of [A-Za-z0-9_+-] joined by "/", no empty segment, no ".".
pub(crate) fn valid_zone_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.split('/').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
        })
}

fn installed_in(root: &Path, name: &str) -> bool {
    valid_zone_name(name) && root.join(name).is_file()
}

fn installed(name: &str) -> bool {
    cfg!(unix) && installed_in(Path::new(ZONEINFO), name)
}

/// The zone name in an /etc/localtime link target: the part after the last
/// "zoneinfo/", when it follows the zone rule.
pub(crate) fn zone_from_link(target: &str) -> Option<String> {
    let (_, name) = target.rsplit_once("zoneinfo/")?;
    valid_zone_name(name).then(|| name.to_string())
}

/// This Mac's zone right now, read fresh each time.
pub fn system_zone() -> Option<String> {
    let target = std::fs::read_link("/etc/localtime").ok()?;
    zone_from_link(&target.to_string_lossy())
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn load_from(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    let stored: Stored = serde_json::from_str(&text).ok()?;
    stored.zone.filter(|zone| valid_zone_name(zone))
}

fn save_to(dir: &Path, zone: Option<&str>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stored = Stored {
        zone: zone.map(str::to_string),
    };
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    let path = dir.join(FILE_NAME);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn stored_zone(app: &AppHandle) -> Option<String> {
    let mut picked = PICKED.lock().unwrap_or_else(PoisonError::into_inner);
    if picked.is_none() {
        *picked = Some(data_dir(app).and_then(|dir| load_from(&dir)));
    }
    picked.clone().flatten()
}

/// The picked zone while it is still installed, else None (follow this Mac).
pub fn picked_zone(app: &AppHandle) -> Option<String> {
    stored_zone(app).filter(|zone| installed(zone))
}

/// Adds TZ to a child's environment when a zone is picked. When none is
/// picked nothing is set, and an inherited TZ is left as it is.
pub fn apply(app: &AppHandle, cmd: &mut std::process::Command) {
    apply_zone(picked_zone(app).as_deref(), cmd);
}

fn apply_zone(zone: Option<&str>, cmd: &mut std::process::Command) {
    if let Some(zone) = zone {
        cmd.env("TZ", zone);
    }
}

fn payload(zone: Option<String>, system_zone: Option<String>) -> AgentTz {
    let effective_zone = zone.clone().or_else(|| system_zone.clone());
    AgentTz {
        zone,
        system_zone,
        effective_zone,
    }
}

fn check_zone(root: &Path, zone: Option<&str>) -> Result<(), String> {
    if !cfg!(unix) {
        return Err("Picking an agent time zone works on macOS and Linux only".into());
    }
    match zone {
        Some(name) if !valid_zone_name(name) => Err(format!("Not a time zone name: {name}")),
        Some(name) if !installed_in(root, name) => Err(format!("Unknown time zone: {name}")),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn fork_agent_tz_get(app: AppHandle) -> AgentTz {
    // The zone children really get: a pick whose zone file has gone reads
    // as following this Mac, as apply() treats it.
    payload(picked_zone(&app), system_zone())
}

#[tauri::command]
pub fn fork_agent_tz_set(app: AppHandle, zone: Option<String>) -> Result<AgentTz, String> {
    let zone = zone.map(|z| z.trim().to_string()).filter(|z| !z.is_empty());
    check_zone(Path::new(ZONEINFO), zone.as_deref())?;
    let dir = data_dir(&app).ok_or("Could not find the app's data folder")?;
    let mut picked = PICKED.lock().unwrap_or_else(PoisonError::into_inner);
    save_to(&dir, zone.as_deref())?;
    *picked = Some(zone.clone());
    drop(picked);
    let result = payload(zone, system_zone());
    let _ = app.emit(CHANGED_EVENT, &result);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("monocode-fork-tz-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn zone_rule() {
        for good in [
            "UTC",
            "Asia/Kolkata",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+5",
            "Etc/GMT-14",
        ] {
            assert!(valid_zone_name(good), "{good}");
        }
        let long = "A".repeat(65);
        for bad in [
            "",
            "/UTC",
            "Asia/",
            "Asia//Kolkata",
            "../etc/passwd",
            "Asia/Kol.kata",
            "UTC ",
            "Asia\\X",
            long.as_str(),
        ] {
            assert!(!valid_zone_name(bad), "{bad}");
        }
        assert!(valid_zone_name(&"A".repeat(64)));
    }

    #[test]
    fn link_parsing() {
        assert_eq!(
            zone_from_link("/var/db/timezone/zoneinfo/Asia/Kolkata").as_deref(),
            Some("Asia/Kolkata")
        );
        assert_eq!(
            zone_from_link("../usr/share/zoneinfo/Australia/Melbourne").as_deref(),
            Some("Australia/Melbourne")
        );
        assert_eq!(
            zone_from_link("/usr/share/zoneinfo/UTC").as_deref(),
            Some("UTC")
        );
        assert_eq!(zone_from_link("garbage"), None);
        assert_eq!(zone_from_link("/usr/share/zoneinfo/"), None);
        assert_eq!(zone_from_link("/usr/share/zoneinfo/../x"), None);
    }

    #[test]
    fn storage_round_trip() {
        let dir = temp_dir("store");
        assert_eq!(load_from(&dir), None);
        save_to(&dir, Some("Asia/Kolkata")).unwrap();
        assert_eq!(load_from(&dir).as_deref(), Some("Asia/Kolkata"));
        save_to(&dir, None).unwrap();
        assert_eq!(load_from(&dir), None);
        std::fs::write(dir.join(FILE_NAME), r#"{"zone":"../etc"}"#).unwrap();
        assert_eq!(load_from(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn validation_against_installed_zones() {
        let root = temp_dir("zoneinfo");
        std::fs::create_dir_all(root.join("Asia")).unwrap();
        std::fs::write(root.join("Asia/Kolkata"), b"TZif").unwrap();
        assert!(check_zone(&root, Some("Asia/Kolkata")).is_ok());
        assert!(check_zone(&root, None).is_ok());
        assert_eq!(
            check_zone(&root, Some("Foo/Bar")).unwrap_err(),
            "Unknown time zone: Foo/Bar"
        );
        assert!(check_zone(&root, Some("Asia")).is_err());
        assert!(check_zone(&root, Some("a.b")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn payload_falls_back_to_system() {
        let p = payload(None, Some("Asia/Kolkata".into()));
        assert_eq!(p.effective_zone.as_deref(), Some("Asia/Kolkata"));
        let p = payload(Some("UTC".into()), Some("Asia/Kolkata".into()));
        assert_eq!(p.effective_zone.as_deref(), Some("UTC"));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["systemZone"], "Asia/Kolkata");
        assert_eq!(json["effectiveZone"], "UTC");
    }

    #[test]
    fn env_gets_tz_only_when_picked() {
        let has_tz = |cmd: &std::process::Command| cmd.get_envs().any(|(key, _)| key == "TZ");
        let mut cmd = std::process::Command::new("true");
        apply_zone(None, &mut cmd);
        assert!(!has_tz(&cmd));
        apply_zone(Some("Asia/Kolkata"), &mut cmd);
        let tz = cmd
            .get_envs()
            .find(|(key, _)| *key == "TZ")
            .and_then(|(_, v)| v);
        assert_eq!(tz, Some(std::ffi::OsStr::new("Asia/Kolkata")));
    }
}
