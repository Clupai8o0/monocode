//! The relay end to end on real unix sockets: fake Claude sessions, a fake
//! host in process, and the files and sockets the link makes.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::link::{Link, Rpc, Shared};
use super::local::tests::temp_dir;
use super::local::{self, Env};

#[derive(Default)]
struct HostState {
    enabled: bool,
    /// Proxies to hand out: pid and the remote session each stands for.
    proxies: Vec<(u64, String)>,
    /// Puts an entry's socket somewhere else, which the Mac must refuse.
    wrong_folder: bool,
    syncs: Vec<Value>,
    sends: Vec<Value>,
    deliveries: Vec<Value>,
}

/// Answers relay.* the way host/relay.ts does, from what the test sets.
#[derive(Default)]
struct FakeHost {
    state: Mutex<HostState>,
    changed: Condvar,
}

impl FakeHost {
    fn with(&self, change: impl FnOnce(&mut HostState)) {
        change(&mut self.state.lock().unwrap());
        self.changed.notify_all();
    }

    fn entry(pid: u64, session: &str, sock_dir: &str) -> Value {
        json!({
            "pid": pid,
            "sessionId": session,
            "cwd": "/home/clupai/project",
            "startedAt": 1,
            "version": "relay",
            "peerProtocol": 1,
            "peerFeatures": [],
            "kind": "interactive",
            "entrypoint": "relay",
            "pidDomain": "relay:vivobook",
            "messagingSocketPath": format!("{sock_dir}/{pid}.sock"),
            "name": "laptop worker",
            "nameSource": "derived",
            "status": "idle",
            "updatedAt": 1,
            "statusUpdatedAt": 1,
            "monocodeRelay": {"machine": "vivobook", "account": ".claude", "remoteSessionId": session},
        })
    }

    /// Waits until `ready` holds, up to two seconds.
    fn wait_for(&self, ready: impl Fn(&HostState) -> bool) -> bool {
        let state = self.state.lock().unwrap();
        let (state, _) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(2), |s| !ready(s))
            .unwrap();
        ready(&state)
    }
}

impl Rpc for FakeHost {
    fn call(&self, method: &str, params: Value, _timeout: Duration) -> Result<Value, String> {
        let mut state = self.state.lock().unwrap();
        match method {
            "relay.sync" => {
                let sock_dir = params["sockDir"].as_str().unwrap_or("").to_string();
                state.syncs.push(params);
                self.changed.notify_all();
                if !state.enabled {
                    return Ok(json!({"enabled": false, "entries": [], "nextSyncMs": 20000}));
                }
                let folder = if state.wrong_folder {
                    "/elsewhere".into()
                } else {
                    sock_dir
                };
                let entries: Vec<Value> = state
                    .proxies
                    .iter()
                    .map(|(pid, session)| FakeHost::entry(*pid, session, &folder))
                    .collect();
                Ok(json!({"enabled": true, "entries": entries, "nextSyncMs": 3000}))
            }
            "relay.send" => {
                state.sends.push(params);
                self.changed.notify_all();
                Ok(json!({"accepted": true}))
            }
            "relay.next" => {
                let cursor = params["cursor"].as_u64().unwrap_or(0) as usize;
                // A short wait keeps the test quick; the real host holds 25 s.
                let (state, _) = self
                    .changed
                    .wait_timeout_while(state, Duration::from_millis(300), |s| {
                        s.deliveries.len() <= cursor
                    })
                    .unwrap();
                let fresh: Vec<Value> = state.deliveries.iter().skip(cursor).cloned().collect();
                Ok(json!({
                    "cursor": state.deliveries.len(),
                    "deliveries": fresh,
                    "enabled": state.enabled,
                }))
            }
            _ => Err(format!("unknown method {method}")),
        }
    }
}

/// A fake Claude session: a registry entry and a socket that hands every
/// connection's text to the test.
struct FakeSession {
    received: mpsc::Receiver<String>,
}

impl FakeSession {
    fn start(home: &Path, account: &str, id: &str, socket: &Path) -> FakeSession {
        let listener = UnixListener::bind(socket).unwrap();
        let (tx, received) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let mut text = String::new();
                    let _ = stream.read_to_string(&mut text);
                    if !text.is_empty() {
                        let _ = tx.send(text);
                    }
                });
            }
        });
        // A live pid: this test process.
        let entry = json!({
            "pid": std::process::id(),
            "sessionId": id,
            "cwd": "/Users/me/project",
            "name": format!("mac {id}"),
            "messagingSocketPath": socket,
            "kind": "interactive",
            "updatedAt": 1,
        });
        let dir = home.join(account).join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        // Two sessions of one process: name each file apart.
        let file = dir.join(format!("{}{}.json", std::process::id(), id.len()));
        std::fs::write(file, entry.to_string()).unwrap();
        FakeSession { received }
    }

    fn next(&self) -> Option<String> {
        self.received.recv_timeout(Duration::from_secs(3)).ok()
    }
}

fn env(home: &Path, ledger: PathBuf) -> Env {
    Env {
        home: home.to_path_buf(),
        sock_fallback: PathBuf::from("/nonexistent/cc-socks"),
        ledger: Some(ledger),
        machine: "mac".into(),
        alive: local::session_alive,
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn frame(from: &Path, id: &str) -> String {
    json!({
        "msgV": 1,
        "msg_id": id,
        "type": "user",
        "message": {"role": "user", "content": "<cross-session-message from=\"uds:x\">\nhi\n</cross-session-message>"},
        "priority": "next",
        "from": format!("uds:{}", from.display()),
    })
    .to_string()
}

#[test]
fn relays_lines_both_ways_through_real_sockets() {
    let dir = temp_dir();
    let home = dir.join("h");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(home.join(".claude-exec")).unwrap();
    let one_socket = dir.join("s1.sock");
    let one = FakeSession::start(&home, ".claude", "local-1", &one_socket);

    let shared = Arc::new(Shared::new(env(&home, dir.join("ledger.json"))));
    let host = Arc::new(FakeHost::default());
    host.with(|s| {
        s.enabled = true;
        s.proxies = vec![(1_000_000_001, "remote-1".into())];
    });
    let link = Link::new("m1".into(), "vivobook".into(), host.clone(), shared.clone());

    // Sync: the Mac offers its session, without pid or socket, and writes
    // the proxy into both accounts and listens on it.
    assert_eq!(link.sync_once(), Ok(true));
    let sync = host.state.lock().unwrap().syncs[0].clone();
    assert_eq!(sync["machine"], "mac");
    assert_eq!(sync["sockDir"], dir.to_str().unwrap());
    assert_eq!(
        sync["sessions"],
        json!([{"sessionId": "local-1", "account": ".claude", "name": "mac local-1",
                "cwd": "/Users/me/project", "kind": "interactive"}])
    );
    let proxy_socket = dir.join("1000000001.sock");
    let copies = [
        home.join(".claude/sessions/1000000001.json"),
        home.join(".claude-exec/sessions/1000000001.json"),
    ];
    for copy in &copies {
        let written: Value = serde_json::from_slice(&std::fs::read(copy).unwrap()).unwrap();
        assert_eq!(
            written,
            FakeHost::entry(1_000_000_001, "remote-1", dir.to_str().unwrap())
        );
        assert_eq!(mode(copy), 0o600);
    }
    assert_eq!(mode(&proxy_socket), 0o600);
    let status = link.status();
    assert!(status.connected && status.enabled);
    assert_eq!(status.proxies, 1);

    // The relay's own copies are never offered back as local sessions.
    assert_eq!(link.sync_once(), Ok(true));
    assert_eq!(
        host.state.lock().unwrap().syncs[1]["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // A session writes to the proxy: the auth line is dropped, the frame
    // goes to the host with the sender mapped to its session id.
    let line = frame(&one_socket, "m1");
    let mut stream = UnixStream::connect(&proxy_socket).unwrap();
    writeln!(stream, r#"{{"type":"auth","token":"secret"}}"#).unwrap();
    writeln!(stream, "{line}").unwrap();
    drop(stream);
    assert!(host.wait_for(|s| !s.sends.is_empty()));
    assert_eq!(
        host.state.lock().unwrap().sends[0],
        json!({"from": "local-1", "to": 1_000_000_001u64, "line": line})
    );

    // A sender the last sync did not know is found by reading again.
    let two_socket = dir.join("s2.sock");
    let _two = FakeSession::start(&home, ".claude-exec", "local-two", &two_socket);
    let line = frame(&two_socket, "m2");
    let mut stream = UnixStream::connect(&proxy_socket).unwrap();
    write!(stream, "{line}").unwrap();
    drop(stream);
    assert!(host.wait_for(|s| s.sends.len() == 2));
    assert_eq!(host.state.lock().unwrap().sends[1]["from"], "local-two");

    // A frame from no known session goes nowhere.
    let mut stream = UnixStream::connect(&proxy_socket).unwrap();
    writeln!(stream, "{}", frame(&dir.join("nobody.sock"), "m3")).unwrap();
    drop(stream);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(host.state.lock().unwrap().sends.len(), 2);

    // The host hands a line over: it reaches the local session's socket.
    link.spawn();
    host.with(|s| {
        s.deliveries
            .push(json!({"to": "local-1", "fromPid": 1_000_000_001u64, "line": "{\"reply\":1}"}))
    });
    assert_eq!(one.next().as_deref(), Some("{\"reply\":1}\n"));

    // From a proxy the Mac does not have yet: it syncs first, then delivers.
    host.with(|s| {
        s.proxies.push((1_000_000_002, "remote-2".into()));
        s.deliveries
            .push(json!({"to": "local-1", "fromPid": 1_000_000_002u64, "line": "{\"reply\":2}"}));
    });
    assert_eq!(one.next().as_deref(), Some("{\"reply\":2}\n"));
    assert!(dir.join("1000000002.sock").exists());
    assert!(home.join(".claude/sessions/1000000002.json").exists());

    // The host drops a session: its copies and socket go.
    host.with(|s| s.proxies.retain(|(pid, _)| *pid != 1_000_000_001));
    assert_eq!(link.sync_once(), Ok(true));
    assert!(copies.iter().all(|c| !c.exists()));
    assert!(!proxy_socket.exists());

    // The relay turned off: everything goes, real entries stay.
    host.with(|s| s.enabled = false);
    assert_eq!(link.sync_once(), Ok(false));
    assert!(!dir.join("1000000002.sock").exists());
    assert!(!home.join(".claude/sessions/1000000002.json").exists());
    assert_eq!(link.status().proxies, 0);
    assert_eq!(local::discover(&shared.env).len(), 2);

    link.shutdown();
    let ledger: Value =
        serde_json::from_slice(&std::fs::read(dir.join("ledger.json")).unwrap()).unwrap();
    assert_eq!(ledger["files"], json!([]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn refuses_bad_entries_and_cleans_up_on_shutdown() {
    let dir = temp_dir();
    let home = dir.join("h");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    let _session = FakeSession::start(&home, ".claude", "local-1", &dir.join("s1.sock"));
    let shared = Arc::new(Shared::new(env(&home, dir.join("ledger.json"))));
    let host = Arc::new(FakeHost::default());
    host.with(|s| {
        s.enabled = true;
        s.wrong_folder = true;
        s.proxies = vec![(1_000_000_009, "remote-9".into())];
    });
    let link = Link::new("m1".into(), "vivobook".into(), host.clone(), shared.clone());
    assert_eq!(link.sync_once(), Ok(true));
    assert_eq!(link.status().proxies, 0);
    assert!(!home.join(".claude/sessions/1000000009.json").exists());

    // Two hosts handing out one pid: the first keeps it.
    host.with(|s| s.wrong_folder = false);
    let other = Link::new("m2".into(), "lenovo".into(), host.clone(), shared.clone());
    assert_eq!(link.sync_once(), Ok(true));
    assert_eq!(other.sync_once(), Ok(true));
    assert_eq!((link.status().proxies, other.status().proxies), (1, 0));

    // A crash leaves the copies; the next start removes them.
    let copy = home.join(".claude/sessions/1000000009.json");
    assert!(copy.exists());
    let restarted = Shared::new(env(&home, dir.join("ledger.json")));
    std::mem::forget(link);
    restarted.clean_stale();
    assert!(!copy.exists());
    assert!(!dir.join("1000000009.sock").exists());
    other.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_sync_shows_its_error() {
    struct Down;
    impl Rpc for Down {
        fn call(&self, _: &str, _: Value, _: Duration) -> Result<Value, String> {
            Err("Machine is unreachable".into())
        }
    }
    let dir = temp_dir();
    let shared = Arc::new(Shared::new(env(&dir.join("h"), dir.join("ledger.json"))));
    let link = Link::new("m1".into(), "vivobook".into(), Arc::new(Down), shared);
    assert_eq!(link.sync_once(), Err("Machine is unreachable".into()));
    let status = link.status();
    assert!(!status.connected);
    assert_eq!(status.last_error.as_deref(), Some("Machine is unreachable"));
    assert_eq!(status.last_sync_at, None);
    link.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn offers_relay_only_for_the_paired_host() {
    let describe = json!({"environmentId": "env-1", "capabilities": ["lab.v1", "relay.v1"]});
    assert!(super::running::offers_relay(&describe, "env-1"));
    assert!(!super::running::offers_relay(&describe, "env-2"));
    assert!(!super::running::offers_relay(
        &json!({"environmentId": "env-1", "capabilities": ["lab.v1"]}),
        "env-1"
    ));
    assert!(super::is_relay_entry(&json!({"monocodeRelay": {}})));
    assert!(super::is_relay_entry(
        &json!({"pidDomain": "relay:vivobook"})
    ));
    assert!(!super::is_relay_entry(
        &json!({"pidDomain": "vivobook", "pid": 1})
    ));
}

/// Against a real host: MONOCODE_RELAY_TEST_ENDPOINT (e.g.
/// http://127.0.0.1:3774 through a tunnel), MONOCODE_RELAY_TEST_TOKEN and
/// MONOCODE_RELAY_TEST_ENV (its environment id). Run with
/// `cargo test fork_relay -- --ignored`. Offers no sessions (a temp home)
/// and checks the answers' shape; the token is never printed.
#[test]
#[ignore]
fn live_host_answers_relay_calls() {
    struct Live {
        endpoint: String,
        token: String,
        environment: String,
    }
    impl Rpc for Live {
        fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
            crate::remote::rpc_with_timeout(
                &self.endpoint,
                &self.token,
                Some(&self.environment),
                method,
                params,
                Some(timeout),
            )
        }
    }
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let live = Arc::new(Live {
        endpoint: var("MONOCODE_RELAY_TEST_ENDPOINT"),
        token: var("MONOCODE_RELAY_TEST_TOKEN"),
        environment: var("MONOCODE_RELAY_TEST_ENV"),
    });
    let describe = live
        .call("environment.describe", json!({}), Duration::from_secs(10))
        .expect("environment.describe");
    assert!(
        super::running::offers_relay(&describe, &live.environment),
        "the host does not offer relay.v1"
    );
    let dir = temp_dir();
    let home = dir.join("h");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    let shared = Arc::new(Shared::new(Env {
        sock_fallback: dir.clone(),
        machine: "relay-live-test".into(),
        ..env(&home, dir.join("ledger.json"))
    }));
    let link = Link::new("live".into(), "live".into(), live.clone(), shared);
    let enabled = link.sync_once().expect("relay.sync");
    let status = link.status();
    assert!(status.connected);
    eprintln!("relay on: {enabled}, proxies made here: {}", status.proxies);
    let next = live
        .call(
            "relay.next",
            json!({"cursor": 0, "waitMs": 0}),
            Duration::from_secs(35),
        )
        .expect("relay.next");
    assert!(next["cursor"].is_u64() && next["deliveries"].is_array());
    assert_eq!(next["enabled"].as_bool(), Some(enabled));
    link.shutdown();
    assert!(std::fs::read_dir(home.join(".claude/sessions"))
        .map(|d| d.count() == 0)
        .unwrap_or(true));
    let _ = std::fs::remove_dir_all(&dir);
}
