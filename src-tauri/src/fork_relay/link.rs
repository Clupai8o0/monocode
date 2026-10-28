//! One host's relay on this Mac: syncs this Mac's sessions to the host,
//! keeps a proxy (registry entry + listening socket) for every session the
//! host offers back, sends what local sessions write to a proxy, and
//! delivers what the host hands over.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use super::local::{self, Env, Ledger, LocalSession, PROXY_PID_MAX, PROXY_PID_MIN};
use super::wire;

const SYNC_TIMEOUT: Duration = Duration::from_secs(30);
/// `relay.next` waits up to 25 s on the host; the request allows for more.
const NEXT_TIMEOUT: Duration = Duration::from_secs(35);
const NEXT_WAIT_MS: u64 = 25_000;
const SYNC_ON: Duration = Duration::from_secs(3);
const SYNC_OFF: Duration = Duration::from_secs(20);
const SYNC_BACKOFF: Duration = Duration::from_secs(30);
/// Past this without a sync the host counts this Mac gone, so its proxies
/// go too.
const SILENT_LIMIT: Duration = Duration::from_secs(45);
/// Claude's sender closes about 150 ms after writing; the relay does the same.
const CLOSE_AFTER: Duration = Duration::from_millis(200);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 64;

static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

/// A call to the host's /rpc, so tests can stand in a fake host.
pub(crate) trait Rpc: Send + Sync {
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String>;
}

/// What every link on this Mac shares: where to read and write, who owns
/// which proxy pid, and the list of files written.
pub(crate) struct Shared {
    pub env: Env,
    owners: Mutex<HashMap<u32, String>>,
    ledger: Mutex<Ledger>,
}

impl Shared {
    pub fn new(env: Env) -> Shared {
        let ledger = Ledger::load(env.ledger.clone());
        Shared {
            env,
            owners: Mutex::default(),
            ledger: Mutex::new(ledger),
        }
    }

    /// Removes the relay copies and sockets an earlier run left.
    pub fn clean_stale(&self) {
        lock(&self.ledger).clean();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// One proxy: its entry as written, the files holding it, and its socket.
struct Proxy {
    entry: Value,
    files: Vec<PathBuf>,
    listener: Listener,
}

#[derive(Default)]
struct State {
    enabled: bool,
    connected: bool,
    last_sync_at: Option<i64>,
    last_ok: Option<Instant>,
    last_error: Option<String>,
    next_sync: Option<Duration>,
    sessions: Vec<LocalSession>,
    proxies: HashMap<u32, Proxy>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostStatus {
    pub machine_id: String,
    pub name: String,
    pub connected: bool,
    pub proxies: usize,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    #[serde(skip)]
    pub enabled: bool,
}

pub(crate) struct Link {
    pub id: String,
    pub name: String,
    rpc: Arc<dyn Rpc>,
    shared: Arc<Shared>,
    me: Weak<Link>,
    state: Mutex<State>,
    sync_lock: Mutex<()>,
    stop: AtomicBool,
    sync_now: AtomicBool,
    signal: (Mutex<()>, Condvar),
}

impl Link {
    pub fn new(id: String, name: String, rpc: Arc<dyn Rpc>, shared: Arc<Shared>) -> Arc<Link> {
        Arc::new_cyclic(|me| Link {
            id,
            name,
            rpc,
            shared,
            me: me.clone(),
            state: Mutex::default(),
            sync_lock: Mutex::new(()),
            stop: AtomicBool::new(false),
            sync_now: AtomicBool::new(false),
            signal: (Mutex::new(()), Condvar::new()),
        })
    }

    /// Runs the sync loop and the delivery loop, each on its own thread.
    pub fn spawn(self: &Arc<Self>) {
        let link = self.clone();
        std::thread::spawn(move || link.run_sync());
        let link = self.clone();
        std::thread::spawn(move || link.run_next());
    }

    /// Stops both loops and removes every proxy.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.notify();
        self.teardown();
    }

    pub fn status(&self) -> HostStatus {
        let state = lock(&self.state);
        HostStatus {
            machine_id: self.id.clone(),
            name: self.name.clone(),
            connected: state.connected,
            proxies: state.proxies.len(),
            last_sync_at: state.last_sync_at,
            last_error: state.last_error.clone(),
            enabled: state.enabled,
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn notify(&self) {
        let _guard = lock(&self.signal.0);
        self.signal.1.notify_all();
    }

    /// Sleeps up to `limit`, waking early on stop or when `until` holds.
    fn nap(&self, limit: Duration, until: impl Fn(&Link) -> bool) {
        let deadline = Instant::now() + limit;
        let mut guard = lock(&self.signal.0);
        while !self.stopped() && !until(self) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            guard = self
                .signal
                .1
                .wait_timeout(guard, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn run_sync(&self) {
        while !self.stopped() {
            self.sync_now.store(false, Ordering::SeqCst);
            let wait = match self.sync_once() {
                Ok(true) => lock(&self.state).next_sync.unwrap_or(SYNC_ON),
                Ok(false) => SYNC_OFF,
                Err(_) => SYNC_BACKOFF,
            };
            self.nap(wait, |link| link.sync_now.load(Ordering::SeqCst));
        }
    }

    fn run_next(&self) {
        let mut cursor: u64 = 0;
        while !self.stopped() {
            if !lock(&self.state).enabled {
                self.nap(SYNC_OFF, |link| lock(&link.state).enabled);
                continue;
            }
            let answer = self.rpc.call(
                "relay.next",
                json!({ "cursor": cursor, "waitMs": NEXT_WAIT_MS }),
                NEXT_TIMEOUT,
            );
            let Ok(answer) = answer else {
                self.nap(Duration::from_secs(5), |_| false);
                continue;
            };
            cursor = answer["cursor"].as_u64().unwrap_or(cursor);
            if answer["enabled"].as_bool() == Some(false) {
                // The sync loop tears the proxies down on its next pass.
                self.sync_now.store(true, Ordering::SeqCst);
                self.notify();
                self.nap(SYNC_OFF, |_| false);
                continue;
            }
            for delivery in answer["deliveries"].as_array().into_iter().flatten() {
                if self.stopped() {
                    return;
                }
                self.deliver(delivery);
            }
        }
    }

    /// One `relay.sync`: offers this Mac's sessions and makes the proxies
    /// match the answer. Answers whether the relay is on.
    pub fn sync_once(&self) -> Result<bool, String> {
        let _one_at_a_time = lock(&self.sync_lock);
        if self.stopped() {
            return Err("The relay stopped".into());
        }
        let env = &self.shared.env;
        let sessions = local::discover(env);
        let sock_dir = local::sock_dir(&sessions, &env.sock_fallback);
        let offered: Vec<&local::RelaySession> = sessions.iter().map(|s| &s.session).collect();
        let params = json!({
            "machine": env.machine,
            "sockDir": sock_dir.to_string_lossy(),
            "sessions": offered,
        });
        let answer = match self.rpc.call("relay.sync", params, SYNC_TIMEOUT) {
            Ok(answer) if answer["enabled"].is_boolean() => Ok(answer),
            Ok(_) => Err("Invalid relay answer".to_string()),
            Err(error) => Err(error),
        };
        let answer = answer.inspect_err(|error| self.sync_failed(error.clone()))?;
        let enabled = answer["enabled"].as_bool() == Some(true);
        {
            let mut state = lock(&self.state);
            state.sessions = sessions;
            state.connected = true;
            state.last_sync_at = Some(now_ms());
            state.last_ok = Some(Instant::now());
            state.last_error = None;
            state.next_sync = answer["nextSyncMs"]
                .as_u64()
                .map(|ms| Duration::from_millis(ms.clamp(1_000, 60_000)));
        }
        if enabled {
            let entries = answer["entries"].as_array().cloned().unwrap_or_default();
            self.apply(&entries, &sock_dir);
        } else {
            self.teardown();
        }
        let was = std::mem::replace(&mut lock(&self.state).enabled, enabled);
        if was != enabled {
            self.notify();
        }
        Ok(enabled)
    }

    fn sync_failed(&self, error: String) {
        let silent = {
            let mut state = lock(&self.state);
            state.connected = false;
            state.last_error = Some(error);
            state.last_ok.is_none_or(|ok| ok.elapsed() > SILENT_LIMIT)
        };
        if silent {
            self.teardown();
        }
    }

    /// Makes the proxies exactly the valid entries in `entries`.
    fn apply(&self, entries: &[Value], sock_dir: &Path) {
        let mut wanted: HashMap<u32, &Value> = HashMap::new();
        for entry in entries {
            if let Ok(pid) = local::validate_entry(entry, sock_dir) {
                wanted.insert(pid, entry);
            }
        }
        let mut state = lock(&self.state);
        let gone: Vec<u32> = state
            .proxies
            .keys()
            .filter(|pid| !wanted.contains_key(pid))
            .copied()
            .collect();
        for pid in gone {
            if let Some(proxy) = state.proxies.remove(&pid) {
                self.remove_proxy(pid, proxy);
            }
        }
        let dirs = local::entry_dirs(&self.shared.env.home);
        for (pid, entry) in wanted {
            match state.proxies.get_mut(&pid) {
                Some(proxy) if proxy.entry == *entry => {}
                Some(proxy) => {
                    // Same proxy, new details (a rename, a status): rewrite
                    // the files; the socket stays.
                    let files = write_everywhere(&dirs, pid, entry);
                    lock(&self.shared.ledger).add(&files);
                    proxy.entry = entry.clone();
                    proxy.files = files;
                }
                None => {
                    if let Some(proxy) = self.add_proxy(&dirs, pid, entry, sock_dir) {
                        state.proxies.insert(pid, proxy);
                    }
                }
            }
        }
    }

    fn add_proxy(
        &self,
        dirs: &[PathBuf],
        pid: u32,
        entry: &Value,
        sock_dir: &Path,
    ) -> Option<Proxy> {
        {
            // Another host may have handed out the same pid; the first wins.
            let mut owners = lock(&self.shared.owners);
            match owners.get(&pid) {
                Some(owner) if *owner != self.id => return None,
                _ => {
                    owners.insert(pid, self.id.clone());
                }
            }
        }
        let socket = sock_dir.join(format!("{pid}.sock"));
        // The socket goes on the list first, so a crash right after binding
        // still leaves it to be cleaned.
        lock(&self.shared.ledger).add(std::slice::from_ref(&socket));
        let listener = match Listener::bind(&socket, pid, self.me.clone()) {
            Ok(listener) => listener,
            Err(_) => {
                lock(&self.shared.ledger).forget(std::slice::from_ref(&socket));
                lock(&self.shared.owners).remove(&pid);
                return None;
            }
        };
        let files = write_everywhere(dirs, pid, entry);
        lock(&self.shared.ledger).add(&files);
        Some(Proxy {
            entry: entry.clone(),
            files,
            listener,
        })
    }

    fn remove_proxy(&self, pid: u32, proxy: Proxy) {
        for file in &proxy.files {
            local::remove_entry(file);
        }
        let socket = PathBuf::from(proxy.entry["messagingSocketPath"].as_str().unwrap_or(""));
        // Dropping the listener removes its socket.
        drop(proxy.listener);
        let mut written = proxy.files;
        written.push(socket);
        lock(&self.shared.ledger).forget(&written);
        let mut owners = lock(&self.shared.owners);
        if owners.get(&pid) == Some(&self.id) {
            owners.remove(&pid);
        }
    }

    /// Removes every proxy this link made.
    fn teardown(&self) {
        let proxies: Vec<(u32, Proxy)> = lock(&self.state).proxies.drain().collect();
        for (pid, proxy) in proxies {
            self.remove_proxy(pid, proxy);
        }
        lock(&self.state).enabled = false;
    }

    fn has_proxy(&self, pid: u32) -> bool {
        lock(&self.state).proxies.contains_key(&pid)
    }

    /// The local session `find` picks, reading the registries again once
    /// when the last sync did not know it.
    fn local_session(&self, find: impl Fn(&LocalSession) -> bool) -> Option<LocalSession> {
        if let Some(found) = lock(&self.state).sessions.iter().find(|s| find(s)) {
            return Some(found.clone());
        }
        let fresh = local::discover(&self.shared.env);
        let found = fresh.iter().find(|s| find(s)).cloned();
        lock(&self.state).sessions = fresh;
        found
    }

    /// A line a local session wrote to proxy `to`: on to the host.
    fn forward(&self, to: u32, from: &Path, line: String) {
        let Some(sender) = self.local_session(|s| same_socket(&s.socket, from)) else {
            return;
        };
        let params = json!({ "from": sender.session.session_id, "to": to, "line": line });
        let _ = self.rpc.call("relay.send", params, SYNC_TIMEOUT);
    }

    /// A line from the host: write it to the local session it is for, from
    /// the proxy that stands for its sender, so replies come back there.
    fn deliver(&self, delivery: &Value) {
        let (Some(to), Some(from_pid), Some(line)) = (
            delivery["to"].as_str(),
            delivery["fromPid"]
                .as_u64()
                .filter(|pid| (PROXY_PID_MIN..PROXY_PID_MAX).contains(pid))
                .map(|pid| pid as u32),
            delivery["line"].as_str(),
        ) else {
            return;
        };
        if line.len() > wire::MAX_LINE || line.contains('\n') {
            return;
        }
        if !self.has_proxy(from_pid) {
            let _ = self.sync_once();
            if !self.has_proxy(from_pid) {
                return;
            }
        }
        let Some(target) = self.local_session(|s| s.session.session_id == to) else {
            return;
        };
        let Ok(mut stream) = UnixStream::connect(&target.socket) else {
            return;
        };
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        if stream.write_all(&bytes).is_ok() {
            std::thread::spawn(move || {
                std::thread::sleep(CLOSE_AFTER);
                drop(stream);
            });
        }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Paths name the same socket: the same string, or the same file once links
/// such as /tmp -> /private/tmp are resolved.
fn same_socket(a: &Path, b: &Path) -> bool {
    a == b
        || match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
}

fn write_everywhere(dirs: &[PathBuf], pid: u32, entry: &Value) -> Vec<PathBuf> {
    dirs.iter()
        .filter_map(|dir| local::write_entry(dir, pid, entry).ok())
        .collect()
}

/// A proxy's listening socket. Dropping it stops the accept thread and
/// removes the socket file.
struct Listener {
    path: PathBuf,
    stop: Arc<AtomicBool>,
}

impl Listener {
    fn bind(path: &Path, pid: u32, link: Weak<Link>) -> std::io::Result<Listener> {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::symlink_metadata(path).is_ok() {
            if UnixStream::connect(path).is_ok() {
                return Err(std::io::ErrorKind::AddrInUse.into());
            }
            // A dead socket file at a relay pid: nothing real uses that range.
            local::remove_socket(path);
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else {
                    continue;
                };
                if CONNECTIONS.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let link = link.clone();
                std::thread::spawn(move || {
                    serve(stream, pid, link);
                    CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Ok(Listener {
            path: path.to_path_buf(),
            stop,
        })
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes the blocked accept so the thread sees the stop.
        let _ = UnixStream::connect(&self.path);
        local::remove_socket(&self.path);
    }
}

/// One connection to a proxy: every frame line is sent on, the auth line
/// and anything else that is not from a local socket dropped.
fn serve(stream: UnixStream, pid: u32, link: Weak<Link>) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    wire::read_lines(&stream, |line| {
        let Some(from) = wire::sender(&line) else {
            return;
        };
        if let Some(link) = link.upgrade() {
            if !link.stopped() {
                link.forward(pid, &from, line);
            }
        }
    });
}
