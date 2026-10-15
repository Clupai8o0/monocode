//! Fork feature: turn Word, PowerPoint and similar files into a PDF for the
//! read-only preview, with LibreOffice running headless.
//!
//! LibreOffice runs with its own profile in the cache folder, so it neither
//! clashes with a LibreOffice the user has open nor picks up their settings.
//! Its default macro security stays on: unsigned macros never run. The PDF is
//! kept per file and reused until the file changes.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;

use crate::dirs_home;
use crate::fork_statusline::{exited_by, kill_group};

const SOFFICE: [&str; 3] = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
];
const EXTENSIONS: [&str; 12] = [
    "doc", "docx", "odt", "rtf", "ppt", "pptx", "pps", "ppsx", "odp", "xls", "ods", "pages",
];
const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;

/// One conversion at a time: they share the LibreOffice profile.
static CONVERTING: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeResult {
    /// "ok", "no-office" or "failed".
    status: &'static str,
    pdf: Option<String>,
    message: Option<String>,
    cached: bool,
    millis: u64,
}

#[tauri::command]
pub async fn fork_office_convert(path: String) -> Result<OfficeResult, String> {
    tauri::async_runtime::spawn_blocking(move || convert(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

fn convert(path: &Path) -> Result<OfficeResult, String> {
    let started = Instant::now();
    if !path.is_absolute() || !is_office(path) || !path.is_file() {
        return Err("Not a document LibreOffice can open".into());
    }
    let path = &path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    if path.metadata().map_err(|e| e.to_string())?.len() > MAX_SOURCE_BYTES {
        return Err(format!("Files over {} MB are not previewed.", MAX_SOURCE_BYTES >> 20));
    }
    let mut result = OfficeResult { status: "ok", pdf: None, message: None, cached: false, millis: 0 };
    let Some(soffice) = SOFFICE.iter().map(Path::new).find(|p| p.is_file()) else {
        result.status = "no-office";
        return Ok(result);
    };

    let _guard = CONVERTING.lock().unwrap_or_else(|e| e.into_inner());
    // Stat after the wait: the file may have changed while another ran.
    let meta = path.metadata().map_err(|e| e.to_string())?;
    let base = cache_root()?;
    let out = base.join(hash_hex(path));
    std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let pdf = out.join(format!("{stem}.pdf"));
    let stamp_file = out.join("stamp");
    let stamp = stamp(&meta);
    if pdf.is_file() && std::fs::read_to_string(&stamp_file).is_ok_and(|s| s == stamp) {
        result.pdf = Some(pdf.to_string_lossy().into_owned());
        result.cached = true;
        result.millis = started.elapsed().as_millis() as u64;
        return Ok(result);
    }
    let _ = std::fs::remove_file(&pdf);
    let _ = std::fs::remove_file(&stamp_file);

    let profile = base.join("profile");
    let mut cmd = Command::new(soffice);
    cmd.arg(format!("-env:UserInstallation={}", file_url(&profile)))
        .args(["--headless", "--invisible", "--norestore", "--nolockcheck", "--nodefault"])
        .args(["--convert-to", "pdf", "--outdir"])
        .arg(&out)
        .arg(path)
        .current_dir(&out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("LibreOffice failed to start: {e}"))?;
    if !exited_by(&mut child, Instant::now() + RUN_TIMEOUT) {
        kill_group(&mut child);
        let _ = child.wait();
        result.status = "failed";
        result.message = Some(format!("LibreOffice took over {} s and was stopped.", RUN_TIMEOUT.as_secs()));
    } else if pdf.is_file() {
        let _ = std::fs::write(&stamp_file, stamp);
        result.pdf = Some(pdf.to_string_lossy().into_owned());
    } else {
        result.status = "failed";
        result.message = Some("LibreOffice could not convert this file.".into());
    }
    result.millis = started.elapsed().as_millis() as u64;
    Ok(result)
}

fn is_office(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn cache_root() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("No home folder")?;
    Ok(PathBuf::from(home).join("Library/Caches/monocode-fork/office"))
}

fn hash_hex(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Size and modified time: a changed file gets a fresh PDF.
fn stamp(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{}:{modified}", meta.len())
}

/// `file://` URL for LibreOffice's `-env:UserInstallation`.
fn file_url(path: &Path) -> String {
    let mut url = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                url.push(byte as char)
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_office_files() {
        assert!(is_office(Path::new("/p/Report.DOCX")));
        assert!(is_office(Path::new("/p/deck.pptx")));
        assert!(!is_office(Path::new("/p/sheet.xlsx")));
        assert!(!is_office(Path::new("/p/notes.md")));
    }

    #[test]
    fn escapes_profile_urls() {
        assert_eq!(
            file_url(Path::new("/Users/a b/Caches/π")),
            "file:///Users/a%20b/Caches/%CF%80"
        );
    }

    #[test]
    fn converts_and_caches_when_libreoffice_is_installed() {
        if !SOFFICE.iter().any(|p| Path::new(p).is_file()) {
            return;
        }
        let dir = std::env::temp_dir().join(format!("fork-office-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.rtf");
        std::fs::write(&file, "{\\rtf1\\ansi Hello from the fork.\\par}").unwrap();
        let first = convert(&file).unwrap();
        assert_eq!(first.status, "ok", "{first:?}");
        assert!(Path::new(first.pdf.as_deref().unwrap()).is_file());
        assert!(!first.cached);
        assert!(convert(&file).unwrap().cached);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(cache_root().unwrap().join(hash_hex(&file.canonicalize().unwrap_or(file))));
    }

    #[test]
    fn says_when_libreoffice_is_missing() {
        if SOFFICE.iter().any(|p| Path::new(p).is_file()) {
            return;
        }
        let dir = std::env::temp_dir().join("fork-office-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.docx");
        std::fs::write(&file, b"not really").unwrap();
        let result = convert(&file).unwrap();
        assert_eq!(result.status, "no-office");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
