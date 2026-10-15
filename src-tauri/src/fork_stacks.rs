//! Fork feature: the shared Docker stacks and devices from the vault's
//! `stacks.py` (`list --json` and `stop NAME`), for the footer's Stacks panel.
//!
//! The script path is fixed here, under the home folder; the webview only
//! names a stack, and the name is checked before it reaches the command line.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::dirs_home;
use crate::fork_statusline::{exited_by, kill_group};

const SCRIPT: &str = "Documents/Obsidian/brain/30-resources/_meta/claude-shared/hooks/stacks.py";
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
// stacks.py waits up to 300 s for the stack's lock, then compose stop can take 300 s more.
const STOP_TIMEOUT: Duration = Duration::from_secs(660);
const MAX_OUTPUT: u64 = 256 * 1024;

/// What `stacks.py list --json` printed, or `None` when the script isn't there.
#[tauri::command]
pub async fn fork_stacks_list() -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(script) = script() else {
            return Ok(None);
        };
        let (ok, out) = run(&script, &["list", "--json"], LIST_TIMEOUT)?;
        if !ok {
            return Err(last_line(&out).unwrap_or_else(|| "stacks.py list failed".into()));
        }
        serde_json::from_slice(&out)
            .map(Some)
            .map_err(|e| format!("stacks.py list printed bad JSON: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops a stack or device whoever holds it; returns the script's last line.
#[tauri::command]
pub async fn fork_stacks_stop(name: String) -> Result<String, String> {
    if !valid_name(&name) {
        return Err("bad stack name".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let script = script().ok_or("stacks.py not found")?;
        let (ok, out) = run(&script, &["stop", &name, "from MonoCode"], STOP_TIMEOUT)?;
        let line = last_line(&out).unwrap_or_default();
        if ok {
            Ok(line)
        } else {
            Err(if line.is_empty() { "stop failed".into() } else { line })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn script() -> Option<PathBuf> {
    let path = PathBuf::from(dirs_home()?).join(SCRIPT);
    path.is_file().then_some(path)
}

fn python() -> &'static str {
    // Homebrew's first: the vault's hooks expect a current Python 3.
    ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .unwrap_or("/usr/bin/python3")
}

/// Runs the script; (exited 0, stdout with stderr after it).
pub(crate) fn run(
    script: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, Vec<u8>), String> {
    let label = script
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cmd = Command::new(python());
    cmd.arg(script)
        .args(args)
        .current_dir(script.parent().unwrap_or(Path::new("/")))
        .env("PATH", crate::harness::gui_search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so a timeout also stops docker or simctl under it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label} failed to start: {e}"))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    if !exited_by(&mut child, deadline) {
        kill_group(&mut child);
        let _ = child.wait();
        return Err(format!("{label} timed out"));
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    // A child it left running may hold the pipes open; don't wait on it.
    let grace = Duration::from_secs(2);
    let mut out = stdout.recv_timeout(grace).unwrap_or_default();
    if !ok {
        out.extend(stderr.recv_timeout(grace).unwrap_or_default());
    }
    Ok((ok, out))
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT).read_to_end(&mut out);
        }
        let _ = tx.send(out);
    });
    rx
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

pub(crate) fn last_line(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let line = text.lines().rev().find(|line| !line.trim().is_empty())?;
    Some(line.trim().chars().take(300).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_stack_names() {
        assert!(valid_name("panoptic-phase-pos"));
        assert!(valid_name("android_lite.2"));
        assert!(!valid_name(""));
        assert!(!valid_name("-rf"));
        assert!(!valid_name("a b"));
        assert!(!valid_name("a;rm"));
        assert!(!valid_name(&"a".repeat(65)));
    }

    #[test]
    fn keeps_the_last_non_empty_line() {
        assert_eq!(last_line(b"one\ntwo\n\n").as_deref(), Some("two"));
        assert_eq!(last_line(b"  \n"), None);
    }
}
