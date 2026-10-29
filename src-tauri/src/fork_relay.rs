//! Fork feature: the relay, this Mac's side. Claude sessions in the main and
//! cx accounts on different machines message each other through a paired
//! host (the hub, `host/relay.ts`). For every session elsewhere the host
//! builds a registry entry; this Mac writes it into each account's sessions
//! folder and listens on its socket, so the session shows in ListAgents like
//! a local one. Lines written to that socket go to the host (`relay.send`);
//! lines the host hands over (`relay.next`) are written to the local
//! session's own socket. Nothing here starts, stops or reads a session's
//! transcript, and no pid or socket path leaves this Mac.

use std::sync::OnceLock;

use serde_json::Value;

/// Whether a session registry entry is a relay copy, which readers of the
/// session folders skip (`isRelayEntry` in labProtocol.ts).
pub(crate) fn is_relay_entry(entry: &Value) -> bool {
    entry.get("monocodeRelay").is_some()
        || entry["pidDomain"]
            .as_str()
            .is_some_and(|domain| domain.starts_with("relay:"))
}

/// This Mac's name as sent to a host (`machine` in `relay.sync`). Read once:
/// it can take a subprocess, and answers poll it every few seconds.
pub(crate) fn machine_name() -> String {
    names().0.clone()
}

/// This Mac's name as a host stores it in its relay copies
/// (`monocodeRelay.machine`, `cleanMachine` in host/relay.ts), so the message
/// log's `Resolved.machine` finds this Mac's answers.
pub(crate) fn relay_machine_name() -> String {
    names().1.clone()
}

fn names() -> &'static (String, String) {
    static NAMES: OnceLock<(String, String)> = OnceLock::new();
    NAMES.get_or_init(|| {
        let device = crate::remote_ssh::device_name();
        let raw = device
            .strip_prefix("MonoCode on ")
            .map(str::to_string)
            .unwrap_or_else(|| device.clone());
        // The host falls back to the paired device's name, cleaned.
        let cleaned = clean_machine(&raw, &clean_machine(&device, "peer"));
        (raw, cleaned)
    })
}

/// `cleanMachine` in host/relay-core.ts: every run of characters outside
/// A-Z a-z 0-9 . _ - becomes "-", leading and trailing "-" go, then the first
/// 64 characters; `fallback` when nothing is left.
pub(crate) fn clean_machine(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut gap = false;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('-');
    }
    let name: String = out.trim_matches('-').chars().take(64).collect();
    if name.is_empty() {
        fallback.to_string()
    } else {
        name
    }
}

#[cfg(unix)]
mod link;
#[cfg(unix)]
pub(crate) mod traffic;
#[cfg(unix)]
mod local;
#[cfg(all(test, unix))]
mod tests;
#[cfg(unix)]
mod wire;

#[cfg(unix)]
pub use running::{start, stop};
#[cfg(unix)]
pub use traffic::{RelayTrafficAnswer, RelayTrafficParams};
#[cfg(not(unix))]
pub use fallback::{RelayTrafficAnswer, RelayTrafficParams};

#[cfg(not(unix))]
mod fallback {
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Default, Deserialize)]
    pub struct RelayTrafficParams {
        pub since: Option<crate::fork_messages::Since>,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RelayTrafficAnswer {
        pub version: u8,
        pub machine: String,
        pub epoch: String,
        pub cursor: u64,
        pub enabled: bool,
        pub hops: Vec<serde_json::Value>,
    }
}

/// The relay on this Mac: whether it is on with any host, and each host's
/// link.
#[tauri::command]
pub fn fork_relay_status() -> Value {
    #[cfg(unix)]
    {
        running::status()
    }
    #[cfg(not(unix))]
    {
        serde_json::json!({ "enabled": false, "hosts": [] })
    }
}

/// What the relay on this Mac did with the lines it carried.
#[tauri::command]
pub async fn fork_relay_traffic(params: Option<RelayTrafficParams>) -> Result<RelayTrafficAnswer, String> {
    let since = params.and_then(|p| p.since);
    tauri::async_runtime::spawn_blocking(move || relay_traffic(since))
        .await
        .map_err(|e| e.to_string())
}

fn relay_traffic(since: Option<crate::fork_messages::Since>) -> RelayTrafficAnswer {
    #[cfg(unix)]
    {
        let enabled = running::status()["enabled"].as_bool().unwrap_or(false);
        traffic::answer(since.as_ref(), relay_machine_name(), enabled)
    }
    #[cfg(not(unix))]
    {
        let _ = since;
        RelayTrafficAnswer {
            version: 1,
            machine: relay_machine_name(),
            epoch: String::new(),
            cursor: 0,
            enabled: false,
            hops: Vec::new(),
        }
    }
}

#[cfg(unix)]
mod running {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use tauri::{AppHandle, Manager};

    use super::link::{Link, Rpc, Shared};
    use super::local::{self, Env};
    use crate::remote::{self, RemoteConnections};

    const RELAY_CAPABILITY: &str = "relay.v1";
    /// How often the paired machines are checked for new or gone hosts.
    const REFRESH_EVERY: Duration = Duration::from_secs(15);
    /// A host without the relay is asked again after this.
    const RECHECK_AFTER: Duration = Duration::from_secs(120);
    const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(10);

    struct Relay {
        shared: Arc<Shared>,
        links: Mutex<HashMap<String, Arc<Link>>>,
        stop: AtomicBool,
        signal: (Mutex<()>, Condvar),
    }

    static RELAY: Mutex<Option<Arc<Relay>>> = Mutex::new(None);

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The host's /rpc for one paired machine, read from the machine store
    /// on every call, through its SSH tunnel when it has one.
    struct MachineRpc {
        app: AppHandle,
        machine_id: String,
    }

    impl Rpc for MachineRpc {
        fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
            let state = self.app.state::<RemoteConnections>();
            let machine = {
                let _guard = state
                    .store
                    .lock()
                    .map_err(|_| "Connection store is locked")?;
                remote::read(&remote::store_path(&self.app)?)?
                    .into_iter()
                    .find(|m| m.id == self.machine_id)
                    .ok_or("Machine is no longer connected")?
            };
            let lease = match &machine.ssh {
                Some(target) => Some(state.tunnels.endpoint(&machine.id, target)?),
                None => None,
            };
            let endpoint = lease
                .as_ref()
                .map(|lease| lease.endpoint.as_str())
                .unwrap_or(&machine.endpoint);
            let result = remote::rpc_with_timeout(
                endpoint,
                &machine.token,
                Some(&machine.environment_id),
                method,
                params,
                Some(timeout),
            );
            if let (Some(lease), Err(error)) = (&lease, &result) {
                if error.starts_with("Machine is unreachable") {
                    state.tunnels.invalidate(&machine.id, lease);
                }
            }
            result
        }
    }

    /// Runs in setup: cleans what an earlier run left, then keeps one link
    /// per paired host that offers the relay.
    pub fn start(app: &AppHandle) {
        let ledger = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("relay-written.json"));
        let env = Env {
            home: crate::dirs_home().map(PathBuf::from).unwrap_or_default(),
            sock_fallback: PathBuf::from("/tmp/cc-socks"),
            ledger,
            machine: String::new(),
            alive: local::session_alive,
        };
        if env.home.as_os_str().is_empty() {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            // The name can take a subprocess; it is not worth holding setup.
            let env = Env {
                machine: super::machine_name(),
                ..env
            };
            let shared = Arc::new(Shared::new(env));
            shared.clean_stale();
            let relay = Arc::new(Relay {
                shared,
                links: Mutex::default(),
                stop: AtomicBool::new(false),
                signal: (Mutex::new(()), Condvar::new()),
            });
            {
                let mut slot = lock(&RELAY);
                if slot.is_some() {
                    return;
                }
                *slot = Some(relay.clone());
            }
            supervise(&app, &relay);
        });
    }

    /// On app exit: stops every link and removes every proxy, synchronously.
    pub fn stop() {
        let Some(relay) = lock(&RELAY).take() else {
            return;
        };
        relay.stop.store(true, Ordering::SeqCst);
        {
            let _guard = lock(&relay.signal.0);
            relay.signal.1.notify_all();
        }
        let links: Vec<Arc<Link>> = lock(&relay.links).drain().map(|(_, l)| l).collect();
        for link in links {
            link.shutdown();
        }
        relay.shared.clean_stale();
    }

    pub fn status() -> Value {
        let relay = lock(&RELAY).clone();
        let mut hosts: Vec<_> = relay
            .map(|relay| lock(&relay.links).values().map(|l| l.status()).collect())
            .unwrap_or_default();
        hosts.sort_by(|a: &super::link::HostStatus, b| a.name.cmp(&b.name));
        json!({
            "enabled": hosts.iter().any(|h| h.enabled),
            "hosts": hosts,
        })
    }

    fn supervise(app: &AppHandle, relay: &Arc<Relay>) {
        // Per machine: whether it offers the relay, and when that was asked.
        let mut checked: HashMap<String, (bool, Instant)> = HashMap::new();
        while !relay.stop.load(Ordering::SeqCst) {
            refresh(app, relay, &mut checked);
            let guard = lock(&relay.signal.0);
            let _ = relay
                .signal
                .1
                .wait_timeout_while(guard, REFRESH_EVERY, |_| !relay.stop.load(Ordering::SeqCst));
        }
    }

    /// Starts a link for each paired host that offers the relay and stops
    /// the links of hosts that went away or stopped offering it.
    fn refresh(
        app: &AppHandle,
        relay: &Arc<Relay>,
        checked: &mut HashMap<String, (bool, Instant)>,
    ) {
        let machines = {
            let state = app.state::<RemoteConnections>();
            let Ok(_guard) = state.store.lock() else {
                return;
            };
            match remote::store_path(app).and_then(|path| remote::read(&path)) {
                Ok(machines) => machines,
                Err(_) => return,
            }
        };
        checked.retain(|id, _| machines.iter().any(|m| &m.id == id));
        let mut wanted: HashMap<String, String> = HashMap::new();
        for machine in &machines {
            let running = lock(&relay.links).contains_key(&machine.id);
            let fresh = checked
                .get(&machine.id)
                .is_some_and(|(_, at)| at.elapsed() < RECHECK_AFTER);
            if !running && !fresh {
                let rpc = MachineRpc {
                    app: app.clone(),
                    machine_id: machine.id.clone(),
                };
                let offers = rpc
                    .call("environment.describe", json!({}), DESCRIBE_TIMEOUT)
                    .is_ok_and(|d| offers_relay(&d, &machine.environment_id));
                checked.insert(machine.id.clone(), (offers, Instant::now()));
            }
            if running || checked.get(&machine.id).is_some_and(|(offers, _)| *offers) {
                wanted.insert(machine.id.clone(), machine.name.clone());
            }
        }
        let mut links = lock(&relay.links);
        // Checked under the lock stop() drains, so no link outlives it.
        if relay.stop.load(Ordering::SeqCst) {
            return;
        }
        let gone: Vec<String> = links
            .keys()
            .filter(|id| !wanted.contains_key(*id))
            .cloned()
            .collect();
        for id in gone {
            if let Some(link) = links.remove(&id) {
                link.shutdown();
            }
        }
        for (id, name) in wanted {
            if links.contains_key(&id) {
                continue;
            }
            let rpc = Arc::new(MachineRpc {
                app: app.clone(),
                machine_id: id.clone(),
            });
            let link = Link::new(id.clone(), name, rpc, relay.shared.clone());
            link.spawn();
            links.insert(id, link);
        }
    }

    /// The host is the one paired (same environment) and offers relay.v1.
    pub(super) fn offers_relay(describe: &Value, environment_id: &str) -> bool {
        describe["environmentId"].as_str() == Some(environment_id)
            && describe["capabilities"]
                .as_array()
                .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some(RELAY_CAPABILITY)))
    }
}

#[cfg(test)]
mod name_tests {
    use super::clean_machine;

    /// The same table is in host/relay-core.test.ts for `cleanMachine`.
    #[test]
    fn cleans_names_like_the_host() {
        let x63 = "x".repeat(63);
        let cases: [(&str, &str, String); 8] = [
            ("Samridh’s MacBook Pro", "peer", "Samridh-s-MacBook-Pro".into()),
            ("  --a b--  ", "peer", "a-b".into()),
            ("émile's mac", "peer", "mile-s-mac".into()),
            ("MonoCode desktop", "peer", "MonoCode-desktop".into()),
            ("host.local_1", "peer", "host.local_1".into()),
            ("!!!", "peer", "peer".into()),
            (&"a".repeat(70), "peer", "a".repeat(64)),
            (&format!("{x63} y"), "peer", format!("{x63}-")),
        ];
        for (name, fallback, want) in cases {
            assert_eq!(clean_machine(name, fallback), want, "{name}");
        }
    }
}
