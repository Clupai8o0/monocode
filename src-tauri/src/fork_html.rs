//! Ephemeral HTML drafts and narrowly scoped project assets. Pages run in an
//! opaque sandbox; this protocol never exposes a general filesystem endpoint.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{Manager, State, WebviewWindow};

// Matches MAX_TEXT_FILE_BYTES in fs.rs: the editor cannot read a larger file.
const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_PREVIEWS: usize = 64;
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
// Queue without creating blocking threads or allocating response buffers.
// At most two 16 MB asset chunks can be in native read work concurrently.
static READ_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));

#[derive(Clone)]
struct LocalProject {
    // An open directory anchors reads even if the path is later renamed.
    root: Arc<File>,
}

#[derive(Clone)]
struct Preview {
    id: String,
    owner: String,
    source: Arc<String>,
    document: String,
    project: Option<LocalProject>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLocation {
    id: String,
    url_path: String,
    local_assets: bool,
}

struct CreateTicket {
    owner: String,
    generation: Arc<()>,
}

#[derive(Default)]
struct PreviewState {
    previews: VecDeque<Preview>,
    // Only live owners are retained. Pending work holds its own generation,
    // which can never match a reopened window after the owner is removed.
    owners: HashMap<String, Arc<()>>,
}

#[derive(Default)]
pub struct HtmlPreviews(Mutex<PreviewState>);

impl HtmlPreviews {
    pub fn remove_window(&self, owner: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.owners.remove(owner);
            state.previews.retain(|entry| entry.owner != owner);
        }
    }

    fn begin_create_if_live(
        &self,
        owner: &str,
        is_live: impl FnOnce() -> bool,
    ) -> Result<CreateTicket, String> {
        let mut state = self.0.lock().map_err(|_| "HTML previews unavailable")?;
        // The command future itself can start after Destroyed. Its captured
        // WebviewWindow is not evidence that the owner is still registered.
        if !is_live() {
            return Err("HTML preview window is closed.".into());
        }
        let generation = Arc::clone(state.owners.entry(owner.into()).or_default());
        Ok(CreateTicket {
            owner: owner.into(),
            generation,
        })
    }

    #[cfg(test)]
    fn begin_create(&self, owner: &str) -> Result<CreateTicket, String> {
        self.begin_create_if_live(owner, || true)
    }

    fn create_pending(
        &self,
        ticket: &CreateTicket,
        source: String,
        path: &str,
        cwd: &str,
    ) -> Result<PreviewLocation, String> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "HTML preview supports files up to {} MB. Open Code to read this file.",
                MAX_SOURCE_BYTES / (1024 * 1024)
            ));
        }
        let (document, project) =
            local_project(path, cwd).unwrap_or_else(|| ("index.html".into(), None));
        let mut state = self.0.lock().map_err(|_| "HTML previews unavailable")?;
        if !state
            .owners
            .get(&ticket.owner)
            .is_some_and(|generation| Arc::ptr_eq(generation, &ticket.generation))
        {
            return Err("HTML preview window closed before rendering finished.".into());
        }
        let previews = &mut state.previews;
        let bytes = previews
            .iter()
            .map(|entry| entry.source.len())
            .sum::<usize>();
        // Do not evict an active page: it may load another image or video range.
        if previews.len() >= MAX_PREVIEWS || bytes + source.len() > MAX_TOTAL_BYTES {
            return Err(
                "HTML preview memory is full. Close another HTML preview and retry.".into(),
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        let location = PreviewLocation {
            url_path: format!("file-preview/{}/{}", id, encode_path(&document)),
            id: id.clone(),
            local_assets: project.is_some(),
        };
        previews.push_back(Preview {
            id,
            owner: ticket.owner.clone(),
            source: Arc::new(source),
            document,
            project,
        });
        Ok(location)
    }

    fn remove(&self, owner: &str, id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state
                .previews
                .retain(|entry| entry.id != id || entry.owner != owner);
        }
    }

    fn get(&self, id: &str) -> Option<Preview> {
        self.0
            .lock()
            .ok()?
            .previews
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
    }

    #[cfg(test)]
    fn create(
        &self,
        owner: &str,
        source: String,
        path: &str,
        cwd: &str,
    ) -> Result<PreviewLocation, String> {
        self.create_pending(&self.begin_create(owner)?, source, path, cwd)
    }
}

// Remote drafts still render, but never interpret their paths as local files.
fn local_project(path: &str, cwd: &str) -> Option<(String, Option<LocalProject>)> {
    #[cfg(unix)]
    {
        if !Path::new(path).is_absolute() || !Path::new(cwd).is_absolute() {
            return None;
        }
        let root = std::fs::canonicalize(cwd).ok()?;
        let document = std::fs::canonicalize(path).ok()?;
        if !root.is_dir() || !document.is_file() {
            return None;
        }
        let relative = document.strip_prefix(&root).ok()?.to_str()?.to_owned();
        if relative.is_empty() {
            return None;
        }
        // Open from the filesystem root without following any component that
        // may have become a symlink since canonicalization.
        let filesystem = File::open("/").ok()?;
        let root = Arc::new(open_asset(
            &filesystem,
            root.strip_prefix("/").ok()?.to_str()?,
        )?);
        if !root.metadata().ok()?.is_dir() {
            return None;
        }
        Some((relative, Some(LocalProject { root })))
    }
    #[cfg(not(unix))]
    {
        // Fail closed until equivalent handle-relative, no-reparse-point reads
        // are implemented on Windows. Self-contained HTML remains available.
        let _ = (path, cwd);
        None
    }
}

#[tauri::command]
pub async fn fork_html_preview_create(
    window: WebviewWindow,
    app: tauri::AppHandle,
    source: String,
    path: String,
    cwd: String,
) -> Result<PreviewLocation, String> {
    // Capture before queuing blocking I/O. Window teardown invalidates this
    // exact generation even when the worker has not started yet.
    let ticket = app
        .state::<HtmlPreviews>()
        .begin_create_if_live(window.label(), || {
            app.get_webview_window(window.label()).is_some()
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<HtmlPreviews>()
            .create_pending(&ticket, source, &path, &cwd)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn fork_html_preview_remove(
    window: WebviewWindow,
    previews: State<'_, HtmlPreviews>,
    id: String,
) {
    previews.remove(window.label(), &id);
}

pub fn serve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    match app.try_state::<HtmlPreviews>() {
        Some(store) => serve_request(&store, request),
        None => response(404, "text/plain", Vec::new(), "", None),
    }
}

/// Keep disk reads off the webview/protocol thread and bound their concurrency
/// across every window, including background image and video-range requests.
pub fn serve_async<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let Ok(permit) = READ_SLOTS.clone().acquire_owned().await else {
            responder.respond(response(503, "text/plain", Vec::new(), "", None));
            return;
        };
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            serve(&app, &request)
        })
        .await
        .unwrap_or_else(|_| response(500, "text/plain", Vec::new(), "", None));
        responder.respond(result);
    });
}

fn serve_request(
    store: &HtmlPreviews,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let missing = || {
        response(
            404,
            "text/plain",
            b"Preview expired or asset unavailable. Reload the preview.".to_vec(),
            "",
            None,
        )
    };
    if request.method() != tauri::http::Method::GET {
        return missing();
    }
    let Some((id, encoded)) = request
        .uri()
        .path()
        .strip_prefix("/file-preview/")
        .and_then(|path| path.split_once('/'))
    else {
        return missing();
    };
    let Some(preview) = store.get(id) else {
        return missing();
    };
    let Some(relative) = decode_path(encoded) else {
        return missing();
    };
    if relative == preview.document {
        return response(
            200,
            "text/html; charset=utf-8",
            preview.source.as_bytes().to_vec(),
            id,
            None,
        );
    }
    let Some(project) = preview.project else {
        return missing();
    };
    let Some(mime) = asset_mime(&relative) else {
        return missing();
    };
    let Some(mut file) = open_asset(&project.root, &relative) else {
        return missing();
    };
    let Ok(metadata) = file.metadata() else {
        return missing();
    };
    if !metadata.is_file() {
        return missing();
    }
    let size = metadata.len();
    let media = mime.starts_with("video/") || mime.starts_with("audio/");
    if size
        > if media {
            MAX_MEDIA_BYTES
        } else {
            MAX_ASSET_BYTES
        }
    {
        return response(
            413,
            "text/plain",
            b"Preview asset is too large.".to_vec(),
            id,
            None,
        );
    }
    let range = request.headers().get("Range");
    let (start, length, partial) = if let Some(range) = range {
        let Some((start, end)) = range
            .to_str()
            .ok()
            .and_then(|value| parse_range(value, size))
        else {
            return response(416, mime, Vec::new(), id, Some(format!("bytes */{size}")));
        };
        (start, end - start + 1, true)
    } else {
        if size > MAX_ASSET_BYTES {
            return response(
                413,
                "text/plain",
                b"Large media requires byte-range loading.".to_vec(),
                id,
                None,
            );
        }
        (0, size, false)
    };
    let mut bytes = Vec::with_capacity(length as usize);
    if file.seek(SeekFrom::Start(start)).is_err()
        || file.take(length).read_to_end(&mut bytes).is_err()
        || bytes.len() != length as usize
    {
        return missing();
    }
    let content_range = partial.then(|| format!("bytes {start}-{}/{size}", start + length - 1));
    response(
        if partial { 206 } else { 200 },
        mime,
        bytes,
        id,
        content_range,
    )
}

/// Every component is opened relative to a held directory descriptor, refusing
/// symlinks. Canonicalize-then-read alone could race an agent replacing a link.
fn open_asset(root: &File, relative: &str) -> Option<File> {
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        let components: Vec<_> = Path::new(relative).components().collect();
        if components.is_empty() {
            return None;
        }
        let mut directory = root.try_clone().ok()?;
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return None;
            };
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::CString::new(name.as_bytes()).ok()?;
            let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
            if index + 1 < components.len() {
                flags |= libc::O_DIRECTORY;
            }
            let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return None;
            }
            directory = unsafe { File::from_raw_fd(fd) };
        }
        Some(directory)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, relative);
        None
    }
}

fn asset_mime(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "ogg" => Some("audio/ogg"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if size == 0 || end.contains(',') {
        return None;
    }
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().ok()?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().ok()?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || start > end {
        return None;
    }
    Some((start, end.min(start.saturating_add(MAX_ASSET_BYTES - 1))))
}

fn encode_path(path: &str) -> String {
    let mut output = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            output.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(output, "%{byte:02X}");
        }
    }
    output
}

fn decode_path(path: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(path.len());
    let mut input = path.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let a = (input.next()? as char).to_digit(16)?;
            let b = (input.next()? as char).to_digit(16)?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    if decoded.is_empty()
        || decoded.contains(['\\', '\0'])
        || decoded
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(decoded)
}

fn response(
    status: u16,
    mime: &str,
    body: Vec<u8>,
    id: &str,
    range: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let assets = if id.is_empty() {
        String::new()
    } else {
        format!("monoartifact://localhost/file-preview/{id}/ http://monoartifact.localhost/file-preview/{id}/ https://monoartifact.localhost/file-preview/{id}/")
    };
    let csp = format!("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' {assets}; style-src 'unsafe-inline' {assets}; img-src data: blob: {assets}; font-src data: {assets}; media-src data: blob: {assets}; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'");
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", csp)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Access-Control-Allow-Origin", "*")
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len().to_string());
    if let Some(range) = range {
        builder = builder.header("Content-Range", range);
    }
    builder.body(body).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("monocode-html-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("pages/assets")).unwrap();
            std::fs::write(root.join("pages/index.html"), "disk source").unwrap();
            Self(root)
        }
        fn create(&self, store: &HtmlPreviews, source: &str) -> PreviewLocation {
            store
                .create(
                    "main",
                    source.into(),
                    self.0.join("pages/index.html").to_str().unwrap(),
                    self.0.to_str().unwrap(),
                )
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn request(path: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .uri(format!("monoartifact://localhost/{path}"))
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn drafts_are_opaque_unique_and_removed_only_by_owner() {
        let store = HtmlPreviews::default();
        let first = store
            .create("main", "Draft".into(), "remote://file", "remote://root")
            .unwrap();
        let second = store.create("window-2", "Other".into(), "", "").unwrap();
        assert_ne!(first.id, second.id);
        assert!(uuid::Uuid::parse_str(&first.id).is_ok());
        assert!(!first.local_assets);
        store.remove("window-2", &first.id);
        assert!(store.get(&first.id).is_some());
        store.remove("main", &first.id);
        assert!(store.get(&first.id).is_none());
        store.remove_window("window-2");
        assert!(store.get(&second.id).is_none());
    }

    #[test]
    fn closed_window_rejects_a_queued_create_and_releases_owner_state() {
        let store = HtmlPreviews::default();
        let pending = store.begin_create("window-2").unwrap();
        let visible = store
            .create("window-2", "already loaded".into(), "", "")
            .unwrap();
        store.remove_window("window-2");
        assert!(store.begin_create_if_live("window-2", || false).is_err());
        assert!(store
            .create_pending(&pending, "queued draft".into(), "", "")
            .is_err());
        assert!(store.get(&visible.id).is_none());
        let state = store.0.lock().unwrap();
        assert!(state.previews.is_empty());
        assert!(state.owners.is_empty());
    }

    #[test]
    fn reopened_window_label_gets_a_new_generation_and_rejects_old_work() {
        let store = HtmlPreviews::default();
        let old = store.begin_create("window-2").unwrap();
        store.remove_window("window-2");
        let reopened = store.begin_create("window-2").unwrap();
        assert!(!Arc::ptr_eq(&old.generation, &reopened.generation));
        assert!(store
            .create_pending(&old, "old draft".into(), "", "")
            .is_err());
        let current = store
            .create_pending(&reopened, "current draft".into(), "", "")
            .unwrap();
        assert_eq!(
            store.get(&current.id).unwrap().source.as_str(),
            "current draft"
        );
        store.remove_window("window-2");
        for index in 0..100 {
            let owner = format!("window-{index}");
            store.begin_create(&owner).unwrap();
            store.remove_window(&owner);
        }
        let state = store.0.lock().unwrap();
        assert!(state.previews.is_empty());
        assert!(state.owners.is_empty());
    }

    #[test]
    fn memory_limits_reject_new_pages_without_evicting_live_assets() {
        let store = HtmlPreviews::default();
        assert!(store
            .create("main", "x".repeat(MAX_SOURCE_BYTES + 1), "", "")
            .is_err());
        let first = store
            .create("main", "x".repeat(MAX_SOURCE_BYTES), "", "")
            .unwrap();
        for _ in 0..3 {
            store
                .create("main", "x".repeat(MAX_SOURCE_BYTES), "", "")
                .unwrap();
        }
        assert!(store.create("main", "x".into(), "", "").is_err());
        assert!(store.get(&first.id).is_some());
        store.remove_window("main");
        for _ in 0..MAX_PREVIEWS {
            store.create("main", String::new(), "", "").unwrap();
        }
        assert!(store.create("main", String::new(), "", "").is_err());
    }

    #[test]
    fn five_mb_source_is_accepted_and_oversized_error_says_8_mb() {
        let store = HtmlPreviews::default();
        assert!(store
            .create("main", "x".repeat(5 * 1024 * 1024), "", "")
            .is_ok());
        let error = store
            .create("main", "x".repeat(MAX_SOURCE_BYTES + 1), "", "")
            .err()
            .expect("oversized source must be rejected");
        assert_eq!(
            error,
            "HTML preview supports files up to 8 MB. Open Code to read this file."
        );
    }

    #[test]
    fn serves_draft_and_isolated_csp_not_disk_source() {
        let fixture = Fixture::new();
        let store = HtmlPreviews::default();
        let location = fixture.create(&store, "<!doctype html><script>window.example = 1</script>");
        let page = serve_request(&store, &request(&location.url_path));
        assert_eq!(page.status(), 200);
        assert_eq!(
            page.body(),
            b"<!doctype html><script>window.example = 1</script>"
        );
        let csp = page.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.starts_with("sandbox allow-scripts;"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains(&format!("/file-preview/{}/", location.id)));
        assert!(!csp.contains("https:;"));
    }

    #[cfg(unix)]
    #[test]
    fn serves_only_project_assets_and_blocks_encoded_traversal_and_secrets() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("pages/assets/site.css"), "body{color:red}").unwrap();
        std::fs::write(fixture.0.join("private.json"), "secret").unwrap();
        let store = HtmlPreviews::default();
        let location = fixture.create(&store, "draft");
        assert!(location.local_assets);
        let asset = |path: &str| request(&format!("file-preview/{}/{path}", location.id));
        let css = serve_request(&store, &asset("pages/assets/site.css"));
        assert_eq!(css.status(), 200);
        assert_eq!(css.body(), b"body{color:red}");
        assert_eq!(css.headers()["Content-Type"], "text/css; charset=utf-8");
        for path in [
            "private.json",
            "../secret.css",
            "%2e%2e/secret.css",
            "pages/%2e%2e/%2e%2e/secret.css",
            "pages%5cassets%5csite.css",
            "pages/assets/site.css%00",
        ] {
            assert_eq!(serve_request(&store, &asset(path)).status(), 404, "{path}");
        }
        let mut post = asset("pages/assets/site.css");
        *post.method_mut() = tauri::http::Method::POST;
        assert_eq!(serve_request(&store, &post).status(), 404);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_files_and_directories_even_if_swapped_after_registration() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        std::fs::write(outside.0.join("secret.js"), "secret").unwrap();
        let store = HtmlPreviews::default();
        let location = fixture.create(&store, "draft");
        symlink(
            outside.0.join("secret.js"),
            fixture.0.join("pages/assets/leak.js"),
        )
        .unwrap();
        symlink(&outside.0, fixture.0.join("outside")).unwrap();
        for path in ["pages/assets/leak.js", "outside/secret.js"] {
            let req = request(&format!("file-preview/{}/{path}", location.id));
            assert_eq!(serve_request(&store, &req).status(), 404);
        }
        let outside_source = store
            .create(
                "main",
                "draft".into(),
                outside.0.join("pages/index.html").to_str().unwrap(),
                fixture.0.to_str().unwrap(),
            )
            .unwrap();
        assert!(!outside_source.local_assets);
    }

    #[cfg(unix)]
    #[test]
    fn media_ranges_support_seek_and_reject_invalid_ranges() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("pages/assets/demo.mp4"), b"0123456789").unwrap();
        let store = HtmlPreviews::default();
        let location = fixture.create(&store, "draft");
        let mut req = request(&format!(
            "file-preview/{}/pages/assets/demo.mp4",
            location.id
        ));
        req.headers_mut()
            .insert("Range", "bytes=2-5".parse().unwrap());
        let page = serve_request(&store, &req);
        assert_eq!(page.status(), 206);
        assert_eq!(page.body(), b"2345");
        assert_eq!(page.headers()["Content-Range"], "bytes 2-5/10");
        req.headers_mut()
            .insert("Range", "bytes=11-".parse().unwrap());
        assert_eq!(serve_request(&store, &req).status(), 416);
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=2-", 10), Some((2, 9)));
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }

    #[test]
    fn url_paths_round_trip_unicode_spaces_and_delimiters() {
        let path = "pages/my #1% design/visualé.html";
        assert_eq!(decode_path(&encode_path(path)).as_deref(), Some(path));
        assert!(decode_path("%GG").is_none());
        assert!(decode_path("/root.css").is_none());
        assert!(decode_path("%FF").is_none());
    }
}
