//! This Mac's side of the session folders: its own live Claude sessions (the
//! ones it offers to the host), and the relay entries it writes for sessions
//! elsewhere. Real entries are only ever read, never written or removed.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::is_relay_entry;

/// Proxy pids live in [1e9, 2e9): above any real pid, so no live process
/// can own one.
pub(crate) const PROXY_PID_MIN: u64 = 1_000_000_000;
pub(crate) const PROXY_PID_MAX: u64 = 2_000_000_000;
/// A registry entry is a few hundred bytes; anything far larger is not one.
const MAX_ENTRY_BYTES: usize = 16 * 1024;

/// What the relay reads from this machine; tests build their own.
pub(crate) struct Env {
    pub home: PathBuf,
    /// Claude's socket folder when no live session shows where it is.
    pub sock_fallback: PathBuf,
    /// Where the list of files this side wrote is kept, so a later start can
    /// clean what a crash left; None keeps no list.
    pub ledger: Option<PathBuf>,
    /// This machine's name, as the others see it.
    pub machine: String,
    pub alive: fn(i64) -> bool,
}

/// A session this machine offers, in the host's shape. No pid and no socket
/// path: those never leave this machine.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelaySession {
    pub session_id: String,
    pub account: String,
    pub name: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_session_id: Option<String>,
}

/// One live local session, with where it listens.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LocalSession {
    pub session: RelaySession,
    pub socket: PathBuf,
    updated_at: i64,
}

/// The account folders whose registries hold sessions: `.claude`,
/// `.claude-exec`, and an older `.claude-cx` only where it is still there.
const ACCOUNTS: [&str; 3] = [".claude", ".claude-exec", ".claude-cx"];

pub(crate) fn pid_alive(pid: i64) -> bool {
    if pid <= 0 || pid >= PROXY_PID_MIN as i64 {
        return false;
    }
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 only checks: EPERM still means the process exists.
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// `<digits>.json`, the only name Claude reads a registry entry from.
pub(crate) fn valid_entry_name(name: &str) -> bool {
    name.strip_suffix(".json")
        .is_some_and(|stem| !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()))
}

fn mirror_copies(home: &Path) -> HashSet<PathBuf> {
    std::fs::read_to_string(home.join(".local/state/session-mirror.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().map(|m| m.keys().map(PathBuf::from).collect()))
        .unwrap_or_default()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn parse_session(raw: &str, account: &str, alive: fn(i64) -> bool) -> Option<LocalSession> {
    let v: Value = serde_json::from_str(raw).ok()?;
    if is_relay_entry(&v)
        || v["spare"].as_bool() == Some(true)
        || !v["parkedJobId"].is_null()
        || v.get("peerProtocol").is_some_and(|p| p.as_u64() != Some(1))
    {
        return None;
    }
    let pid = v["pid"].as_i64()?;
    if !alive(pid) {
        return None;
    }
    let socket = text(&v["messagingSocketPath"])?;
    Some(LocalSession {
        session: RelaySession {
            session_id: text(&v["sessionId"])?,
            account: account.to_string(),
            name: text(&v["name"]).unwrap_or_default(),
            cwd: text(&v["cwd"])?,
            kind: text(&v["kind"]),
            status: text(&v["status"]),
            bridge_session_id: text(&v["bridgeSessionId"]),
        },
        socket: PathBuf::from(socket),
        updated_at: v["updatedAt"].as_i64().unwrap_or(0),
    })
}

/// Every live real session in this machine's account folders, one per
/// session id (the newest record wins), in a stable order.
pub(crate) fn discover(env: &Env) -> Vec<LocalSession> {
    let copies = mirror_copies(&env.home);
    let mut by_id: HashMap<String, LocalSession> = HashMap::new();
    for account in ACCOUNTS {
        let Ok(entries) = std::fs::read_dir(env.home.join(account).join("sessions")) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let named = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(valid_entry_name);
            if !named || copies.contains(&path) {
                continue;
            }
            let Some(session) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| parse_session(&raw, account, env.alive))
            else {
                continue;
            };
            match by_id.get(&session.session.session_id) {
                Some(old) if old.updated_at >= session.updated_at => {}
                _ => {
                    by_id.insert(session.session.session_id.clone(), session);
                }
            }
        }
    }
    let mut sessions: Vec<LocalSession> = by_id.into_values().collect();
    sessions.sort_by(|a, b| a.session.session_id.cmp(&b.session.session_id));
    sessions
}

/// Claude's socket folder: where the newest live session listens, else the
/// fallback (/tmp/cc-socks on a Mac).
pub(crate) fn sock_dir(sessions: &[LocalSession], fallback: &Path) -> PathBuf {
    sessions
        .iter()
        .max_by_key(|s| s.updated_at)
        .and_then(|s| s.socket.parent())
        .filter(|dir| dir.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| fallback.to_path_buf())
}

/// The folders relay entries go into: `.claude/sessions` and
/// `.claude-exec/sessions` where the account exists, `.claude-cx/sessions`
/// only where that folder already exists. Folders that are one folder
/// through a link are listed once.
pub(crate) fn entry_dirs(home: &Path) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    for account in ACCOUNTS {
        let root = home.join(account);
        let dir = root.join("sessions");
        let usable = if account == ".claude-cx" {
            dir.is_dir()
        } else {
            root.is_dir() && (dir.is_dir() || create_private_dir(&dir).is_ok())
        };
        if !usable {
            continue;
        }
        let real = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if seen.insert(real) {
            dirs.push(dir);
        }
    }
    dirs
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(dir)
}

/// Checks an entry the host built, and answers its pid. It must look exactly
/// like a relay copy that listens in this machine's socket folder.
pub(crate) fn validate_entry(entry: &Value, sock_dir: &Path) -> Result<u32, &'static str> {
    let pid = entry["pid"]
        .as_u64()
        .filter(|pid| (PROXY_PID_MIN..PROXY_PID_MAX).contains(pid))
        .ok_or("pid is outside the relay range")?;
    if !valid_entry_name(&format!("{pid}.json")) {
        return Err("bad file name");
    }
    if !entry["monocodeRelay"].is_object() {
        return Err("relay marker is missing");
    }
    if !entry["pidDomain"]
        .as_str()
        .is_some_and(|domain| domain.starts_with("relay:"))
    {
        return Err("pid domain is not a relay domain");
    }
    if text(&entry["sessionId"]).is_none() {
        return Err("session id is missing");
    }
    let socket = sock_dir.join(format!("{pid}.sock"));
    if entry["messagingSocketPath"].as_str() != socket.to_str() {
        return Err("socket path is not in this machine's socket folder");
    }
    if entry.to_string().len() > MAX_ENTRY_BYTES {
        return Err("entry is too large");
    }
    Ok(pid as u32)
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Writes `<dir>/<pid>.json` through a temp file and a rename, mode 0600.
/// Refuses to replace anything that is not a relay copy.
pub(crate) fn write_entry(dir: &Path, pid: u32, entry: &Value) -> Result<PathBuf, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let target = dir.join(format!("{pid}.json"));
    if target.exists() && !read_json(&target).is_some_and(|v| is_relay_entry(&v)) {
        return Err(format!("{} belongs to a real session", target.display()));
    }
    let temporary = dir.join(format!(".{pid}.json.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(entry.to_string().as_bytes())?;
        std::fs::rename(&temporary, &target)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(target)
}

/// Removes a relay copy; a real entry, or anything unreadable, stays.
pub(crate) fn remove_entry(path: &Path) {
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(valid_entry_name);
    if named && read_json(path).is_some_and(|v| is_relay_entry(&v)) {
        let _ = std::fs::remove_file(path);
    }
}

/// Removes a proxy socket file; only sockets, never a regular file.
pub(crate) fn remove_socket(path: &Path) {
    use std::os::unix::fs::FileTypeExt;
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket()) {
        let _ = std::fs::remove_file(path);
    }
}

/// The files this side wrote (entries and sockets), saved so a start after
/// a crash can remove them.
#[derive(Default)]
pub(crate) struct Ledger {
    path: Option<PathBuf>,
    files: BTreeSet<PathBuf>,
}

impl Ledger {
    pub fn load(path: Option<PathBuf>) -> Ledger {
        let files = path
            .as_deref()
            .and_then(read_json)
            .and_then(|v| {
                v["files"].as_array().map(|files| {
                    files
                        .iter()
                        .filter_map(Value::as_str)
                        .map(PathBuf::from)
                        .collect()
                })
            })
            .unwrap_or_default();
        Ledger { path, files }
    }

    pub fn add(&mut self, files: &[PathBuf]) {
        let before = self.files.len();
        self.files.extend(files.iter().cloned());
        if self.files.len() != before {
            self.save();
        }
    }

    pub fn forget(&mut self, files: &[PathBuf]) {
        let before = self.files.len();
        for file in files {
            self.files.remove(file);
        }
        if self.files.len() != before {
            self.save();
        }
    }

    /// Removes every file an earlier run left (relay copies and sockets
    /// only) and empties the list.
    pub fn clean(&mut self) {
        for file in std::mem::take(&mut self.files) {
            if file.extension().and_then(|e| e.to_str()) == Some("sock") {
                remove_socket(&file);
            } else {
                remove_entry(&file);
            }
        }
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let Some(dir) = path.parent() else {
            return;
        };
        let _ = std::fs::create_dir_all(dir);
        let files: Vec<&str> = self.files.iter().filter_map(|f| f.to_str()).collect();
        let body = serde_json::json!({ "files": files }).to_string();
        let temporary = dir.join(format!(".relay-written-{}.tmp", uuid::Uuid::new_v4()));
        if std::fs::write(&temporary, body).is_err() || std::fs::rename(&temporary, path).is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// A short folder under /tmp: a socket path is capped at 104 bytes on
    /// macOS.
    pub(crate) fn temp_dir() -> PathBuf {
        loop {
            let tag = uuid::Uuid::new_v4().simple().to_string();
            let dir = PathBuf::from(format!("/tmp/mcr-{}", &tag[..4]));
            if std::fs::create_dir(&dir).is_ok() {
                return dir;
            }
        }
    }

    fn env(home: &Path) -> Env {
        Env {
            home: home.to_path_buf(),
            sock_fallback: PathBuf::from("/tmp/cc-socks"),
            ledger: None,
            machine: "mac".into(),
            alive: |pid| pid < 100,
        }
    }

    fn write(path: &Path, value: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, value.to_string()).unwrap();
    }

    fn entry(pid: u64, sock_dir: &str) -> Value {
        json!({
            "pid": pid,
            "sessionId": "remote-1",
            "cwd": "/home/u/p",
            "pidDomain": "relay:vivobook",
            "messagingSocketPath": format!("{sock_dir}/{pid}.sock"),
            "monocodeRelay": {"machine": "vivobook", "account": ".claude", "remoteSessionId": "remote-1"},
        })
    }

    #[test]
    fn finds_only_live_real_sessions_once() {
        let home = temp_dir();
        let s = home.join(".claude/sessions");
        let real = |pid: i64, id: &str, updated: i64| {
            json!({
                "pid": pid, "sessionId": id, "cwd": "/p", "name": "worker",
                "messagingSocketPath": format!("/tmp/cc-socks/{pid}.sock"),
                "updatedAt": updated, "kind": "interactive", "bridgeSessionId": "b1",
            })
        };
        write(&s.join("1.json"), real(1, "one", 5));
        write(&s.join("2.json"), real(200, "dead", 5));
        write(&s.join("3.json"), {
            let mut v = real(3, "spare", 5);
            v["spare"] = json!(true);
            v
        });
        write(&s.join("4.json"), {
            let mut v = real(4, "parked", 5);
            v["parkedJobId"] = json!("job");
            v
        });
        write(
            &s.join("1000000005.json"),
            entry(1_000_000_005, "/tmp/cc-socks"),
        );
        write(&s.join("6.json"), {
            let mut v = real(6, "other-domain", 5);
            v["pidDomain"] = json!("relay:lenovo");
            v
        });
        write(&s.join("7.key"), real(7, "key", 5));
        write(&s.join("8.json"), {
            let mut v = real(8, "nosock", 5);
            v["messagingSocketPath"] = Value::Null;
            v
        });
        // The same session in the second account: the newer record wins.
        write(
            &home.join(".claude-exec/sessions/9.json"),
            real(9, "one", 9),
        );
        // An old .claude-cx folder is read too.
        write(
            &home.join(".claude-cx/sessions/10.json"),
            real(10, "ten", 1),
        );
        // A mirror copy is not a session of its own.
        let copy = home.join(".claude-exec/sessions/11.json");
        write(&copy, real(11, "copy", 99));
        write(
            &home.join(".local/state/session-mirror.json"),
            json!({ copy.to_str().unwrap(): "/orig" }),
        );
        let found = discover(&env(&home));
        let ids: Vec<(&str, &str)> = found
            .iter()
            .map(|s| (s.session.session_id.as_str(), s.session.account.as_str()))
            .collect();
        assert_eq!(ids, vec![("one", ".claude-exec"), ("ten", ".claude-cx")]);
        let sent = serde_json::to_value(&found[0].session).unwrap();
        assert_eq!(
            sent,
            json!({"sessionId": "one", "account": ".claude-exec", "name": "worker", "cwd": "/p",
                   "kind": "interactive", "bridgeSessionId": "b1"})
        );
        assert!(sent.get("pid").is_none() && sent.get("messagingSocketPath").is_none());
        assert_eq!(
            sock_dir(&found, Path::new("/fallback")),
            PathBuf::from("/tmp/cc-socks")
        );
        assert_eq!(
            sock_dir(&[], Path::new("/fallback")),
            PathBuf::from("/fallback")
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn entries_must_be_relay_copies_in_our_socket_folder() {
        let dir = Path::new("/tmp/cc-socks");
        assert_eq!(
            validate_entry(&entry(1_000_000_123, "/tmp/cc-socks"), dir),
            Ok(1_000_000_123)
        );
        assert_eq!(
            validate_entry(&entry(1_999_999_999, "/tmp/cc-socks"), dir),
            Ok(1_999_999_999)
        );
        for pid in [123, 999_999_999, 2_000_000_000] {
            assert!(
                validate_entry(&entry(pid, "/tmp/cc-socks"), dir).is_err(),
                "{pid}"
            );
        }
        let mut no_marker = entry(1_000_000_001, "/tmp/cc-socks");
        no_marker.as_object_mut().unwrap().remove("monocodeRelay");
        assert!(validate_entry(&no_marker, dir).is_err());
        let mut domain = entry(1_000_000_001, "/tmp/cc-socks");
        domain["pidDomain"] = json!("vivobook");
        assert!(validate_entry(&domain, dir).is_err());
        assert!(validate_entry(&entry(1_000_000_001, "/run/user/1000/cc-socks"), dir).is_err());
        let mut elsewhere = entry(1_000_000_001, "/tmp/cc-socks");
        elsewhere["messagingSocketPath"] = json!("/tmp/cc-socks/1000000002.sock");
        assert!(validate_entry(&elsewhere, dir).is_err());
        let mut sneaky = entry(1_000_000_001, "/tmp/cc-socks");
        sneaky["messagingSocketPath"] = json!("/tmp/cc-socks/../x/1000000001.sock");
        assert!(validate_entry(&sneaky, dir).is_err());
        let mut fractional = entry(1_000_000_001, "/tmp/cc-socks");
        fractional["pid"] = json!(1_000_000_001.5);
        assert!(validate_entry(&fractional, dir).is_err());
        let mut big = entry(1_000_000_001, "/tmp/cc-socks");
        big["name"] = json!("x".repeat(20_000));
        assert!(validate_entry(&big, dir).is_err());
        assert!(valid_entry_name("123.json"));
        for name in ["a.json", ".json", "12.json.tmp", "12.key", "1-2.json"] {
            assert!(!valid_entry_name(name), "{name}");
        }
    }

    #[test]
    fn writes_private_copies_and_never_touches_real_entries() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_dir();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".claude-exec")).unwrap();
        let dirs = entry_dirs(&home);
        assert_eq!(
            dirs,
            vec![
                home.join(".claude/sessions"),
                home.join(".claude-exec/sessions")
            ]
        );
        std::fs::create_dir_all(home.join(".claude-cx/sessions")).unwrap();
        assert_eq!(entry_dirs(&home).len(), 3);
        let value = entry(1_000_000_001, "/tmp/cc-socks");
        let path = write_entry(&dirs[0], 1_000_000_001, &value).unwrap();
        assert_eq!(path, dirs[0].join("1000000001.json"));
        assert_eq!(read_json(&path), Some(value.clone()));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // Rewriting a relay copy is fine.
        write_entry(&dirs[0], 1_000_000_001, &value).unwrap();
        // A real entry at that name stays as it is.
        let real = dirs[1].join("1000000001.json");
        write(&real, json!({"pid": 1_000_000_001, "sessionId": "x"}));
        assert!(write_entry(&dirs[1], 1_000_000_001, &value).is_err());
        remove_entry(&real);
        assert!(real.exists());
        remove_entry(&path);
        assert!(!path.exists());
        // No temp files are left behind.
        let left: Vec<_> = std::fs::read_dir(&dirs[0]).unwrap().flatten().collect();
        assert!(left.is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_new_start_cleans_what_an_earlier_run_wrote() {
        let home = temp_dir();
        let dir = home.join(".claude/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let ledger_path = home.join("state/relay-written.json");
        let copy = write_entry(&dir, 1_000_000_007, &entry(1_000_000_007, "/x")).unwrap();
        let real = dir.join("42.json");
        write(&real, json!({"pid": 42, "sessionId": "real"}));
        let socket = home.join("1000000007.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        drop(listener);
        let plain = home.join("1000000008.sock");
        std::fs::write(&plain, "not a socket").unwrap();
        {
            let mut ledger = Ledger::load(Some(ledger_path.clone()));
            ledger.add(&[copy.clone(), real.clone(), socket.clone(), plain.clone()]);
        }
        let mut ledger = Ledger::load(Some(ledger_path.clone()));
        assert_eq!(ledger.files.len(), 4);
        ledger.clean();
        assert!(!copy.exists() && !socket.exists());
        assert!(real.exists() && plain.exists());
        assert!(Ledger::load(Some(ledger_path)).files.is_empty());
        let _ = std::fs::remove_dir_all(home);
    }
}
