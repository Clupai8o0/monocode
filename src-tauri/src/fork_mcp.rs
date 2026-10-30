//! Fork: an MCP server so outside agents (Codex, dsh, grok) can list, read,
//! start and message MonoCode sessions.
//!
//! `monocode mcp` speaks MCP over stdio and forwards each call to the running
//! app's local control port, where the same actions as `/operator` run. Nothing
//! is reachable until the owner creates a client in Settings. Each client has
//! its own token, stored only as a hash, a level and a list of projects. Delete
//! and archive are never exposed. Every call is logged without its prompt.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CLIENTS_FILE: &str = "fork-mcp-clients.json";
const LOG_FILE: &str = "fork-mcp-log.jsonl";
pub const ENDPOINT_FILE: &str = "fork-mcp-endpoint";
const MAX_LOG_LINES: usize = 500;
const PROTOCOL_VERSION: &str = "2025-06-18";
const WHOAMI: &str = "mcp.whoami";

// Read-change-write has to be whole, or a save could bring back a revoked client
// or lose a log line. One process owns these files: the app.
static CLIENTS_LOCK: Mutex<()> = Mutex::new(());
static LOG_LOCK: Mutex<()> = Mutex::new(());
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

const READ_ACTIONS: [&str; 2] = ["sessions.list", "sessions.read"];
const ACT_ACTIONS: [&str; 8] = [
    "sessions.start",
    "sessions.send",
    "sessions.stop",
    "device.list",
    "device.screenshot",
    "device.tap",
    "device.swipe",
    "device.type",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// List and read sessions.
    Read,
    /// Also start, message and stop them, at supervised permissions at most.
    Supervised,
    /// The same, including sessions with full access.
    Full,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: String,
    pub name: String,
    pub level: Level,
    pub projects: Vec<String>,
    pub token_hash: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at: u64,
    pub client: String,
    pub action: String,
    /// The session or project it touched. Never the prompt.
    pub target: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Readable by this user only: it's the list of what can reach the app.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Unique, so two writers can never share a half-written file.
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

pub fn load_clients(dir: &Path) -> Vec<Client> {
    std::fs::read(dir.join(CLIENTS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_clients(dir: &Path, clients: &[Client]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(clients).map_err(|e| e.to_string())?;
    write_private(&dir.join(CLIENTS_FILE), &text)
}

/// Returns the new client and its token, which is never stored or shown again.
pub fn create_client(
    dir: &Path,
    name: &str,
    level: Level,
    projects: Vec<String>,
) -> Result<(Client, String), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err("Give the client a name of up to 64 characters".into());
    }
    if projects.is_empty() {
        return Err("Choose at least one project".into());
    }
    let _guard = CLIENTS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut clients = load_clients(dir);
    if clients.iter().any(|client| client.name == name) {
        return Err(format!("A client called {name} already exists"));
    }
    let token = format!(
        "mcm_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let client = Client {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: name.to_string(),
        level,
        projects,
        token_hash: hash_token(&token),
        created_at: now_ms(),
    };
    clients.push(client.clone());
    save_clients(dir, &clients)?;
    Ok((client, token))
}

pub fn revoke_client(dir: &Path, id: &str) -> Result<(), String> {
    let _guard = CLIENTS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut clients = load_clients(dir);
    clients.retain(|client| client.id != id);
    save_clients(dir, &clients)
}

pub fn action_allowed(level: Level, action: &str) -> bool {
    READ_ACTIONS.contains(&action) || (level != Level::Read && ACT_ACTIONS.contains(&action))
}

/// Read from disk each time, so revoking a client takes effect at once.
pub fn identify(dir: &Path, token: &str) -> Result<Client, String> {
    let hash = hash_token(token);
    load_clients(dir)
        .into_iter()
        .find(|client| client.token_hash == hash)
        .ok_or_else(|| "This MCP client was revoked or its token is wrong".to_string())
}

pub fn check_action(client: &Client, action: &str) -> Result<(), String> {
    if action != WHOAMI && !action_allowed(client.level, action) {
        return Err(format!(
            "{} is not allowed for {}, whose level doesn't include it",
            action, client.name
        ));
    }
    Ok(())
}

#[cfg(test)]
fn authorize(dir: &Path, token: &str, action: &str) -> Result<Client, String> {
    let client = identify(dir, token)?;
    check_action(&client, action)?;
    Ok(client)
}

/// What the app needs to know about a caller to run its request.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    pub id: String,
    pub name: String,
    pub level: Level,
    pub projects: Vec<String>,
}

impl From<&Client> for Caller {
    fn from(client: &Client) -> Self {
        Caller {
            id: client.id.clone(),
            name: client.name.clone(),
            level: client.level,
            projects: client.projects.clone(),
        }
    }
}

/// Handled here, with no need to wake the app: the tool list asks this.
pub fn is_whoami(action: &str) -> bool {
    action == WHOAMI
}

/// The control port changes each launch, so `monocode mcp` finds it here.
pub fn publish_endpoint(dir: &Path, endpoint: &str) {
    if let Err(error) = write_private(&dir.join(ENDPOINT_FILE), endpoint) {
        eprintln!("Could not publish the MCP endpoint: {error}");
    }
}

pub fn log_call(
    dir: &Path,
    client: &Client,
    action: &str,
    input: &Value,
    result: Result<&Value, &str>,
) {
    let error = match result {
        Err(error) => Some(error.to_string()),
        Ok(reply) if reply.get("ok").and_then(Value::as_bool) == Some(false) => reply
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
        Ok(_) => None,
    };
    append_log(
        dir,
        &LogEntry {
            at: now_ms(),
            client: client.name.clone(),
            action: action.to_string(),
            target: log_target(input),
            ok: error.is_none(),
            error,
        },
    );
}

/// What the log keeps of a call: where it went, never what it said.
pub fn log_target(input: &Value) -> Option<String> {
    ["sessionId", "project", "device"]
        .iter()
        .find_map(|key| input.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

pub fn append_log(dir: &Path, entry: &LogEntry) {
    let _guard = LOG_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let path = dir.join(LOG_FILE);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
    if let Ok(line) = serde_json::to_string(entry) {
        lines.push(line);
    }
    let start = lines.len().saturating_sub(MAX_LOG_LINES);
    let _ = write_private(&path, &(lines[start..].join("\n") + "\n"));
}

/// Newest first.
pub fn read_log(dir: &Path, limit: usize) -> Vec<LogEntry> {
    let mut entries: Vec<LogEntry> = std::fs::read_to_string(dir.join(LOG_FILE))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    entries.reverse();
    entries.truncate(limit);
    entries
}

struct Tool {
    name: &'static str,
    action: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

fn session_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project": { "type": "string", "description": "Project path." },
            "sessionId": { "type": "string" },
        },
        "required": ["project", "sessionId"],
    })
}

fn device_schema(extra: Value, required: &[&str]) -> Value {
    let mut properties = json!({
        "device": { "type": "string", "description": "An id from device_list." },
    });
    if let (Some(all), Some(more)) = (properties.as_object_mut(), extra.as_object()) {
        all.extend(more.clone());
    }
    let mut needed = vec!["device"];
    needed.extend_from_slice(required);
    json!({ "type": "object", "properties": properties, "required": needed })
}

const TOOLS: [Tool; 10] = [
    Tool {
        name: "monocode_sessions_list",
        action: "sessions.list",
        description: "List the sessions in a project, with their titles and whether they're busy.",
        schema: || {
            json!({
                "type": "object",
                "properties": { "project": { "type": "string", "description": "Project path." } },
                "required": ["project"],
            })
        },
    },
    Tool {
        name: "monocode_sessions_read",
        action: "sessions.read",
        description: "Read a session's conversation, newest messages first, a page at a time.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Project path." },
                    "sessionId": { "type": "string" },
                    "before": { "type": "string", "description": "Page cursor from the last read." },
                    "limit": { "type": "number" },
                    "maxChars": { "type": "number" },
                },
                "required": ["project", "sessionId"],
            })
        },
    },
    Tool {
        name: "monocode_sessions_start",
        action: "sessions.start",
        description: "Start a new session in a project with a first prompt. Returns its id.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Project path." },
                    "prompt": { "type": "string" },
                    "harness": { "type": "string", "description": "claude, codex or another provider id." },
                    "model": { "type": "string" },
                },
                "required": ["project", "prompt"],
            })
        },
    },
    Tool {
        name: "monocode_sessions_send",
        action: "sessions.send",
        description: "Send a message to an existing session.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Project path." },
                    "sessionId": { "type": "string" },
                    "prompt": { "type": "string" },
                },
                "required": ["project", "sessionId", "prompt"],
            })
        },
    },
    Tool {
        name: "monocode_sessions_stop",
        action: "sessions.stop",
        description: "Stop a session's current turn.",
        schema: session_schema,
    },
    Tool {
        name: "device_list",
        action: "device.list",
        description:
            "List the running iOS Simulators and Android emulators. Real phones are never listed.",
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Tool {
        name: "device_screenshot",
        action: "device.screenshot",
        description:
            "See a device's screen. Points for the other device tools are in this image's pixels.",
        schema: || device_schema(json!({}), &[]),
    },
    Tool {
        name: "device_tap",
        action: "device.tap",
        description: "Tap a point on a device's screen, in screenshot pixels.",
        schema: || {
            device_schema(
                json!({ "x": { "type": "number" }, "y": { "type": "number" } }),
                &["x", "y"],
            )
        },
    },
    Tool {
        name: "device_swipe",
        action: "device.swipe",
        description: "Swipe between two points on a device's screen, in screenshot pixels.",
        schema: || {
            device_schema(
                json!({
                    "fromX": { "type": "number" },
                    "fromY": { "type": "number" },
                    "toX": { "type": "number" },
                    "toY": { "type": "number" },
                }),
                &["fromX", "fromY", "toX", "toY"],
            )
        },
    },
    Tool {
        name: "device_type",
        action: "device.type",
        description: "Type text into the focused field on a device.",
        schema: || device_schema(json!({ "text": { "type": "string" } }), &["text"]),
    },
];

/// Sends one action to the app and returns its reply.
pub type Forward<'a> = dyn FnMut(&str, Value) -> Result<Value, String> + 'a;

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool's own failure goes back as a result, so the agent can read and adapt.
fn tool_text(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// One line of JSON-RPC in, one out; notifications get no answer.
pub fn handle_line(line: &str, forward: &mut Forward) -> Option<Value> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Some(rpc_error(&Value::Null, -32700, "Parse error"));
    };
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            rpc_result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "monocode", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => {
            // Only what this client may use, so an agent doesn't plan around
            // tools it would be refused.
            let level = forward(WHOAMI, json!({}))
                .ok()
                .and_then(|who| serde_json::from_value::<Level>(who["level"].clone()).ok())
                .unwrap_or(Level::Read);
            let tools: Vec<Value> = TOOLS
                .iter()
                .filter(|tool| action_allowed(level, tool.action))
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": (tool.schema)(),
                    })
                })
                .collect();
            rpc_result(&id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let Some(tool) = TOOLS.iter().find(|tool| tool.name == name) else {
                return Some(rpc_error(&id, -32602, "Unknown tool"));
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match forward(tool.action, arguments) {
                // A screenshot goes back as an image the agent can see.
                Ok(reply) if reply.get("png").and_then(Value::as_str).is_some() => rpc_result(
                    &id,
                    json!({
                        "content": [{ "type": "image", "data": reply["png"], "mimeType": "image/png" }],
                        "isError": false,
                    }),
                ),
                Ok(reply) => rpc_result(&id, tool_text(reply.to_string(), false)),
                Err(error) => rpc_result(&id, tool_text(error, true)),
            }
        }
        _ => rpc_error(&id, -32601, "Method not found"),
    })
}

fn forward_to_app(
    endpoint_file: &Path,
    token: &str,
    action: &str,
    input: Value,
) -> Result<Value, String> {
    let endpoint = std::fs::read_to_string(endpoint_file)
        .map_err(|_| "MonoCode isn't running, or has never run with MCP on".to_string())?;
    let mut stream = TcpStream::connect(endpoint.trim())
        .map_err(|_| "MonoCode isn't running. Open it and try again.".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(40)))
        .map_err(|e| e.to_string())?;
    let request = json!({
        "token": token,
        "namespace": "mcp",
        "action": action,
        "input": input,
        "requestId": uuid::Uuid::new_v4().simple().to_string(),
    });
    writeln!(stream, "{request}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let reply: Value =
        serde_json::from_str(&line).map_err(|_| "Bad reply from MonoCode".to_string())?;
    if reply.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(reply["error"]
            .as_str()
            .unwrap_or("Request failed")
            .to_string());
    }
    Ok(reply.get("result").cloned().unwrap_or(reply))
}

/// `monocode mcp`: reads JSON-RPC lines on stdin until it closes.
pub fn run_stdio() -> i32 {
    let (Ok(token), Ok(endpoint)) = (
        std::env::var("MONOCODE_MCP_TOKEN"),
        std::env::var("MONOCODE_MCP_ENDPOINT_FILE"),
    ) else {
        eprintln!(
            "monocode mcp needs MONOCODE_MCP_TOKEN and MONOCODE_MCP_ENDPOINT_FILE. Copy its config from Settings > MCP in MonoCode."
        );
        return 2;
    };
    let endpoint = PathBuf::from(endpoint);
    let mut forward = |action: &str, input: Value| forward_to_app(&endpoint, &token, action, input);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_line(&line, &mut forward) {
            let mut out = stdout.lock();
            if writeln!(out, "{reply}").and_then(|()| out.flush()).is_err() {
                break;
            }
        }
    }
    0
}

// fork-mcp-app-wiring-start
mod commands {
    use super::*;
    use tauri::{AppHandle, Manager};

    fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path().app_data_dir().map_err(|e| e.to_string())
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CreatedClient {
        client: Client,
        token: String,
        command: String,
        endpoint_file: String,
    }

    #[tauri::command(async)]
    pub fn fork_mcp_clients(app: AppHandle) -> Result<Vec<Client>, String> {
        Ok(load_clients(&data_dir(&app)?))
    }

    #[tauri::command(async)]
    pub fn fork_mcp_create_client(
        app: AppHandle,
        name: String,
        level: Level,
        projects: Vec<String>,
    ) -> Result<CreatedClient, String> {
        let dir = data_dir(&app)?;
        let (client, token) = create_client(&dir, &name, level, projects)?;
        Ok(CreatedClient {
            client,
            token,
            command: std::env::current_exe()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned(),
            endpoint_file: dir.join(ENDPOINT_FILE).to_string_lossy().into_owned(),
        })
    }

    #[tauri::command(async)]
    pub fn fork_mcp_revoke_client(app: AppHandle, id: String) -> Result<(), String> {
        revoke_client(&data_dir(&app)?, &id)
    }

    #[tauri::command(async)]
    pub fn fork_mcp_log(app: AppHandle) -> Result<Vec<LogEntry>, String> {
        Ok(read_log(&data_dir(&app)?, 100))
    }
}
pub use commands::*;
// fork-mcp-app-wiring-end

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU32;

    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct Dir(PathBuf);

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn dir() -> Dir {
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("mc-mcp-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Dir(path)
    }

    fn make(dir: &Dir, level: Level) -> (Client, String) {
        create_client(&dir.0, "codex", level, vec!["/repo".into()]).unwrap()
    }

    #[test]
    fn stores_only_a_hash_of_the_token() {
        let dir = dir();
        let (client, token) = make(&dir, Level::Read);
        assert_eq!(client.token_hash, hash_token(&token));
        let stored = fs::read_to_string(dir.0.join(CLIENTS_FILE)).unwrap();
        assert!(!stored.contains(&token));
        assert!(stored.contains(&client.token_hash));
    }

    #[cfg(unix)]
    #[test]
    fn keeps_its_files_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dir();
        make(&dir, Level::Read);
        let mode = fs::metadata(dir.0.join(CLIENTS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn needs_a_name_and_a_project_and_no_duplicates() {
        let dir = dir();
        assert!(create_client(&dir.0, " ", Level::Read, vec!["/a".into()]).is_err());
        assert!(create_client(&dir.0, "x", Level::Read, vec![]).is_err());
        make(&dir, Level::Read);
        assert!(create_client(&dir.0, "codex", Level::Read, vec!["/a".into()]).is_err());
    }

    #[test]
    fn a_wrong_token_gets_nothing() {
        let dir = dir();
        make(&dir, Level::Full);
        assert!(authorize(&dir.0, "guess", "sessions.list").is_err());
        assert!(authorize(&dir.0, "", "sessions.list").is_err());
    }

    #[test]
    fn read_level_can_only_read() {
        let dir = dir();
        let (_, token) = make(&dir, Level::Read);
        assert!(authorize(&dir.0, &token, "sessions.list").is_ok());
        assert!(authorize(&dir.0, &token, "sessions.read").is_ok());
        for action in ["sessions.send", "sessions.start", "sessions.stop"] {
            assert!(authorize(&dir.0, &token, action).is_err(), "{action}");
        }
    }

    #[test]
    fn no_level_reaches_delete_archive_or_anything_else() {
        let dir = dir();
        let (_, token) = make(&dir, Level::Full);
        assert!(authorize(&dir.0, &token, "sessions.send").is_ok());
        for action in [
            "sessions.delete",
            "sessions.archive",
            "monos.make",
            "memory.add",
            "projects.create",
            "",
        ] {
            assert!(authorize(&dir.0, &token, action).is_err(), "{action}");
        }
    }

    #[test]
    fn revoking_takes_effect_on_the_next_call() {
        let dir = dir();
        let (client, token) = make(&dir, Level::Full);
        assert!(authorize(&dir.0, &token, "sessions.list").is_ok());
        revoke_client(&dir.0, &client.id).unwrap();
        assert!(authorize(&dir.0, &token, "sessions.list").is_err());
    }

    #[test]
    fn a_revoke_is_never_undone_by_a_create_running_at_the_same_time() {
        let dir = dir();
        let (client, token) = make(&dir, Level::Full);
        std::thread::scope(|scope| {
            for index in 0..16 {
                let path = dir.0.clone();
                scope.spawn(move || {
                    create_client(&path, &format!("c{index}"), Level::Read, vec!["/a".into()])
                        .unwrap();
                });
            }
            let path = dir.0.clone();
            let id = client.id.clone();
            scope.spawn(move || revoke_client(&path, &id).unwrap());
        });
        assert!(identify(&dir.0, &token).is_err());
        assert_eq!(load_clients(&dir.0).len(), 16);
    }

    #[test]
    fn no_log_line_is_lost_to_a_call_at_the_same_time() {
        let dir = dir();
        std::thread::scope(|scope| {
            for index in 0..24 {
                let path = dir.0.clone();
                scope.spawn(move || append_log(&path, &entry(&format!("c{index}"))));
            }
        });
        assert_eq!(read_log(&dir.0, 100).len(), 24);
    }

    #[test]
    fn a_damaged_client_file_lets_nobody_in() {
        let dir = dir();
        let (_, token) = make(&dir, Level::Full);
        fs::write(dir.0.join(CLIENTS_FILE), "{broken").unwrap();
        assert!(authorize(&dir.0, &token, "sessions.list").is_err());
    }

    fn entry(client: &str) -> LogEntry {
        LogEntry {
            at: 1,
            client: client.into(),
            action: "sessions.send".into(),
            target: Some("s1".into()),
            ok: true,
            error: None,
        }
    }

    #[test]
    fn the_log_is_newest_first_and_bounded() {
        let dir = dir();
        for index in 0..(MAX_LOG_LINES + 5) {
            append_log(&dir.0, &entry(&format!("c{index}")));
        }
        let lines = fs::read_to_string(dir.0.join(LOG_FILE))
            .unwrap()
            .lines()
            .count();
        assert_eq!(lines, MAX_LOG_LINES);
        let log = read_log(&dir.0, 3);
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].client, format!("c{}", MAX_LOG_LINES + 4));
    }

    #[test]
    fn the_log_keeps_the_target_and_never_the_prompt() {
        let input = json!({ "sessionId": "s1", "prompt": "secret plan" });
        assert_eq!(log_target(&input).as_deref(), Some("s1"));
        let project = json!({ "project": "/repo", "prompt": "secret plan" });
        assert_eq!(log_target(&project).as_deref(), Some("/repo"));
        assert_eq!(log_target(&json!({ "prompt": "secret plan" })), None);
    }

    fn call(line: &str, forward: &mut Forward) -> Value {
        handle_line(line, forward).unwrap()
    }

    #[test]
    fn answers_initialize_in_the_clients_version() {
        let mut forward = |_: &str, _: Value| Ok(json!({}));
        let reply = call(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            &mut forward,
        );
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["serverInfo"]["name"], "monocode");
    }

    #[test]
    fn never_answers_a_notification() {
        let mut forward = |_: &str, _: Value| Ok(json!({}));
        assert!(handle_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &mut forward
        )
        .is_none());
    }

    fn tool_names(level: &str) -> Vec<String> {
        let level = level.to_string();
        let mut forward = move |_: &str, _: Value| Ok(json!({ "level": level }));
        let reply = call(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            &mut forward,
        );
        reply["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn lists_only_the_tools_a_level_can_use() {
        assert_eq!(
            tool_names("read"),
            vec!["monocode_sessions_list", "monocode_sessions_read"]
        );
        assert_eq!(tool_names("supervised").len(), 10);
        assert!(!tool_names("full")
            .iter()
            .any(|name| name.contains("delete")));
    }

    #[test]
    fn lists_read_tools_when_the_level_is_unknown() {
        let mut forward = |_: &str, _: Value| Err("offline".to_string());
        let reply = call(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            &mut forward,
        );
        assert_eq!(reply["result"]["tools"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn forwards_a_tool_call_as_its_action() {
        let mut seen = None;
        {
            let mut forward = |action: &str, input: Value| {
                seen = Some((action.to_string(), input));
                Ok(json!({ "submitted": true }))
            };
            let reply = call(
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"monocode_sessions_send","arguments":{"sessionId":"s1","prompt":"hi"}}}"#,
                &mut forward,
            );
            assert_eq!(reply["result"]["isError"], false);
            assert!(reply["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("submitted"));
        }
        let (action, input) = seen.unwrap();
        assert_eq!(action, "sessions.send");
        assert_eq!(input["prompt"], "hi");
    }

    #[test]
    fn read_level_cant_see_or_touch_a_device() {
        let dir = dir();
        let (_, token) = make(&dir, Level::Read);
        for action in ["device.list", "device.screenshot", "device.tap"] {
            assert!(authorize(&dir.0, &token, action).is_err(), "{action}");
        }
    }

    #[test]
    fn a_screenshot_comes_back_as_an_image() {
        let mut forward = |_: &str, _: Value| Ok(json!({ "png": "aGk=" }));
        let reply = call(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"device_screenshot","arguments":{"device":"android:emulator-1"}}}"#,
            &mut forward,
        );
        assert_eq!(reply["result"]["content"][0]["type"], "image");
        assert_eq!(reply["result"]["content"][0]["data"], "aGk=");
    }

    #[test]
    fn a_refused_call_comes_back_for_the_agent_to_read() {
        let mut forward = |_: &str, _: Value| Err("not allowed".to_string());
        let reply = call(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"monocode_sessions_stop","arguments":{}}}"#,
            &mut forward,
        );
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["content"][0]["text"], "not allowed");
    }

    #[test]
    fn rejects_unknown_tools_methods_and_bad_json() {
        let mut forward = |_: &str, _: Value| Ok(json!({}));
        let unknown = call(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"monocode_sessions_delete"}}"#,
            &mut forward,
        );
        assert_eq!(unknown["error"]["code"], -32602);
        let method = call(
            r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#,
            &mut forward,
        );
        assert_eq!(method["error"]["code"], -32601);
        let bad = call("{nope", &mut forward);
        assert_eq!(bad["error"]["code"], -32700);
    }
}
