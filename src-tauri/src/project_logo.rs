use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::fs::expand_home;

const MAX_LOGO_BYTES: u64 = 2 * 1024 * 1024;
const ALLOWED_EXT: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

fn project_logos_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("project-logos");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Projects are keyed by their full path, which sanitizing alone cannot keep
/// apart: `a-b/c` and `a/b/c` both collapse to `a-b-c`, and a deep checkout can
/// outgrow the filesystem's name limit. So every stem carries a hash of the
/// whole key and keeps only as much of its readable tail as fits.
const MAX_STEM_CHARS: usize = 96;
/// `-` plus the hex hash.
const HASH_CHARS: usize = 17;

fn fnv1a(value: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn sanitize_project_key(project: &str) -> String {
    let trimmed = project.trim();
    if trimmed.is_empty() {
        return "project".into();
    }
    let safe: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let head = MAX_STEM_CHARS - HASH_CHARS;
    let readable: String = if safe.chars().count() <= head {
        safe
    } else {
        safe.chars().skip(safe.chars().count() - head).collect()
    };
    format!("{readable}-{:016x}", fnv1a(trimmed))
}

fn logo_stem(project: &str) -> String {
    sanitize_project_key(project)
}

fn remove_existing_logos(dir: &Path, project: &str) -> Result<(), String> {
    let stem = logo_stem(project);
    let prefix = format!("{stem}.");
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == stem || name.starts_with(&prefix) {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn logo_extension(source: &Path) -> Result<String, String> {
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err("Logo must be a PNG, JPG, GIF, WebP, or SVG image.".into());
    }
    Ok(ext)
}

struct LogoSource {
    file: File,
    ext: String,
}

impl LogoSource {
    // Metadata, the size limit and the actual bytes all come from one opened
    // handle. No validated path is reopened, even if its ancestors are moved.
    fn read_bytes(self) -> Result<Vec<u8>, String> {
        let meta = self.file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Not a file".into());
        }
        let too_large = || {
            format!(
                "Logo is too large (maximum {} MB).",
                MAX_LOGO_BYTES / 1024 / 1024
            )
        };
        if meta.len() > MAX_LOGO_BYTES {
            return Err(too_large());
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        self.file
            .take(MAX_LOGO_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_LOGO_BYTES {
            return Err(too_large());
        }
        Ok(bytes)
    }
}

fn save_project_logo_sync(
    app: &AppHandle,
    project: &str,
    source: LogoSource,
) -> Result<String, String> {
    let ext = source.ext.clone();
    let bytes = source.read_bytes()?;

    let dir = project_logos_dir(app)?;
    let stem = logo_stem(project);
    let dest = dir.join(format!("{stem}.{ext}"));
    let temp = dir.join(format!(".{stem}-upload"));

    // Read before removing the old logo so re-selecting the saved file still works.
    std::fs::write(&temp, bytes).map_err(|e| format!("{}: {e}", temp.display()))?;
    remove_existing_logos(&dir, project)?;
    std::fs::rename(&temp, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

fn remove_project_logo_sync(app: &AppHandle, project: &str) -> Result<(), String> {
    let dir = project_logos_dir(app)?;
    remove_existing_logos(&dir, project)
}

// Each component is anchored to its already-opened parent and cannot be a
// symlink. This also secures the project root against replacement after its
// canonical path is resolved. The returned descriptor is the one we copy.
#[cfg(unix)]
fn open_logo_without_symlinks(root: &File, relative: &Path) -> Result<File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;
    let components: Vec<_> = relative.components().collect();
    let mut directory = root.try_clone().map_err(|e| e.to_string())?;
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err("Project logo path must stay inside this project".into());
        };
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|e| e.to_string())?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        if index + 1 < components.len() {
            flags |= libc::O_DIRECTORY;
        }
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(format!(
                "Cannot open project logo: {}",
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

fn project_logo_source(project_root: &str, source_path: &str) -> Result<LogoSource, String> {
    #[cfg(unix)]
    {
        let root = expand_home(project_root)
            .canonicalize()
            .map_err(|e| format!("Project folder: {e}"))?;
        let source = expand_home(source_path);
        let source = if source.is_absolute() {
            source
        } else {
            root.join(source)
        };
        let source = source.canonicalize().map_err(|e| format!("Logo: {e}"))?;
        let relative = source
            .strip_prefix(&root)
            .map_err(|_| "Project logo must be a file inside this project")?;
        let ext = logo_extension(&source)?;
        let filesystem = File::open("/").map_err(|e| e.to_string())?;
        let root = open_logo_without_symlinks(
            &filesystem,
            root.strip_prefix("/").map_err(|e| e.to_string())?,
        )?;
        if !root.metadata().map_err(|e| e.to_string())?.is_dir() {
            return Err("Choose a local project folder first".into());
        }
        let file = open_logo_without_symlinks(&root, relative)?;
        Ok(LogoSource { file, ext })
    }
    #[cfg(not(unix))]
    {
        let _ = (project_root, source_path);
        // Fail closed until a handle-relative no-reparse-point implementation
        // is available. The manual file chooser remains available everywhere.
        Err("Agent logo changes require macOS or Linux. Use the project logo picker on this platform.".into())
    }
}

fn picked_logo_source(source_path: &str) -> Result<LogoSource, String> {
    let path = expand_home(source_path);
    let ext = logo_extension(&path)?;
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A picker may return a FIFO (or link to one). Open without waiting
        // for a writer, then let same-handle metadata reject non-regular files.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(LogoSource { file, ext })
}

#[tauri::command]
pub async fn save_project_logo(
    app: AppHandle,
    project: String,
    source_path: String,
    project_root: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = match project_root {
            Some(root) => project_logo_source(&root, &source_path)?,
            None => picked_logo_source(&source_path)?,
        };
        save_project_logo_sync(&app, &project, source)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drops a logo file the app itself copied in. Logos saved before the key scheme
/// changed live under a stem we can no longer derive, so the caller hands us the
/// path it had stored; anything outside the logo directory is ignored.
fn forget_logo_file_sync(app: &AppHandle, path: &str) -> Result<(), String> {
    let dir = project_logos_dir(app)?;
    let file = expand_home(path);
    if file.parent() != Some(dir.as_path()) || !file.is_file() {
        return Ok(());
    }
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn forget_logo_file(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || forget_logo_file_sync(&app, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_project_logo(app: AppHandle, project: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_project_logo_sync(&app, &project))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn agent_logo_paths_stay_in_the_selected_project() {
        let dir = std::env::temp_dir().join(format!("monocode-logo-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("project");
        let sibling = dir.join("project-other");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let logo = root.join("assets/logo.svg");
        std::fs::write(&logo, "<svg/>").unwrap();
        std::fs::write(sibling.join("logo.svg"), "<svg/>").unwrap();
        let root_str = root.to_str().unwrap();
        assert_eq!(
            project_logo_source(root_str, "assets/logo.svg")
                .unwrap()
                .read_bytes()
                .unwrap(),
            b"<svg/>"
        );
        assert_eq!(
            project_logo_source(root_str, logo.to_str().unwrap())
                .unwrap()
                .read_bytes()
                .unwrap(),
            b"<svg/>"
        );
        assert!(project_logo_source(root_str, "../project-other/logo.svg").is_err());
        assert!(project_logo_source(root_str, "missing.svg").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(sibling.join("logo.svg"), root.join("escaped.svg")).unwrap();
            assert!(project_logo_source(root_str, "escaped.svg").is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn opened_agent_logo_survives_file_and_ancestor_symlink_swaps() {
        for swap_ancestor in [false, true] {
            let dir =
                std::env::temp_dir().join(format!("monocode-logo-race-{}", uuid::Uuid::new_v4()));
            let root = dir.join("project");
            let assets = root.join("assets");
            let outside = dir.join("outside");
            std::fs::create_dir_all(&assets).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(assets.join("logo.svg"), b"original project image").unwrap();
            std::fs::write(outside.join("logo.svg"), b"private outside file").unwrap();

            // Exactly the object save_project_logo_sync receives. Replace a
            // path after authorization/open but before metadata and copying.
            let opened = project_logo_source(root.to_str().unwrap(), "assets/logo.svg").unwrap();
            let anchored_root = File::open(&root).unwrap();
            if swap_ancestor {
                std::fs::rename(&assets, root.join("original-assets")).unwrap();
                std::os::unix::fs::symlink(&outside, &assets).unwrap();
            } else {
                std::fs::rename(assets.join("logo.svg"), assets.join("original.svg")).unwrap();
                std::os::unix::fs::symlink(outside.join("logo.svg"), assets.join("logo.svg"))
                    .unwrap();
            }
            assert_eq!(opened.read_bytes().unwrap(), b"original project image");
            // If the swap lands before the leaf has been opened, no-follow
            // traversal rejects both the leaf and intermediate symlink cases.
            assert!(
                open_logo_without_symlinks(&anchored_root, Path::new("assets/logo.svg")).is_err()
            );
            assert!(project_logo_source(root.to_str().unwrap(), "assets/logo.svg").is_err());
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn logo_bytes_are_bounded_and_require_a_regular_file() {
        let dir =
            std::env::temp_dir().join(format!("monocode-logo-limit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.svg");
        File::create(&path)
            .unwrap()
            .set_len(MAX_LOGO_BYTES + 1)
            .unwrap();
        let source = LogoSource {
            file: File::open(&path).unwrap(),
            ext: "svg".into(),
        };
        assert!(source.read_bytes().unwrap_err().contains("too large"));
        #[cfg(unix)]
        {
            let directory = LogoSource {
                file: File::open(&dir).unwrap(),
                ext: "svg".into(),
            };
            assert!(directory.read_bytes().unwrap_err().contains("Not a file"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn picked_fifo_or_symlink_is_rejected_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        use std::sync::mpsc;
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("monocode-logo-fifo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("pipe.svg");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let linked = dir.join("linked.svg");
        std::os::unix::fs::symlink(&fifo, &linked).unwrap();
        for path in [&fifo, &linked] {
            let path = path.to_string_lossy().into_owned();
            let (sender, receiver) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = picked_logo_source(&path).and_then(LogoSource::read_bytes);
                sender.send(result).unwrap();
            });
            let result = receiver.recv_timeout(Duration::from_secs(2));
            let mut returned = result.is_ok();
            if matches!(result, Err(mpsc::RecvTimeoutError::Timeout)) {
                // Try to unblock the old implementation before failing. Both
                // opening the recovery writer and waiting remain bounded.
                let _writer = match std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&fifo)
                {
                    Ok(writer) => Some(writer),
                    Err(error) if error.raw_os_error() == Some(libc::ENXIO) => None,
                    Err(error) => panic!("Cannot unblock FIFO regression: {error}"),
                };
                returned = receiver.recv_timeout(Duration::from_secs(2)).is_ok();
            }
            if returned || worker.is_finished() {
                worker.join().unwrap();
            }
            if result.is_err() {
                std::fs::remove_dir_all(&dir).unwrap();
            }
            assert!(result
                .expect("opening a picked FIFO must not block")
                .unwrap_err()
                .contains("Not a file"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sanitize_project_key_replaces_unsafe_characters() {
        assert!(sanitize_project_key("agent-terminal").starts_with("agent-terminal-"));
        assert!(sanitize_project_key("foo/bar").starts_with("foo-bar-"));
        assert_eq!(sanitize_project_key("  "), "project");
    }

    #[test]
    fn sanitize_project_key_separates_paths_that_sanitize_alike() {
        // `-` survives and `/` becomes `-`, so only the hash tells these apart.
        assert_ne!(
            sanitize_project_key("/Users/me/cortex-finance/agentbase"),
            sanitize_project_key("/Users/me/cortex/finance/agentbase"),
        );
        // A sibling folder cannot be a filename prefix of its neighbour either.
        let stem = sanitize_project_key("/Users/me/proj");
        assert!(!sanitize_project_key("/Users/me/proj.old").starts_with(&format!("{stem}.")));
    }

    #[test]
    fn sanitize_project_key_shortens_long_paths_without_colliding() {
        let base = "/Users/me/".to_string() + &"deep/".repeat(40);
        let a = sanitize_project_key(&format!("{base}agentbase"));
        let b = sanitize_project_key(&format!("{base}other/agentbase"));
        assert!(a.chars().count() <= MAX_STEM_CHARS);
        assert!(b.chars().count() <= MAX_STEM_CHARS);
        assert_ne!(a, b);
        assert_eq!(a, sanitize_project_key(&format!("{base}agentbase")));
    }
}
