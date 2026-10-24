//! Fork feature: keeps the personal build current however MonoCode is opened.
//! At launch it starts `fork/update.sh` through the `monocode` launcher, which
//! builds and stages a new version; as it quits it leaves the launcher waiting
//! to swap the staged build in, so the next open, from the Dock or anywhere,
//! runs it. Only the app installed in /Applications does this, never a dev
//! build.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

const INSTALLED_APP: &str = "/Applications/MonoCode.app";

static QUIT_HANDLED: AtomicBool = AtomicBool::new(false);

fn is_installed_app(exe: &Path) -> bool {
    exe.starts_with(INSTALLED_APP)
}

fn launcher() -> Option<PathBuf> {
    if !is_installed_app(&std::env::current_exe().ok()?) {
        return None;
    }
    let path = PathBuf::from(crate::dirs_home()?).join(".local/bin/monocode");
    path.exists().then_some(path)
}

fn run(args: &[&str]) -> Option<std::process::Child> {
    let launcher = launcher()?;
    Command::new("/bin/zsh")
        .arg(launcher)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Own process group, so it outlives the app's quit.
        .process_group(0)
        .spawn()
        .ok()
}

/// At launch: build and stage a newer version in the background.
pub fn start() {
    if let Some(mut child) = run(&["--update"]) {
        // It returns at once (update.sh runs detached); reap it.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// As the app quits: swap a staged build in once this process is gone.
/// Called from more than one quit path; only the first call acts.
pub fn on_quit() {
    if QUIT_HANDLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let pid = std::process::id().to_string();
    let _ = run(&["--after-quit", &pid]);
}

#[cfg(test)]
mod tests {
    use super::is_installed_app;
    use std::path::Path;

    #[test]
    fn only_the_installed_app_counts() {
        assert!(is_installed_app(Path::new(
            "/Applications/MonoCode.app/Contents/MacOS/monocode"
        )));
        assert!(!is_installed_app(Path::new(
            "/Applications/MonoCode.app.old/Contents/MacOS/monocode"
        )));
        assert!(!is_installed_app(Path::new(
            "/Users/me/monocode/src-tauri/target/debug/monocode"
        )));
    }
}
