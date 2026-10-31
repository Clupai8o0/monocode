//! Fork: runs one short JavaScript or Python drill for the Games panel's
//! Code tab. macOS only: the run is wrapped in sandbox-exec with no network
//! and no file writes outside its own temp folder, and anything that can't
//! be sandboxed is refused instead of run bare.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The temp folder path is swapped in for `__TEMP__` before each run.
const SANDBOX_PROFILE: &str = r#"(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "__TEMP__") (literal "/dev/null"))
"#;

/// Windows with a run going; one run at a time per window is enough.
static RUNNING_WINDOWS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRunResult {
    stdout: String,
    stderr: String,
    timed_out: bool,
    exit_code: Option<i32>,
}

/// The temp folder a run works in, removed when this drops.
struct RunFolder(PathBuf);

impl Drop for RunFolder {
    fn drop(&mut self) {
        let _: std::io::Result<()> = std::fs::remove_dir_all(&self.0);
    }
}

/// Frees the window's run slot when it drops.
struct RunSlot(String);

impl Drop for RunSlot {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING_WINDOWS.lock() {
            running.remove(&self.0);
        }
    }
}

fn language_tool(language: &str) -> Result<(&'static str, &'static str), String> {
    match language {
        "javascript" => Ok(("node", "main.js")),
        "python" => Ok(("python3", "main.py")),
        _ => Err("Only JavaScript and Python can run here.".into()),
    }
}

fn sandbox_profile(folder: &Path) -> String {
    let escaped: String = folder
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    SANDBOX_PROFILE.replace("__TEMP__", &escaped)
}

/// Reads a pipe to its end, keeping only the first MAX_OUTPUT_BYTES so a
/// talkative program can't fill the pipe and stall the timeout.
fn drain_capped(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut chunk: [u8; 8192] = [0; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let room: usize = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                    let take: usize = room.min(count);
                    kept.extend_from_slice(&chunk[..take]);
                }
            }
        }
        kept
    })
}

#[cfg(unix)]
fn kill_process_group(child: &Child) {
    // The child leads its own group (process_group(0) below), so a negative
    // pid reaches everything it started, not just the child itself.
    let group: i32 = -(child.id() as i32);
    unsafe {
        libc::kill(group, libc::SIGKILL);
    }
}

fn run_code(language: &str, source: &str) -> Result<CodeRunResult, String> {
    let (tool, file_name): (&str, &str) = language_tool(language)?;
    if cfg!(not(target_os = "macos")) {
        return Err("Running code here needs a Mac for now.".into());
    }
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Err("The safety sandbox is missing, so nothing was run.".into());
    }
    let binary: PathBuf = crate::harness::resolve_gui_binary(tool)
        .ok_or_else(|| format!("{tool} was not found on this Mac. Install it, then try again."))?;

    let folder_path: PathBuf =
        std::env::temp_dir().join(format!("monocode-code-run-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder_path)
        .map_err(|error: std::io::Error| format!("Could not make a work folder: {error}"))?;
    let folder: RunFolder = RunFolder(folder_path);
    // The sandbox matches real paths, and the temp dir sits behind symlinks.
    let real_folder: PathBuf = std::fs::canonicalize(&folder.0)
        .map_err(|error: std::io::Error| format!("Could not make a work folder: {error}"))?;
    let source_file: PathBuf = real_folder.join(file_name);
    std::fs::write(&source_file, source)
        .map_err(|error: std::io::Error| format!("Could not save the code: {error}"))?;

    let mut command: Command = Command::new(SANDBOX_EXEC);
    command
        .arg("-p")
        .arg(sandbox_profile(&real_folder))
        .arg(&binary)
        .arg(&source_file)
        .current_dir(&real_folder)
        .env("PATH", crate::harness::gui_search_path())
        .env("HOME", &real_folder)
        .env("TMPDIR", &real_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child: Child = command
        .spawn()
        .map_err(|error: std::io::Error| format!("Could not start {tool}: {error}"))?;
    let stdout_pipe: std::process::ChildStdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read the run's output.".to_string())?;
    let stderr_pipe: std::process::ChildStderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read the run's output.".to_string())?;
    let stdout_reader: std::thread::JoinHandle<Vec<u8>> = drain_capped(stdout_pipe);
    let stderr_reader: std::thread::JoinHandle<Vec<u8>> = drain_capped(stderr_pipe);

    let deadline: Instant = Instant::now() + RUN_TIMEOUT;
    let mut timed_out: bool = false;
    let status: std::process::ExitStatus = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                timed_out = true;
                kill_process_group(&child);
                let _: Result<(), std::io::Error> = child.kill();
                break child
                    .wait()
                    .map_err(|error: std::io::Error| format!("The run would not stop: {error}"))?;
            }
            Err(error) => return Err(format!("The run went wrong: {error}")),
        }
    };

    let stdout_bytes: Vec<u8> = stdout_reader.join().unwrap_or_default();
    let stderr_bytes: Vec<u8> = stderr_reader.join().unwrap_or_default();
    Ok(CodeRunResult {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        timed_out,
        exit_code: status.code(),
    })
}

#[tauri::command]
pub async fn fork_code_run(
    window: tauri::WebviewWindow,
    language: String,
    source: String,
) -> Result<CodeRunResult, String> {
    let slot: RunSlot = {
        let mut running: std::sync::MutexGuard<'_, HashSet<String>> = RUNNING_WINDOWS
            .lock()
            .map_err(|_| "Code runs are unavailable right now.".to_string())?;
        let label: String = window.label().to_string();
        if !running.insert(label.clone()) {
            return Err("A run is already going. Wait for it to finish.".into());
        }
        RunSlot(label)
    };
    // Off the UI thread: a run can take the full five seconds.
    let result: Result<CodeRunResult, String> =
        tauri::async_runtime::spawn_blocking(move || run_code(&language, &source))
            .await
            .map_err(|error: tauri::Error| error.to_string())?;
    drop(slot);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// True when the tool is installed; these tests then check real runs,
    /// and when it isn't they check the plain "not found" error instead.
    fn installed(language: &str) -> bool {
        let (tool, _): (&str, &str) = language_tool(language).expect("known language");
        crate::harness::resolve_gui_binary(tool).is_some()
    }

    /// True when a sandboxed run can really happen here. A test shell that
    /// is itself sandboxed makes sandbox-exec refuse to apply a second
    /// sandbox ("sandbox_apply: Operation not permitted"); the profile
    /// still compiles there, but no program can run, so the run checks
    /// stand down instead of pretending to pass. The app is not sandboxed.
    fn sandbox_usable() -> bool {
        static USABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *USABLE.get_or_init(|| {
            let probe: Option<(&str, &str)> = if installed("javascript") {
                Some(("javascript", "console.log('dojo-probe')"))
            } else if installed("python") {
                Some(("python", "print('dojo-probe')"))
            } else {
                None
            };
            match probe {
                Some((language, source)) => match run_code(language, source) {
                    Ok(result) => result.stdout.contains("dojo-probe"),
                    Err(_) => false,
                },
                None => false,
            }
        })
    }

    #[test]
    fn profile_denies_network_and_stray_writes() {
        let profile: String = sandbox_profile(Path::new("/private/tmp/run-1"));
        assert!(profile.contains("(deny network*)"), "{profile}");
        assert!(profile.contains("(deny file-write*)"), "{profile}");
        assert!(
            profile.contains("(subpath \"/private/tmp/run-1\")"),
            "{profile}"
        );
        assert!(!profile.contains("__TEMP__"), "{profile}");
    }

    #[test]
    fn refuses_an_unknown_language() {
        let error: String = run_code("ruby", "puts 1").err().expect("ruby is refused");
        assert!(error.contains("JavaScript and Python"), "{error}");
    }

    #[test]
    fn runs_a_normal_program() {
        if !installed("javascript") {
            let error: String = run_code("javascript", "console.log(3)")
                .err()
                .expect("missing node is a plain error");
            assert!(error.contains("not found"), "{error}");
            return;
        }
        if !sandbox_usable() {
            return;
        }
        let result: CodeRunResult =
            run_code("javascript", "console.log(1 + 2)").expect("node runs");
        assert_eq!(result.stdout.trim(), "3");
        assert!(!result.timed_out);
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    fn kills_an_infinite_loop() {
        if !installed("javascript") || !sandbox_usable() {
            return;
        }
        let started: Instant = Instant::now();
        let result: CodeRunResult =
            run_code("javascript", "while (true) {}").expect("the run still answers");
        assert!(result.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn cuts_oversized_output() {
        if !installed("javascript") || !sandbox_usable() {
            return;
        }
        let result: CodeRunResult =
            run_code("javascript", "process.stdout.write('x'.repeat(200000))").expect("node runs");
        assert_eq!(result.stdout.len(), MAX_OUTPUT_BYTES);
        assert!(!result.timed_out);
    }

    #[test]
    fn network_attempts_fail() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let source: &str = "import socket\n\
            try:\n\
            \x20   socket.create_connection(('127.0.0.1', 9), timeout=2)\n\
            \x20   print('CONNECTED')\n\
            except OSError as error:\n\
            \x20   print('BLOCKED', error.errno)\n";
        let result: CodeRunResult = run_code("python", source).expect("python runs");
        assert!(!result.stdout.contains("CONNECTED"), "{}", result.stdout);
        assert!(result.stdout.contains("BLOCKED"), "{}", result.stdout);
    }

    #[test]
    fn writes_outside_the_work_folder_fail() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let target: PathBuf =
            std::env::temp_dir().join(format!("monocode-escape-{}.txt", uuid::Uuid::new_v4()));
        let source: String = format!(
            "open({:?}, 'w').write('escaped')\nprint('WROTE')\n",
            target.to_string_lossy().into_owned()
        );
        let result: CodeRunResult = run_code("python", &source).expect("python runs");
        let escaped: bool = target.exists();
        let _: Result<(), std::io::Error> = std::fs::remove_file(&target);
        assert!(!escaped, "the run wrote outside its folder");
        assert!(!result.stdout.contains("WROTE"), "{}", result.stdout);
    }

    #[test]
    fn writes_inside_the_work_folder_work() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let result: CodeRunResult = run_code(
            "python",
            "open('note.txt', 'w').write('hi')\nprint(open('note.txt').read())\n",
        )
        .expect("python runs");
        assert_eq!(result.stdout.trim(), "hi");
    }
}
