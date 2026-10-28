//! Remote host connections. The renderer receives machine metadata, never the
//! saved bearer credential. Workspace requests never fall back to local calls.
use crate::remote_ssh::{self, Job, JobView, SshTarget, Tunnel, Tunnels};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct RemoteConnections {
    store: Mutex<()>,
    tunnels: Tunnels,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl RemoteConnections {
    pub fn shutdown(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                job.cancel();
            }
        }
        self.tunnels.clear();
    }
    fn job(&self, id: &str) -> Result<Arc<Job>, String> {
        self.jobs
            .lock()
            .map_err(|_| "Connection setup is unavailable")?
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection setup has expired".into())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMachine {
    id: String,
    name: String,
    endpoint: String,
    environment_id: String,
    token: String,
    #[serde(default)]
    ssh: Option<SshTarget>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    id: String,
    name: String,
    endpoint: String,
    environment_id: String,
    ssh: Option<SshTarget>,
}

impl StoredMachine {
    fn public(&self) -> Machine {
        Machine {
            id: self.id.clone(),
            name: self.name.clone(),
            endpoint: self.endpoint.clone(),
            environment_id: self.environment_id.clone(),
            ssh: self.ssh.clone(),
        }
    }
}

fn endpoint(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value.trim()).map_err(|_| "Enter a valid host URL")?;
    let host = url.host_str().ok_or("Host URL has no hostname")?;
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return Err("Use HTTPS, or an HTTP loopback address forwarded through SSH".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Host URL must contain only the scheme, hostname, and port".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn read(path: &Path) -> Result<Vec<StoredMachine>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Remote connection store is invalid".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write(path: &Path, machines: &[StoredMachine]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing connection directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!("remote-machines-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(machines).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// Hosts split large session syncs into pieces below this cap
/// (`host/sync-transfer.ts`), so it bounds memory without limiting transcripts.
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Ceiling for a caller's longer timeout, such as a held `sessions.sync`.
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A pool left idle past this is dropped before the next request. After the
/// Mac sleeps or changes network its sockets are likely dead, and a request
/// sent on one could stall until it times out.
const POOL_IDLE_RESET: Duration = Duration::from_secs(45);

/// One agent for every host request, so calls reuse kept-alive connections
/// instead of paying a fresh TCP and TLS handshake each time.
struct Pool {
    agent: ureq::Agent,
    generation: u64,
    /// Wall-clock time, not `Instant`: on macOS `Instant` stops while the
    /// machine sleeps, which is exactly the idle time that matters here.
    last_used: SystemTime,
}

static POOL: Mutex<Option<Pool>> = Mutex::new(None);

fn new_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(5))
        .timeout(REQUEST_TIMEOUT)
        .build()
}

/// A clock that went backwards says nothing about the sockets, so it resets too.
fn pool_is_stale(last_used: SystemTime, now: SystemTime) -> bool {
    now.duration_since(last_used)
        .map_or(true, |idle| idle > POOL_IDLE_RESET)
}

/// The shared agent and its generation, building a new one first when there
/// is none or it has been idle too long.
fn checkout(
    slot: &mut Option<Pool>,
    now: SystemTime,
    build: impl FnOnce() -> ureq::Agent,
) -> (ureq::Agent, u64) {
    let pool = match slot {
        Some(pool) if !pool_is_stale(pool.last_used, now) => pool,
        _ => {
            let generation = slot.as_ref().map_or(0, |pool| pool.generation + 1);
            slot.insert(Pool {
                agent: build(),
                generation,
                last_used: now,
            })
        }
    };
    pool.last_used = now;
    (pool.agent.clone(), pool.generation)
}

/// Marks the pool used again when a request ends, so a long request is not
/// counted as idle time. A broken transport drops the pool, so the retry the
/// user is offered starts on a fresh connection. A newer pool is left alone.
fn checkin(slot: &mut Option<Pool>, generation: u64, now: SystemTime, broken: bool) {
    if slot
        .as_ref()
        .is_some_and(|pool| pool.generation == generation)
    {
        if broken {
            *slot = None;
        } else if let Some(pool) = slot.as_mut() {
            pool.last_used = now;
        }
    }
}

fn pool() -> std::sync::MutexGuard<'static, Option<Pool>> {
    POOL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn rpc(
    endpoint: &str,
    token: &str,
    environment_id: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    rpc_with_timeout(endpoint, token, environment_id, method, params, None)
}

fn rpc_with_timeout(
    endpoint: &str,
    token: &str,
    environment_id: Option<&str>,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let (agent, generation) = checkout(&mut pool(), SystemTime::now(), new_agent);
    let result = send_rpc(
        &agent,
        endpoint,
        token,
        environment_id,
        method,
        params,
        timeout,
    );
    checkin(
        &mut pool(),
        generation,
        SystemTime::now(),
        matches!(result, Err(RpcFailure::Transport(_))),
    );
    result.map_err(|failure| match failure {
        RpcFailure::Transport(message) | RpcFailure::Reply(message) => message,
    })
}

enum RpcFailure {
    /// The connection failed; its socket may be dead.
    Transport(String),
    /// The host answered, but not with a result.
    Reply(String),
}

fn send_rpc(
    agent: &ureq::Agent,
    endpoint: &str,
    token: &str,
    environment_id: Option<&str>,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, RpcFailure> {
    use RpcFailure::{Reply, Transport};
    let payload = json!({ "version": 1, "environmentId": environment_id, "method": method, "params": params });
    let response = agent
        .post(&format!("{endpoint}/rpc"))
        .timeout(
            timeout
                .unwrap_or(REQUEST_TIMEOUT)
                .clamp(REQUEST_TIMEOUT, MAX_REQUEST_TIMEOUT),
        )
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&payload.to_string());
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(error)) if connection_refused(&error) => {
            return Err(Transport(
                "Machine is unreachable. Check the host and SSH tunnel, then reconnect.".into(),
            ))
        }
        Err(_) => {
            return Err(Transport(
                "The host request did not complete. Retry to confirm its result.".into(),
            ))
        }
    };
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Transport(e.to_string()))?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(Reply("Host response is too large".into()));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| Reply("Invalid host response".into()))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(Reply(format!("Host rejected request: {error}")));
    }
    if status != 200 {
        return Err(Reply(format!("Host returned HTTP {status}")));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| Reply("Invalid host response".into()))
}

// Only a refused connection proves the local forwarding listener is gone.
// A slow request or an interrupted response says nothing about SSH health.
fn connection_refused(error: &ureq::Transport) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = source {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return true;
        }
        source = error.source();
    }
    false
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("remote-machines.json"))
}

#[tauri::command(async)]
pub fn remote_machines(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
) -> Result<Vec<Machine>, String> {
    let _guard = state
        .store
        .lock()
        .map_err(|_| "Connection store is locked")?;
    Ok(read(&store_path(&app)?)?
        .iter()
        .map(StoredMachine::public)
        .collect())
}

#[tauri::command(async)]
pub fn remote_connect(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    name: String,
    url: String,
    token: String,
) -> Result<Machine, String> {
    let endpoint = endpoint(&url)?;
    let token = token.trim().to_string();
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Enter the device token issued by monocode-host pair".into());
    }
    let descriptor = rpc(&endpoint, &token, None, "environment.describe", json!({}))?;
    if descriptor.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("This host uses an incompatible protocol version".into());
    }
    let environment_id = descriptor
        .get("environmentId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Host identity is missing")?
        .to_string();
    let name = if name.trim().is_empty() {
        descriptor
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Remote machine")
            .to_string()
    } else {
        name.trim().chars().take(100).collect()
    };
    let _guard = state
        .store
        .lock()
        .map_err(|_| "Connection store is locked")?;
    let path = store_path(&app)?;
    let mut machines = read(&path)?;
    let existing = machines.iter().find(|m| m.environment_id == environment_id);
    let id = existing
        .map(|m| m.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let machine = StoredMachine {
        id: id.clone(),
        name,
        endpoint,
        environment_id,
        token,
        ssh: existing.and_then(|m| m.ssh.clone()),
    };
    machines.retain(|m| m.id != id);
    machines.push(machine.clone());
    write(&path, &machines)?;
    Ok(machine.public())
}

#[tauri::command(async)]
pub fn remote_disconnect(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    machine_id: String,
) -> Result<(), String> {
    let _guard = state
        .store
        .lock()
        .map_err(|_| "Connection store is locked")?;
    let path = store_path(&app)?;
    let mut machines = read(&path)?;
    machines.retain(|m| m.id != machine_id);
    write(&path, &machines)?;
    state.tunnels.remove(&machine_id);
    Ok(())
}

#[tauri::command(async)]
pub fn remote_request(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    machine_id: String,
    method: String,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    if !supported_remote_method(&method) {
        return Err("Unsupported remote operation".into());
    }
    let machine = {
        let _guard = state
            .store
            .lock()
            .map_err(|_| "Connection store is locked")?;
        read(&store_path(&app)?)?
            .into_iter()
            .find(|m| m.id == machine_id)
            .ok_or("Machine is no longer connected")?
    };
    let tunnel_lease = if let Some(target) = &machine.ssh {
        Some(state.tunnels.endpoint(&machine.id, target)?)
    } else {
        None
    };
    let endpoint = tunnel_lease
        .as_ref()
        .map(|lease| lease.endpoint.as_str())
        .unwrap_or(&machine.endpoint);
    let response = rpc_with_timeout(
        endpoint,
        &machine.token,
        Some(&machine.environment_id),
        &method,
        params,
        timeout_ms.map(Duration::from_millis),
    );
    if response
        .as_ref()
        .err()
        .is_some_and(|error| error.starts_with("Machine is unreachable"))
    {
        if let Some(lease) = &tunnel_lease {
            state.tunnels.invalidate(&machine.id, lease);
        }
    }
    let result = response?;
    if method == "environment.describe"
        && result.get("environmentId").and_then(Value::as_str)
            != Some(machine.environment_id.as_str())
    {
        return Err("Host identity changed. Add this machine again before continuing.".into());
    }
    Ok(result)
}

fn supported_remote_method(method: &str) -> bool {
    matches!(
        method,
        "environment.describe"
            | "projects.list"
            | "projects.browse"
            | "projects.open"
            | "models.list"
            | "sessions.list"
            | "sessions.update"
            | "sessions.delete"
            | "sessions.sync"
            | "sessions.syncChunk"
            | "commands.dispatch"
            | "attachments.upload"
            | "attachments.read"
            | "devices.revokeSelf"
            | "git.diff"
            | "git.branches"
            | "git.switch"
            | "git.createBranch"
            | "git.worktrees"
            | "git.worktreeCreate"
            | "files.read"
            | "files.list"
            | "files.index"
            | "workspace.run"
            | "files.search"
            | "files.searchContent"
            | "files.create"
            | "files.write"
            | "git.index"
            | "git.fileDiff"
            | "git.action"
            | "externalSessions.list"
            | "externalSessions.read"
    )
}

fn start_ssh_job(
    app: AppHandle,
    target: SshTarget,
    name: String,
    existing: Option<StoredMachine>,
    upgrade: bool,
) -> Result<String, String> {
    let job = Job::new();
    let id = job.view().id;
    {
        let state = app.state::<RemoteConnections>();
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| "Connection setup is unavailable")?;
        if jobs.values().any(|job| !job.view().done) {
            return Err(
                "Another SSH connection is being set up. Finish or cancel it first.".into(),
            );
        }
        jobs.retain(|_, job| !job.view().done);
        jobs.insert(id.clone(), job.clone());
    }
    std::thread::spawn(move || {
        let prepared = (|| -> Result<(StoredMachine, Tunnel), String> {
            let askpass = job.askpass()?;
            let mut target = target;
            let mut machine = if let Some(mut existing) = existing {
                if upgrade {
                    let platform = remote_ssh::detect_platform(&target, &job, &askpass)?;
                    job.message("Updating MonoCode Host on the machine…");
                    let output = remote_ssh::run_script(
                        &target,
                        platform,
                        remote_ssh::upgrade_script(platform, target.remote_port),
                        &job,
                        &askpass,
                    )?;
                    let info: Value = serde_json::from_str(output.lines().last().unwrap_or(""))
                        .map_err(|_| "Host update returned an invalid response")?;
                    target.remote_port = info
                        .get("port")
                        .and_then(Value::as_u64)
                        .and_then(|v| u16::try_from(v).ok())
                        .filter(|p| *p > 0)
                        .ok_or("Host did not report a valid port")?;
                    existing.ssh = Some(target.clone());
                } else {
                    job.message("Reconnecting to the machine…");
                }
                existing
            } else {
                let platform = remote_ssh::detect_platform(&target, &job, &askpass)?;
                job.message("Installing or starting MonoCode Host…");
                let output = remote_ssh::run_script(
                    &target,
                    platform,
                    remote_ssh::bootstrap_script(platform),
                    &job,
                    &askpass,
                )?;
                let info: Value = serde_json::from_str(output.lines().last().unwrap_or(""))
                    .map_err(|_| "Host setup returned an invalid response")?;
                target.remote_port = info
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok())
                    .filter(|p| *p > 0)
                    .ok_or("Host did not report a valid port")?;
                job.message("Pairing this desktop with the host…");
                let pair = remote_ssh::run_script(
                    &target,
                    platform,
                    remote_ssh::pairing_script(platform, &remote_ssh::device_name()),
                    &job,
                    &askpass,
                )?;
                let pair: Value = serde_json::from_str(pair.lines().last().unwrap_or(""))
                    .map_err(|_| "Host pairing returned an invalid response")?;
                let token = pair
                    .get("token")
                    .and_then(Value::as_str)
                    .filter(|s| {
                        s.len() == 43
                            && s.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    })
                    .ok_or("Host returned an invalid device credential")?
                    .to_string();
                let environment_id = pair
                    .get("environmentId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("Host identity is missing")?
                    .to_string();
                StoredMachine {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    endpoint: format!("ssh://{}", target.target),
                    environment_id,
                    token,
                    ssh: Some(target.clone()),
                }
            };
            job.message("Opening the secure connection…");
            let tunnel = Tunnel::start(&target, Some(&job), Some(&askpass))?;
            let descriptor = rpc(
                &format!("http://127.0.0.1:{}", tunnel.port),
                &machine.token,
                Some(&machine.environment_id),
                "environment.describe",
                json!({}),
            )?;
            if descriptor.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
                return Err("This host uses an incompatible protocol version".into());
            }
            if descriptor.get("environmentId").and_then(Value::as_str)
                != Some(&machine.environment_id)
            {
                return Err(
                    "Host identity changed. Remove this connection and add the machine again."
                        .into(),
                );
            }
            if upgrade {
                let capabilities = descriptor.get("capabilities").and_then(Value::as_array);
                let supports = |name: &str| {
                    capabilities.is_some_and(|entries| {
                        entries.iter().any(|entry| entry.as_str() == Some(name))
                    })
                };
                if !supports("git.index")
                    || !supports("files.list")
                    || !supports("files.create")
                    || !supports("files.searchContent")
                {
                    return Err("The installed host package still lacks Explorer and Changes. Install a newer MonoCode release with updated host packages.".into());
                }
            }
            if machine.name.trim().is_empty() {
                machine.name = descriptor
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&target.target)
                    .chars()
                    .take(100)
                    .collect();
            }
            Ok((machine, tunnel))
        })();
        job.complete(|| {
            let (mut machine, tunnel) = prepared?;
            let state = app.state::<RemoteConnections>();
            let _guard = state
                .store
                .lock()
                .map_err(|_| "Connection store is locked")?;
            let path = store_path(&app)?;
            let mut machines = read(&path)?;
            if let Some(old) = machines
                .iter()
                .find(|m| m.environment_id == machine.environment_id)
            {
                machine.id = old.id.clone();
            }
            machines.retain(|m| m.id != machine.id);
            machines.push(machine.clone());
            write(&path, &machines)?;
            state.tunnels.insert(machine.id.clone(), tunnel);
            Ok(machine.public())
        });
    });
    Ok(id)
}

#[tauri::command(async)]
pub fn remote_ssh_begin(
    app: AppHandle,
    target: String,
    name: String,
    port: Option<u16>,
) -> Result<String, String> {
    let target = remote_ssh::validate_target(&target, port)?;
    start_ssh_job(
        app,
        SshTarget {
            target,
            port,
            remote_port: 3774,
        },
        name.trim().chars().take(100).collect(),
        None,
        false,
    )
}

#[tauri::command(async)]
pub fn remote_ssh_reconnect(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    machine_id: String,
    upgrade: Option<bool>,
) -> Result<String, String> {
    let machine = {
        let _guard = state
            .store
            .lock()
            .map_err(|_| "Connection store is locked")?;
        read(&store_path(&app)?)?
            .into_iter()
            .find(|m| m.id == machine_id)
            .ok_or("Machine is no longer connected")?
    };
    let target = machine
        .ssh
        .clone()
        .ok_or("This connection does not use SSH")?;
    start_ssh_job(
        app,
        target,
        machine.name.clone(),
        Some(machine),
        upgrade.unwrap_or(false),
    )
}

#[tauri::command]
pub fn remote_ssh_poll(
    state: State<'_, RemoteConnections>,
    job_id: String,
) -> Result<JobView, String> {
    Ok(state.job(&job_id)?.view())
}

#[tauri::command]
pub fn remote_ssh_answer(
    state: State<'_, RemoteConnections>,
    job_id: String,
    prompt_id: String,
    answer: String,
) -> Result<(), String> {
    state.job(&job_id)?.answer(&prompt_id, answer)
}

#[tauri::command]
pub fn remote_ssh_cancel(
    state: State<'_, RemoteConnections>,
    job_id: String,
) -> Result<(), String> {
    state.job(&job_id)?.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_shared_pool_resets_after_idling_or_a_broken_connection() {
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let mut slot = None;
        let (_, first) = checkout(&mut slot, start, new_agent);
        // Used again within the idle window: the same agent is reused.
        let (_, reused) = checkout(&mut slot, start + Duration::from_secs(40), new_agent);
        assert_eq!(reused, first);
        // A long request ending counts as use, so idling starts from there.
        checkin(&mut slot, first, start + Duration::from_secs(80), false);
        let (_, after_long) = checkout(&mut slot, start + Duration::from_secs(120), new_agent);
        assert_eq!(after_long, first);
        // Idle past the limit, as after the Mac sleeps: a new agent.
        let (_, idle) = checkout(&mut slot, start + Duration::from_secs(166), new_agent);
        assert_ne!(idle, first);
        // A clock that went backwards resets too.
        let (_, backwards) = checkout(&mut slot, start, new_agent);
        assert_ne!(backwards, idle);
        // A stale request's failure leaves the newer pool alone...
        checkin(&mut slot, idle, start, true);
        assert!(slot.is_some());
        // ...and the current pool's failure drops it.
        checkin(&mut slot, backwards, start, true);
        assert!(slot.is_none());
        assert!(!pool_is_stale(start, start + POOL_IDLE_RESET));
        assert!(pool_is_stale(
            start,
            start + POOL_IDLE_RESET + Duration::from_millis(1)
        ));
    }
    #[test]
    fn a_slow_host_does_not_look_like_a_dead_tunnel() {
        use std::{net::TcpListener, thread, time::Duration};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(200));
        });
        let error = ureq::get(&url)
            .timeout(Duration::from_millis(50))
            .call()
            .unwrap_err();
        let ureq::Error::Transport(error) = error else {
            panic!("Expected a timeout")
        };
        assert!(!connection_refused(&error));
        server.join().unwrap();
        // A freed ephemeral port can be claimed by another parallel fixture.
        // Exercise ureq's actual wrapped I/O source without that port race.
        let error = ureq::Error::from(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        let ureq::Error::Transport(error) = error else {
            panic!("Expected a refused connection")
        };
        assert!(connection_refused(&error));
    }

    #[test]
    fn desktop_forwards_supported_host_operations() {
        for method in [
            "git.branches",
            "git.switch",
            "git.createBranch",
            "git.worktrees",
            "git.worktreeCreate",
            "attachments.upload",
            "attachments.read",
        ] {
            assert!(supported_remote_method(method), "{method}");
        }
        assert!(!supported_remote_method("git.arbitrary"));
    }
    #[test]
    fn endpoints_require_an_encrypted_route_and_no_embedded_secrets() {
        assert_eq!(
            endpoint("http://127.0.0.1:3774/").unwrap(),
            "http://127.0.0.1:3774"
        );
        assert!(endpoint("http://[::1]:3774").is_ok());
        assert!(endpoint("https://host.example").is_ok());
        for url in [
            "http://192.168.1.5:3774",
            "file:///tmp/socket",
            "https://user:secret@host.example",
            "https://host.example/rpc",
            "https://host.example?token=secret",
            "https://host.example#secret",
        ] {
            assert!(endpoint(url).is_err(), "{url}");
        }
    }
    #[test]
    fn public_machine_metadata_never_contains_the_token() {
        let stored = StoredMachine {
            id: "id".into(),
            name: "server".into(),
            endpoint: "https://host.example".into(),
            environment_id: "env".into(),
            token: "secret".into(),
            ssh: None,
        };
        let value = serde_json::to_string(&stored.public()).unwrap();
        assert!(!value.contains("secret"));
        assert!(!value.contains("token"));
    }
}
