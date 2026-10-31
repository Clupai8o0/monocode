//! Fork: runs one short JavaScript or Python drill for the Games panel's
//! Code tab. macOS only: the run is wrapped in sandbox-exec with no network
//! and no file writes outside its own temp folder, and anything that can't
//! be sandboxed is refused instead of run bare.

use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::ffi::OsStr;
#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::sync::{LazyLock, Mutex};
#[cfg(target_os = "macos")]
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
const RUN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The temp folder, home folder and interpreter folders are swapped in
/// before each run. Seatbelt is last-match-wins, so every allow comes after
/// the deny it opens.
#[cfg(target_os = "macos")]
const SANDBOX_PROFILE: &str = r#"(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* __TEMP__ (literal "/dev/null"))
(deny process-fork)
(deny process-exec*)
__EXEC__
(deny appleevent-send)
(deny lsopen)
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
__HOME_DENY__
(allow file-read-data __TEMP____READ__)
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
    /// Stdout was longer than MAX_OUTPUT_BYTES, so its start is gone.
    truncated: bool,
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

/// A path as an SBPL string literal.
#[cfg(target_os = "macos")]
fn sandbox_literal(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

#[cfg(target_os = "macos")]
fn sandbox_subpath(path: &Path) -> String {
    format!("(subpath {})", sandbox_literal(path))
}

/// The interpreter's own folder: the version root for a Cellar `bin`, the
/// framework root for a Python, or the folder holding it.
#[cfg(target_os = "macos")]
fn install_folder(binary: &Path) -> PathBuf {
    let parent: &Path = binary.parent().unwrap_or(binary);
    if parent.file_name() == Some(OsStr::new("bin")) {
        parent.parent().unwrap_or(parent).to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

/// True for the command-line-tools shim, which execs xcrun on its way to a
/// Python under /Library/Developer or Xcode.
#[cfg(target_os = "macos")]
fn is_python_shim(binary: &Path) -> bool {
    binary == Path::new("/usr/bin/python3")
}

/// True when `folder` is `home` or one of its ancestors. Allowing such a
/// folder for reads would undo the home deny.
#[cfg(target_os = "macos")]
fn covers_folder(folder: &Path, home: &Path) -> bool {
    home == folder || home.starts_with(folder)
}

#[cfg(target_os = "macos")]
fn sandbox_profile(folder: &Path, binary: &Path) -> String {
    let tool: PathBuf = std::fs::canonicalize(binary).unwrap_or_else(|_| binary.to_path_buf());
    let home: Option<PathBuf> = crate::dirs_home().map(|home| {
        let path: &Path = Path::new(home.as_str());
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    });

    // The exec path is checked as written and after links are followed, so
    // both spellings of a Homebrew or nvm binary are allowed.
    let mut tools: Vec<&Path> = vec![binary];
    if tool.as_path() != binary {
        tools.push(tool.as_path());
    }

    let mut exec: Vec<String> = Vec::new();
    let mut read: Vec<String> = Vec::new();
    for path in &tools {
        exec.push(format!(
            "(allow process-exec (literal {}))",
            sandbox_literal(path)
        ));
        read.push(format!("(literal {})", sandbox_literal(path)));
    }
    let install: PathBuf = install_folder(&tool);
    let reopens_home: bool = home
        .as_ref()
        .is_some_and(|home| covers_folder(&install, home));
    if install.as_path() != Path::new("/") && !reopens_home {
        read.push(sandbox_subpath(&install));
    }

    if tools.iter().any(|path| is_python_shim(path)) {
        exec.push(format!(
            "(allow process-exec (literal {}))",
            sandbox_literal(Path::new("/usr/bin/xcrun"))
        ));
        for root in [
            "/Library/Developer",
            "/Applications/Xcode.app/Contents/Developer",
        ] {
            let path: &Path = Path::new(root);
            if path.is_dir() {
                exec.push(format!(
                    "(allow process-exec (subpath {}))",
                    sandbox_literal(path)
                ));
                read.push(sandbox_subpath(path));
            }
        }
    }

    exec.sort();
    exec.dedup();
    read.sort();
    read.dedup();
    let home_deny: String = home
        .as_ref()
        .map(|home| format!("(deny file-read-data {})", sandbox_subpath(home)))
        .unwrap_or_default();

    SANDBOX_PROFILE
        .replace("__TEMP__", &sandbox_subpath(folder))
        .replace("__EXEC__", &exec.join("\n"))
        .replace("__HOME_DENY__", &home_deny)
        .replace("__READ__", &format!(" {}", read.join(" ")))
}

/// The run's child. Dropping it before it was reaped kills its whole group,
/// so every early return closes the pipes and frees the window's run slot.
#[cfg(target_os = "macos")]
struct RunChild {
    child: Child,
    reaped: bool,
}

#[cfg(target_os = "macos")]
impl RunChild {
    fn new(child: Child) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status: Option<std::process::ExitStatus> = self.child.try_wait()?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }

    /// Stops everything the child started, not just the child itself.
    fn stop(&mut self) -> Option<std::process::ExitStatus> {
        if self.reaped {
            return None;
        }
        kill_process_group(&self.child);
        let _: Result<(), std::io::Error> = self.child.kill();
        let status: Option<std::process::ExitStatus> = self.child.wait().ok();
        self.reaped = true;
        status
    }
}

#[cfg(target_os = "macos")]
impl Drop for RunChild {
    fn drop(&mut self) {
        let _: Option<std::process::ExitStatus> = self.stop();
    }
}

#[cfg(target_os = "macos")]
impl std::ops::Deref for RunChild {
    type Target = Child;

    fn deref(&self) -> &Child {
        &self.child
    }
}

#[cfg(target_os = "macos")]
impl std::ops::DerefMut for RunChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

#[cfg(target_os = "macos")]
fn kill_process_group(child: &Child) {
    // The child leads its own group (process_group(0) below), so a negative
    // pid reaches everything it started, not just the child itself.
    let group: i32 = -(child.id() as i32);
    unsafe {
        libc::kill(group, libc::SIGKILL);
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
    done: bool,
}

/// Keeps only the last MAX_OUTPUT_BYTES, so a talkative program can't hide
/// the result lines it prints at the end.
#[cfg(target_os = "macos")]
fn keep_tail(captured: &mut Captured, chunk: &[u8]) {
    captured.bytes.extend_from_slice(chunk);
    if captured.bytes.len() > MAX_OUTPUT_BYTES {
        let excess: usize = captured.bytes.len() - MAX_OUTPUT_BYTES;
        let _ = captured.bytes.drain(..excess);
        captured.truncated = true;
    }
}

/// Reads a pipe to its end, keeping the tail in a small shared buffer so the
/// main thread can stop waiting at the deadline without joining anything.
#[cfg(target_os = "macos")]
fn drain_capped(mut pipe: impl Read + Send + 'static) -> (Arc<Mutex<Captured>>, JoinHandle<()>) {
    let captured: Arc<Mutex<Captured>> = Arc::new(Mutex::new(Captured::default()));
    let sink: Arc<Mutex<Captured>> = Arc::clone(&captured);
    let handle: JoinHandle<()> = std::thread::spawn(move || {
        let mut chunk: [u8; 8192] = [0; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let mut out = sink
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    keep_tail(&mut out, &chunk[..count]);
                }
            }
        }
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .done = true;
    });
    (captured, handle)
}

#[cfg(target_os = "macos")]
fn readers_done(readers: &[&Arc<Mutex<Captured>>]) -> bool {
    readers.iter().all(|captured| {
        captured
            .lock()
            .map(|out| out.done)
            // A poisoned reader is not going to finish either.
            .unwrap_or(true)
    })
}

#[cfg(target_os = "macos")]
fn captured_bytes(captured: &Arc<Mutex<Captured>>) -> (Vec<u8>, bool) {
    let out = captured
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (out.bytes.clone(), out.truncated)
}

#[cfg(target_os = "macos")]
fn run_code(language: &str, source: &str) -> Result<CodeRunResult, String> {
    let (tool, file_name): (&str, &str) = language_tool(language)?;
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
        .arg(sandbox_profile(&real_folder, &binary))
        .arg(&binary)
        .arg(&source_file)
        .current_dir(&real_folder)
        .env("PATH", crate::harness::gui_search_path())
        .env("HOME", &real_folder)
        .env("TMPDIR", &real_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child: RunChild = RunChild::new(
        command
            .spawn()
            .map_err(|error: std::io::Error| format!("Could not start {tool}: {error}"))?,
    );
    let stdout_pipe: std::process::ChildStdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read the run's output.".to_string())?;
    let stderr_pipe: std::process::ChildStderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read the run's output.".to_string())?;
    let (stdout_out, stdout_reader) = drain_capped(stdout_pipe);
    let (stderr_out, stderr_reader) = drain_capped(stderr_pipe);

    let deadline: Instant = Instant::now() + RUN_TIMEOUT;
    let mut timed_out: bool = false;
    let mut status: Option<std::process::ExitStatus> = None;
    loop {
        match child.try_wait() {
            Ok(Some(finished)) => {
                status = Some(finished);
                break;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                timed_out = true;
                status = child.stop();
                break;
            }
            Err(error) => {
                let _ = child.stop();
                return Err(format!("The run went wrong: {error}"));
            }
        }
    }

    // The child is gone, but its pipes may still be draining. Never wait for
    // a reader past the deadline: the buffers hold whatever arrived by then.
    while !readers_done(&[&stdout_out, &stderr_out]) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let drained: bool = readers_done(&[&stdout_out, &stderr_out]);
    if !drained {
        timed_out = true;
    } else {
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
    }

    let (stdout_bytes, truncated): (Vec<u8>, bool) = captured_bytes(&stdout_out);
    let (stderr_bytes, _): (Vec<u8>, bool) = captured_bytes(&stderr_out);
    Ok(CodeRunResult {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        timed_out,
        exit_code: status.and_then(|status| status.code()),
        truncated,
    })
}

#[cfg(not(target_os = "macos"))]
fn run_code(language: &str, _source: &str) -> Result<CodeRunResult, String> {
    let _: (&'static str, &'static str) = language_tool(language)?;
    Err("Running code here needs a Mac for now.".into())
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

    #[cfg(target_os = "macos")]
    #[test]
    fn profile_locks_down_the_sandbox() {
        let profile: String =
            sandbox_profile(Path::new("/private/tmp/run-1"), Path::new("/bin/sh"));
        assert!(profile.contains("(deny network*)"), "{profile}");
        assert!(profile.contains("(deny file-write*)"), "{profile}");
        assert!(profile.contains("(deny process-fork)"), "{profile}");
        assert!(profile.contains("(deny process-exec*)"), "{profile}");
        assert!(profile.contains("(deny appleevent-send)"), "{profile}");
        assert!(profile.contains("(deny lsopen)"), "{profile}");
        assert!(
            profile.contains("(global-name \"com.apple.coreservices.launchservicesd\")"),
            "{profile}"
        );
        assert!(
            profile.contains("(subpath \"/private/tmp/run-1\")"),
            "{profile}"
        );
        assert!(
            profile.contains("(allow process-exec (literal \"/bin/sh\"))"),
            "{profile}"
        );
        let home: PathBuf = crate::dirs_home()
            .map(PathBuf::from)
            .expect("home folder");
        let home: PathBuf = std::fs::canonicalize(&home).unwrap_or(home);
        assert!(
            profile.contains(&format!(
                "(deny file-read-data {})",
                sandbox_subpath(&home)
            )),
            "{profile}"
        );
        assert!(!profile.contains("__TEMP__"), "{profile}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn profile_lets_the_system_python_shim_start() {
        let profile: String = sandbox_profile(
            Path::new("/private/tmp/run-1"),
            Path::new("/usr/bin/python3"),
        );
        assert!(
            profile.contains("(allow process-exec (literal \"/usr/bin/xcrun\"))"),
            "{profile}"
        );
        if Path::new("/Library/Developer").is_dir() {
            assert!(
                profile.contains("(subpath \"/Library/Developer\")"),
                "{profile}"
            );
        }
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
        assert!(!result.truncated);
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    fn runs_a_normal_python_program() {
        if !installed("python") {
            let error: String = run_code("python", "print(3)")
                .err()
                .expect("missing python is a plain error");
            assert!(error.contains("not found"), "{error}");
            return;
        }
        if !sandbox_usable() {
            return;
        }
        let result: CodeRunResult =
            run_code("python", "print(1 + 2)").expect("python runs");
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
    fn a_run_after_a_timeout_still_starts() {
        if !installed("javascript") || !sandbox_usable() {
            return;
        }
        let first: CodeRunResult =
            run_code("javascript", "while (true) {}").expect("the run still answers");
        assert!(first.timed_out);
        let second: CodeRunResult =
            run_code("javascript", "console.log(4)").expect("the next run starts");
        assert_eq!(second.stdout.trim(), "4");
    }

    #[test]
    fn keeps_the_tail_of_oversized_output() {
        if !installed("javascript") || !sandbox_usable() {
            return;
        }
        let result: CodeRunResult = run_code(
            "javascript",
            "process.stdout.write('x'.repeat(200000)); process.stdout.write('THE-END')",
        )
        .expect("node runs");
        assert_eq!(result.stdout.len(), MAX_OUTPUT_BYTES);
        assert!(result.stdout.ends_with("THE-END"), "{}", result.stdout);
        assert!(result.truncated);
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
    fn open_is_blocked() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let source: &str = "import subprocess\n\
            try:\n\
            \x20   subprocess.run(['/usr/bin/open', '-a', 'Calculator'], check=True, timeout=2)\n\
            \x20   print('OPENED')\n\
            except Exception as error:\n\
            \x20   print('BLOCKED', type(error).__name__)\n";
        let result: CodeRunResult = run_code("python", source).expect("python runs");
        assert!(!result.stdout.contains("OPENED"), "{}", result.stdout);
        assert!(result.stdout.contains("BLOCKED"), "{}", result.stdout);
    }

    #[test]
    fn osascript_is_blocked() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let source: &str = "import subprocess\n\
            try:\n\
            \x20   subprocess.run(['/usr/bin/osascript', '-e', 'return \"OPENED\"'], check=True, timeout=2)\n\
            \x20   print('OPENED')\n\
            except Exception as error:\n\
            \x20   print('BLOCKED', type(error).__name__)\n";
        let result: CodeRunResult = run_code("python", source).expect("python runs");
        assert!(!result.stdout.contains("OPENED"), "{}", result.stdout);
        assert!(result.stdout.contains("BLOCKED"), "{}", result.stdout);
    }

    #[test]
    fn spawning_a_child_is_blocked() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let source: &str = "import subprocess\n\
            try:\n\
            \x20   subprocess.run(['/bin/echo', 'SPAWNED'], check=True, timeout=2)\n\
            \x20   print('SPAWNED')\n\
            except Exception as error:\n\
            \x20   print('BLOCKED', type(error).__name__)\n";
        let result: CodeRunResult = run_code("python", source).expect("python runs");
        assert!(!result.stdout.contains("SPAWNED"), "{}", result.stdout);
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
    fn reads_in_the_home_folder_fail() {
        if !installed("python") || !sandbox_usable() {
            return;
        }
        let home: PathBuf = PathBuf::from(crate::dirs_home().expect("home folder"));
        let target: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        // Only meaningful when the checkout itself is under the home folder.
        if !target.starts_with(&home) {
            return;
        }
        let target_text: String = target.to_string_lossy().into_owned();
        let source: String = format!(
            "try:\n\
            \x20   print('READ', len(open({target_text:?}, 'rb').read(8)))\n\
            except Exception as error:\n\
            \x20   print('BLOCKED', type(error).__name__)\n"
        );
        let result: CodeRunResult = run_code("python", &source).expect("python runs");
        assert!(!result.stdout.contains("READ"), "{}", result.stdout);
        assert!(result.stdout.contains("BLOCKED"), "{}", result.stdout);
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
