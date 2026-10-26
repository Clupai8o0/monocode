//! Fork feature: which live agent session is editing which file, from the
//! vault's `claims.py list --json DIR`, for the tags on file tabs and
//! Explorer rows. Read-only: nothing here claims or releases a file.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;

use crate::dirs_home;
use crate::fork_poll_cache::PollCache;
use crate::fork_stacks::{last_line, run};

const SCRIPT: &str = "Documents/Obsidian/brain/30-resources/_meta/claude-shared/hooks/claims.py";
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
// Every window polls independently; share the expensive Python process.
static LIST_CACHE: LazyLock<PollCache<Option<Value>>> =
    LazyLock::new(|| PollCache::new(Duration::from_secs(10)));

/// What `claims.py list --json DIR` printed, or `None` when the script isn't there.
#[tauri::command]
pub async fn fork_claims_list(dir: String) -> Result<Option<Value>, String> {
    if !valid_dir(&dir) {
        return Err("bad folder".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        LIST_CACHE.get_or_load(&dir, || {
            let Some(script) = script() else {
                return Ok(None);
            };
            let (ok, out) = run(&script, &["list", "--json", &dir], LIST_TIMEOUT)?;
            if !ok {
                return Err(last_line(&out).unwrap_or_else(|| "claims.py list failed".into()));
            }
            serde_json::from_slice(&out)
                .map(Some)
                .map_err(|e| format!("claims.py list printed bad JSON: {e}"))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn script() -> Option<PathBuf> {
    let path = PathBuf::from(dirs_home()?).join(SCRIPT);
    path.is_file().then_some(path)
}

/// An absolute folder that exists; it is passed to the script as one argument.
fn valid_dir(dir: &str) -> bool {
    let path = Path::new(dir);
    dir.len() <= 4096 && !dir.contains('\0') && path.is_absolute() && path.is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_folders() {
        let here = std::env::current_dir().unwrap();
        assert!(valid_dir(here.to_str().unwrap()));
        assert!(!valid_dir("relative/path"));
        assert!(!valid_dir("--json"));
        assert!(!valid_dir(""));
        assert!(!valid_dir("/no/such/folder/for/claims"));
        assert!(!valid_dir(here.join("Cargo.toml").to_str().unwrap()));
    }
}
