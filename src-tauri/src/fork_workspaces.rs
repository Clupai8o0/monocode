//! Fork feature: named workspaces, one OS window each (label `ws-<slug>`).
//! Each keeps its own layout snapshot and interrupted-turn list in a fork
//! SQLite file, so every window comes back as it was, and the ones still open
//! at quit reopen at launch. `main` and `window-N` keep upstream's single row.
//! Also keeps which window holds which session, so a session is never open in
//! two windows (both would drive the same harness child).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::session_store::InFlightSession;

pub const LABEL_PREFIX: &str = "ws-";
const NAME_MAX: usize = 40;
const SLUG_MAX: usize = 32;
const SNAPSHOT_MAX_BYTES: usize = 2_000_000;
const SESSION_IDS_MAX: usize = 2_000;
/// A claim stands until its window reports the session (or closes). This only
/// bounds a claim whose open failed; a slow load is far shorter.
const CLAIM_TTL: Duration = Duration::from_secs(60);
/// Sent to the window that holds a session, asking it to show it.
const OPEN_SESSION_EVENT: &str = "fork_open_session";

pub struct ForkWorkspaces {
    conn: Mutex<Option<Connection>>,
    held: Mutex<Held>,
}

#[derive(Default)]
struct Held {
    /// Window label -> the session ids that window reported open.
    reports: HashMap<String, HashSet<String>>,
    /// Session id -> the window about to open it, and when it said so.
    claims: HashMap<String, (String, Instant)>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub slug: String,
    pub name: String,
    /// Open at the last quit or still open now; reopened at launch.
    pub open: bool,
    /// A window for it exists in this process (it may be hidden).
    pub live: bool,
    pub updated_at: i64,
}

pub fn init(app: &AppHandle) {
    let conn = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| open_db(&dir.join("fork-workspaces.db")).ok());
    app.manage(ForkWorkspaces {
        conn: Mutex::new(conn),
        held: Mutex::new(Held::default()),
    });
}

fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS fork_workspaces (
             slug TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             snapshot_json TEXT,
             in_flight_json TEXT,
             open INTEGER NOT NULL DEFAULT 1,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );",
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn label_for(slug: &str) -> String {
    format!("{LABEL_PREFIX}{slug}")
}

pub fn slug_of_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(LABEL_PREFIX)
        .filter(|slug| valid_slug(slug))
}

pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= SLUG_MAX + 4
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if name.is_empty() {
        return Err("Give the workspace a name.".into());
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!("Keep the name under {NAME_MAX} characters."));
    }
    Ok(name)
}

/// "Uni: SIT320 notes" -> "uni-sit320-notes".
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= SLUG_MAX {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "workspace".into()
    } else {
        slug
    }
}

fn unique_slug(conn: &Connection, base: &str) -> rusqlite::Result<String> {
    let taken = |slug: &str| -> rusqlite::Result<bool> {
        conn.query_row(
            "SELECT 1 FROM fork_workspaces WHERE slug = ?1",
            [slug],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
    };
    if !taken(base)? {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let slug = format!("{base}-{n}");
        if !taken(&slug)? {
            return Ok(slug);
        }
    }
    Err(rusqlite::Error::QueryReturnedNoRows)
}

fn with_conn<T>(
    app: &AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let state = app.state::<ForkWorkspaces>();
    let guard = state.conn.lock().map_err(|_| "Workspace store is locked")?;
    let conn = guard.as_ref().ok_or("Workspace store did not open")?;
    f(conn).map_err(|e| e.to_string())
}

fn list_rows(conn: &Connection) -> rusqlite::Result<Vec<(String, String, bool, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT slug, name, open, updated_at FROM fork_workspaces
         ORDER BY name COLLATE NOCASE ASC, slug ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)? != 0,
            row.get::<_, i64>(3)?,
        ))
    })?;
    rows.collect()
}

fn insert_row(conn: &Connection, name: &str) -> rusqlite::Result<String> {
    let slug = unique_slug(conn, &slugify(name))?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO fork_workspaces (slug, name, open, created_at, updated_at)
         VALUES (?1, ?2, 1, ?3, ?3)",
        params![slug, name, now],
    )?;
    Ok(slug)
}

fn set_open(conn: &Connection, slug: &str, open: bool) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE fork_workspaces SET open = ?2 WHERE slug = ?1",
        params![slug, open as i64],
    )
}

fn row_name(conn: &Connection, slug: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT name FROM fork_workspaces WHERE slug = ?1",
        [slug],
        |row| row.get(0),
    )
    .optional()
}

fn save_column(conn: &Connection, slug: &str, column: &str, json: &str) -> rusqlite::Result<usize> {
    // `column` is one of two fixed names, never caller input.
    let sql = format!("UPDATE fork_workspaces SET {column} = ?2, updated_at = ?3 WHERE slug = ?1");
    conn.execute(&sql, params![slug, json, now_ms()])
}

fn load_column(conn: &Connection, slug: &str, column: &str) -> rusqlite::Result<Option<String>> {
    let sql = format!("SELECT {column} FROM fork_workspaces WHERE slug = ?1");
    conn.query_row(&sql, [slug], |row| row.get::<_, Option<String>>(0))
        .optional()
        .map(Option::flatten)
}

/// The workspace this window shows, or an error for `main` / `window-N`.
fn own_slug(window: &WebviewWindow) -> Result<String, String> {
    slug_of_label(window.label())
        .map(str::to_string)
        .ok_or_else(|| "not a workspace window".into())
}

fn open_window(app: &AppHandle, slug: &str, name: &str) -> Result<(), String> {
    let label = label_for(slug);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("missing main window config")?
        .clone();
    config.label = label;
    config.title = name.to_string();
    config.visible = true;
    config.focus = true;
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|err| err.to_string())?
        .build()
        .map_err(|err| err.to_string())?;
    // AppKit calls (constraints, shadow) must run on the main thread: from the
    // async create/open commands they raised an ObjC exception that aborted
    // the whole app.
    #[cfg(target_os = "macos")]
    {
        let styled = window.clone();
        app.run_on_main_thread(move || crate::macos::install(&styled))
            .map_err(|err| err.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_decorations(false);
        let _ = window.set_shadow(true);
    }
    let _ = window.set_focus();
    Ok(())
}

/// Launch: bring back every workspace that was open at the last quit. Runs
/// at Ready on the main thread, so the windows are built from a worker, like
/// the async commands do.
pub fn reopen(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(rows) = with_conn(&app, list_rows) else {
            return;
        };
        for (slug, name, open, _) in rows {
            if open {
                let _ = open_window(&app, &slug, &name);
            }
        }
    });
}

/// A window went away. Closing a workspace window by hand stops it reopening;
/// the windows a quit tears down stay marked open.
pub fn window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<ForkWorkspaces>() else {
        return;
    };
    if let Ok(mut held) = state.held.lock() {
        held.reports.remove(label);
        held.claims.retain(|_, (owner, _)| owner != label);
    }
    if crate::window::allow_exit() {
        return;
    }
    if let Some(slug) = slug_of_label(label) {
        let _ = with_conn(app, |conn| set_open(conn, slug, false));
    }
}

#[tauri::command(async)]
pub fn fork_workspace_list(app: AppHandle) -> Result<Vec<WorkspaceRow>, String> {
    let rows = with_conn(&app, list_rows)?;
    Ok(rows
        .into_iter()
        .map(|(slug, name, open, updated_at)| WorkspaceRow {
            live: app.get_webview_window(&label_for(&slug)).is_some(),
            slug,
            name,
            open,
            updated_at,
        })
        .collect())
}

// Async so the IPC call doesn't block the main thread; `open_window` hops
// back to it for the AppKit styling.
#[tauri::command]
pub async fn fork_workspace_create(app: AppHandle, name: String) -> Result<String, String> {
    let name = clean_name(&name)?;
    let slug = with_conn(&app, |conn| insert_row(conn, &name))?;
    open_or_mark_closed(&app, &slug, &name)?;
    Ok(slug)
}

/// A window that failed to build must not be retried at every launch.
fn open_or_mark_closed(app: &AppHandle, slug: &str, name: &str) -> Result<(), String> {
    open_window(app, slug, name).inspect_err(|_| {
        let _ = with_conn(app, |conn| set_open(conn, slug, false));
    })
}

#[tauri::command]
pub async fn fork_workspace_open(app: AppHandle, slug: String) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err("bad workspace".into());
    }
    let name = with_conn(&app, |conn| {
        let name = row_name(conn, &slug)?;
        if name.is_some() {
            set_open(conn, &slug, true)?;
        }
        Ok(name)
    })?
    .ok_or("That workspace no longer exists.")?;
    open_or_mark_closed(&app, &slug, &name)
}

#[tauri::command(async)]
pub fn fork_workspace_rename(app: AppHandle, slug: String, name: String) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err("bad workspace".into());
    }
    let name = clean_name(&name)?;
    with_conn(&app, |conn| {
        conn.execute(
            "UPDATE fork_workspaces SET name = ?2 WHERE slug = ?1",
            params![slug, name],
        )
    })?;
    if let Some(window) = app.get_webview_window(&label_for(&slug)) {
        let _ = window.set_title(&name);
        let _ = window.emit_to(window.label(), "fork_workspace_renamed", &name);
    }
    Ok(())
}

/// Forget a workspace. Refused while its window exists, so a live layout is
/// never orphaned.
#[tauri::command(async)]
pub fn fork_workspace_delete(app: AppHandle, slug: String) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err("bad workspace".into());
    }
    if app.get_webview_window(&label_for(&slug)).is_some() {
        return Err("Close its window first.".into());
    }
    with_conn(&app, |conn| {
        conn.execute("DELETE FROM fork_workspaces WHERE slug = ?1", [&slug])
    })?;
    Ok(())
}

/// This window's workspace name, or `None` for `main` / `window-N`.
#[tauri::command(async)]
pub fn fork_workspace_current(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let Some(slug) = slug_of_label(window.label()) else {
        return Ok(None);
    };
    with_conn(&app, |conn| row_name(conn, slug))
}

#[tauri::command(async)]
pub fn fork_workspace_save(
    app: AppHandle,
    window: WebviewWindow,
    snapshot: Value,
) -> Result<(), String> {
    let slug = own_slug(&window)?;
    if !snapshot.is_object() {
        return Err("workspace snapshot must be an object".into());
    }
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    if json.len() > SNAPSHOT_MAX_BYTES {
        return Err("workspace snapshot is too large".into());
    }
    with_conn(&app, |conn| {
        save_column(conn, &slug, "snapshot_json", &json)
    })
    .map(|_| ())
}

#[tauri::command(async)]
pub fn fork_workspace_load(app: AppHandle, window: WebviewWindow) -> Result<Option<Value>, String> {
    let slug = own_slug(&window)?;
    match with_conn(&app, |conn| load_column(conn, &slug, "snapshot_json"))? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
    }
}

#[tauri::command(async)]
pub fn fork_workspace_set_in_flight(
    app: AppHandle,
    window: WebviewWindow,
    sessions: Vec<InFlightSession>,
) -> Result<(), String> {
    let slug = own_slug(&window)?;
    for session in &sessions {
        if !valid_id(&session.session_id) || session.cwd.trim().is_empty() {
            return Err("bad in-flight session".into());
        }
    }
    let json = serde_json::to_string(&sessions).map_err(|e| e.to_string())?;
    with_conn(&app, |conn| {
        save_column(conn, &slug, "in_flight_json", &json)
    })
    .map(|_| ())
}

#[tauri::command(async)]
pub fn fork_workspace_list_in_flight(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<InFlightSession>, String> {
    let slug = own_slug(&window)?;
    let raw = with_conn(&app, |conn| load_column(conn, &slug, "in_flight_json"))?;
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

fn valid_id(id: &str) -> bool {
    id.len() <= 200 && crate::session_store::validate_id(id, "session").is_ok()
}

/// This window's open sessions, replacing what it reported before.
#[tauri::command(async)]
pub fn fork_window_sessions_set(
    app: AppHandle,
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
    let ids: HashSet<String> = ids
        .into_iter()
        .filter(|id| valid_id(id))
        .take(SESSION_IDS_MAX)
        .collect();
    let state = app.state::<ForkWorkspaces>();
    let mut held = state.held.lock().map_err(|_| "locked")?;
    let label = window.label().to_string();
    held.claims
        .retain(|id, (owner, _)| !(owner == &label && ids.contains(id)));
    held.reports.insert(label, ids);
    Ok(())
}

/// Which other window holds `id`, by its report or a fresh claim; when none
/// does, `asking` claims it. One lock, so two windows opening the same
/// session at once cannot both win. Sorted, so a stale double report gives a
/// stable answer.
fn claim(held: &mut Held, asking: &str, id: &str, now: Instant) -> Option<String> {
    held.claims
        .retain(|_, (_, at)| now.saturating_duration_since(*at) < CLAIM_TTL);
    let mut labels: Vec<&String> = held
        .reports
        .iter()
        .filter(|(label, ids)| label.as_str() != asking && ids.contains(id))
        .map(|(label, _)| label)
        .collect();
    if let Some((owner, _)) = held.claims.get(id) {
        if owner != asking {
            labels.push(owner);
        }
    }
    labels.sort();
    if let Some(label) = labels.first() {
        return Some(label.to_string());
    }
    held.claims
        .insert(id.to_string(), (asking.to_string(), now));
    None
}

/// Before a window opens `session_id`: if another window has it, bring that
/// window forward, ask it to show the session, and return true. Otherwise the
/// caller now holds it and returns false. The target opens the session itself
/// if its report was stale, so a click never ends with it open nowhere.
#[tauri::command]
pub async fn fork_claim_session(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
    focus: Option<bool>,
) -> Result<bool, String> {
    if !valid_id(&session_id) {
        return Ok(false);
    }
    let label = {
        let state = app.state::<ForkWorkspaces>();
        let mut held = state.held.lock().map_err(|_| "locked")?;
        claim(&mut held, window.label(), &session_id, Instant::now())
    };
    let Some(label) = label else {
        return Ok(false);
    };
    let Some(target) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    // Background callers (Mono habits) only need to know to keep out.
    if focus == Some(false) {
        return Ok(true);
    }
    let _ = target.unminimize();
    let _ = target.show();
    let _ = target.set_focus();
    let _ = app.emit_to(&label, OPEN_SESSION_EVENT, &session_id);
    Ok(true)
}

fn chrome_dir(slug: &str) -> Option<PathBuf> {
    Some(
        PathBuf::from(crate::dirs_home()?)
            .join(".local/state/monocode-fork/chrome")
            .join(slug),
    )
}

/// A Chrome window with this workspace's own profile, so its tabs and logins
/// stay apart from the others.
#[tauri::command(async)]
pub fn fork_workspace_chrome(slug: String) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err("bad workspace".into());
    }
    #[cfg(target_os = "macos")]
    {
        let dir = chrome_dir(&slug).ok_or("no home folder")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("/usr/bin/open")
            .args(["-na", "Google Chrome", "--args"])
            .arg(format!("--user-data-dir={}", dir.display()))
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not start Google Chrome.".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = chrome_dir;
        Err("Only on macOS for now.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn slugs_are_short_safe_and_unique() {
        assert_eq!(slugify("Uni: SIT320 notes"), "uni-sit320-notes");
        assert_eq!(slugify("  ---  "), "workspace");
        assert_eq!(slugify("Ünï ✨"), "n");
        assert!(slugify(&"a".repeat(100)).len() <= SLUG_MAX);
        let conn = db();
        assert_eq!(insert_row(&conn, "Uni").unwrap(), "uni");
        assert_eq!(insert_row(&conn, "uni").unwrap(), "uni-2");
        assert_eq!(insert_row(&conn, "UNI!").unwrap(), "uni-3");
        assert!(valid_slug("uni-3"));
    }

    #[test]
    fn labels_map_back_to_slugs_only_for_workspace_windows() {
        assert_eq!(slug_of_label("ws-uni"), Some("uni"));
        assert_eq!(slug_of_label("main"), None);
        assert_eq!(slug_of_label("window-2"), None);
        assert_eq!(slug_of_label("ws-"), None);
        assert_eq!(slug_of_label("ws-../x"), None);
        assert_eq!(label_for("uni"), "ws-uni");
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(clean_name("  Uni\n ").unwrap(), "Uni");
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"x".repeat(NAME_MAX + 1)).is_err());
    }

    #[test]
    fn each_workspace_keeps_its_own_snapshot_and_in_flight_list() {
        let conn = db();
        let a = insert_row(&conn, "A").unwrap();
        let b = insert_row(&conn, "B").unwrap();
        save_column(&conn, &a, "snapshot_json", r#"{"v":"a"}"#).unwrap();
        save_column(
            &conn,
            &b,
            "in_flight_json",
            r#"[{"sessionId":"s1","cwd":"/x"}]"#,
        )
        .unwrap();
        assert_eq!(
            load_column(&conn, &a, "snapshot_json").unwrap().as_deref(),
            Some(r#"{"v":"a"}"#)
        );
        assert_eq!(load_column(&conn, &b, "snapshot_json").unwrap(), None);
        assert_eq!(load_column(&conn, &a, "in_flight_json").unwrap(), None);
        assert_eq!(load_column(&conn, "gone", "snapshot_json").unwrap(), None);
    }

    #[test]
    fn closing_by_hand_marks_closed_and_open_marks_open() {
        let conn = db();
        let a = insert_row(&conn, "A").unwrap();
        assert!(list_rows(&conn).unwrap()[0].2);
        set_open(&conn, &a, false).unwrap();
        assert!(!list_rows(&conn).unwrap()[0].2);
        set_open(&conn, &a, true).unwrap();
        assert!(list_rows(&conn).unwrap()[0].2);
    }

    #[test]
    fn a_session_held_elsewhere_is_found_but_not_in_the_asking_window() {
        let mut held = Held::default();
        let now = Instant::now();
        held.reports
            .insert("main".to_string(), HashSet::from(["s1".to_string()]));
        held.reports.insert(
            "ws-b".to_string(),
            HashSet::from(["s1".to_string(), "s2".to_string()]),
        );
        held.reports
            .insert("ws-a".to_string(), HashSet::from(["s2".to_string()]));
        assert_eq!(claim(&mut held, "main", "s1", now).as_deref(), Some("ws-b"));
        assert_eq!(claim(&mut held, "ws-b", "s1", now).as_deref(), Some("main"));
        assert_eq!(claim(&mut held, "main", "s2", now).as_deref(), Some("ws-a"));
        assert_eq!(claim(&mut held, "main", "s3", now), None);
    }

    #[test]
    fn two_windows_opening_one_session_at_once_cannot_both_win() {
        let mut held = Held::default();
        let now = Instant::now();
        assert_eq!(claim(&mut held, "main", "s1", now), None);
        assert_eq!(claim(&mut held, "ws-a", "s1", now).as_deref(), Some("main"));
        // The winner asking again is still the winner.
        assert_eq!(claim(&mut held, "main", "s1", now), None);
        // A claim whose open failed lapses.
        let later = now + CLAIM_TTL + Duration::from_secs(1);
        assert_eq!(claim(&mut held, "ws-a", "s1", later), None);
    }

    #[test]
    fn session_ids_are_checked() {
        assert!(valid_id("2f6c1e1a-1234-4abc-9def-0123456789ab"));
        assert!(!valid_id(""));
        assert!(!valid_id("a b"));
        assert!(!valid_id(&"a".repeat(201)));
    }
}
