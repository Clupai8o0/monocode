// Fork: local cache for files a remote machine "shows" on this computer.
//
// The desktop downloads a shown file in chunks over `shows.read` and appends
// each chunk here, then opens the returned local path as a file tab. Nothing
// in this module opens or runs a file.

use base64::Engine;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::Manager;

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 500 * 1024 * 1024;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_NAME_CHARS: usize = 120;

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let kept: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':'))
        .collect();
    let trimmed: String = kept
        .trim_start_matches('.')
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = trimmed.trim().to_owned();
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed
    }
}

fn shown_root_in(cache: &Path) -> PathBuf {
    cache.join("shown")
}

fn shown_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| shown_root_in(&dir))
        .map_err(|e| e.to_string())
}

fn write_chunk(
    root: &Path,
    machine_id: &str,
    item_id: &str,
    name: &str,
    offset: u64,
    data: &[u8],
) -> Result<PathBuf, String> {
    if !valid_id(machine_id) || !valid_id(item_id) {
        return Err("Invalid id".into());
    }
    let dir = root.join(machine_id).join(item_id);
    let path = dir.join(clean_name(name));
    let end = offset
        .checked_add(data.len() as u64)
        .ok_or("File too large")?;
    if end > MAX_FILE_BYTES {
        return Err("File is larger than 20 MiB".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = if offset == 0 {
        fs::File::create(&path).map_err(|e| e.to_string())?
    } else {
        let current = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if current != offset {
            return Err(format!("Offset {offset} does not match length {current}"));
        }
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?
    };
    file.write_all(data).map_err(|e| e.to_string())?;
    Ok(path)
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(m) if m.is_dir() => dir_size(&entry.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn prune(root: &Path, now: SystemTime, max_age: Duration, max_bytes: u64) {
    let mut items: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for machine in fs::read_dir(root).into_iter().flatten().flatten() {
        let machine_path = machine.path();
        if !machine_path.is_dir() {
            continue;
        }
        for item in fs::read_dir(&machine_path).into_iter().flatten().flatten() {
            let path = item.path();
            let Ok(meta) = item.metadata() else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let age = now.duration_since(modified).unwrap_or_default();
            if age > max_age {
                let _ = fs::remove_dir_all(&path);
            } else {
                items.push((modified, dir_size(&path), path));
            }
        }
        let _ = fs::remove_dir(&machine_path); // only succeeds when empty
    }
    items.sort_by_key(|(modified, _, _)| *modified);
    let mut total: u64 = items.iter().map(|(_, size, _)| size).sum();
    for (_, size, path) in items {
        if total <= max_bytes {
            break;
        }
        if fs::remove_dir_all(&path).is_ok() {
            total -= size;
        }
    }
}

#[tauri::command]
pub fn fork_shows_cache_write(
    app: tauri::AppHandle,
    machine_id: String,
    item_id: String,
    name: String,
    offset: u64,
    data: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let root = shown_root(&app)?;
    let path = write_chunk(&root, &machine_id, &item_id, &name, offset, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// The folder shown files are cached in, so the desktop can tell them apart
/// from the user's own files.
#[tauri::command]
pub fn fork_shows_cache_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(shown_root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fork_shows_cache_prune(app: tauri::AppHandle) -> Result<(), String> {
    let root = shown_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        prune(&root, SystemTime::now(), MAX_AGE, MAX_CACHE_BYTES)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fork-shows-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn root_is_the_shown_folder_chunks_are_written_under() {
        let cache = temp_root("root");
        let root = shown_root_in(&cache);
        assert_eq!(root, cache.join("shown"));
        let path = write_chunk(&root, "m", "i", "a.tex", 0, b"x").unwrap();
        assert!(path.starts_with(&root));
        fs::remove_dir_all(&cache).unwrap();
    }

    #[test]
    fn ids_are_checked() {
        assert!(valid_id("abc_DEF-123"));
        assert!(valid_id(&"a".repeat(64)));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
        assert!(!valid_id("../x"));
        assert!(!valid_id("a b"));
        assert!(!valid_id("a.b"));
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("report.pdf"), "report.pdf");
        assert_eq!(clean_name("/etc/passwd"), "passwd");
        assert_eq!(clean_name("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(clean_name("..hidden"), "hidden");
        assert_eq!(clean_name("a:b\u{0}c\nd"), "abcd");
        assert_eq!(clean_name(""), "file");
        assert_eq!(clean_name("..."), "file");
        assert_eq!(clean_name("dir/"), "file");
        assert_eq!(clean_name(&"x".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn chunks_append_at_matching_offsets() {
        let root = temp_root("offsets");
        let path = write_chunk(&root, "m1", "i1", "a.txt", 0, b"hello ").unwrap();
        assert!(path.is_absolute());
        assert!(path.starts_with(&root));
        write_chunk(&root, "m1", "i1", "a.txt", 6, b"world").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello world");
        assert!(write_chunk(&root, "m1", "i1", "a.txt", 3, b"x").is_err());
        assert!(write_chunk(&root, "m1", "i1", "b.txt", 4, b"x").is_err());
        write_chunk(&root, "m1", "i1", "a.txt", 0, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(write_chunk(&root, "../m", "i1", "a.txt", 0, b"x").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn refuses_past_cap() {
        let root = temp_root("cap");
        let big = vec![0u8; MAX_FILE_BYTES as usize];
        write_chunk(&root, "m", "i", "big.bin", 0, &big).unwrap();
        assert!(write_chunk(&root, "m", "i", "big.bin", MAX_FILE_BYTES, b"x").is_err());
        assert!(write_chunk(&root, "m", "j", "x", u64::MAX, b"x").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prunes_old_then_oldest() {
        let root = temp_root("prune");
        for (item, len) in [("a", 10usize), ("b", 10), ("c", 10)] {
            write_chunk(&root, "m", item, "f", 0, &vec![1u8; len]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let now = SystemTime::now();
        // Nothing is old enough; size cap of 20 drops only the oldest item.
        prune(&root, now, MAX_AGE, 20);
        assert!(!root.join("m/a").exists());
        assert!(root.join("m/b").exists());
        assert!(root.join("m/c").exists());
        // Everything is older than a zero age limit, once time moves on.
        prune(
            &root,
            now + Duration::from_secs(5),
            Duration::ZERO,
            u64::MAX,
        );
        assert!(!root.join("m").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
