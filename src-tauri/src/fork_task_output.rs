//! Fork: bounded reads of Claude's local background-command output files.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_TAIL_BYTES: usize = 32 * 1024;

#[derive(Debug, serde::Serialize)]
pub struct TaskOutputTail {
    text: String,
    truncated: bool,
    size: u64,
}

#[tauri::command]
pub async fn fork_task_output_tail(path: String) -> Result<Option<TaskOutputTail>, String> {
    crate::background_work::read(move || {
        read_tail(
            &PathBuf::from(path),
            &[std::env::temp_dir(), PathBuf::from("/tmp")],
        )
    })
    .await?
}

fn read_tail(path: &Path, roots: &[PathBuf]) -> Result<Option<TaskOutputTail>, String> {
    match read_tail_inner(path, roots) {
        Ok(tail) => Ok(Some(tail)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_tail_inner(path: &Path, roots: &[PathBuf]) -> io::Result<TaskOutputTail> {
    let path = path.canonicalize()?;
    let refused = || io::Error::new(io::ErrorKind::PermissionDenied, "Refused task output path");
    if !fs::metadata(&path)?.is_file()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".output"))
        || path.parent().and_then(Path::file_name) != Some(std::ffi::OsStr::new("tasks"))
    {
        return Err(refused());
    }
    let root = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .find(|root| {
            path.strip_prefix(root)
                .ok()
                .and_then(Path::parent)
                .is_some_and(|relative| {
                    relative.components().any(|part| {
                        part.as_os_str()
                            .to_str()
                            .and_then(|name| name.strip_prefix("claude-"))
                            .is_some_and(|suffix| !suffix.is_empty())
                    })
                })
        })
        .ok_or_else(refused)?;
    let mut file = open_output(&root, path.strip_prefix(&root).map_err(|_| refused())?)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(refused());
    }
    let size = metadata.len();
    let offset = size.saturating_sub(MAX_TAIL_BYTES as u64);
    let mut partial_line = false;
    if offset > 0 {
        // Preserve a full first line when the byte limit lands just after '\n'.
        file.seek(SeekFrom::Start(offset - 1))?;
        let mut previous = [0];
        file.read_exact(&mut previous)?;
        partial_line = previous[0] != b'\n';
    } else {
        file.seek(SeekFrom::Start(0))?;
    }
    let mut bytes = Vec::with_capacity((size - offset) as usize);
    // Bound the read even if the command keeps appending while we read it.
    file.take(size - offset).read_to_end(&mut bytes)?;
    let start = if partial_line { tail_start(&bytes) } else { 0 };
    Ok(TaskOutputTail {
        text: String::from_utf8_lossy(&bytes[start..]).into_owned(),
        truncated: offset > 0,
        size,
    })
}

/// Where the readable part starts when the cut landed mid-line: after the first
/// newline, or, if that would leave nothing (one huge line, like a progress bar
/// or a line just ended), at the first whole character.
fn tail_start(bytes: &[u8]) -> usize {
    match bytes.iter().position(|byte| *byte == b'\n') {
        Some(index) if index + 1 < bytes.len() => index + 1,
        _ => bytes
            .iter()
            .position(|byte| byte & 0xC0 != 0x80)
            .unwrap_or(0),
    }
}

#[cfg(unix)]
fn open_output(root: &Path, relative: &Path) -> io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    // Anchor each open to its directory descriptor. A symlink swapped in after
    // canonicalization cannot redirect a parent or the file outside that root.
    let mut file = File::open(root)?;
    let mut parts = relative.components().peekable();
    while let Some(part) = parts.next() {
        let name = std::ffi::CString::new(part.as_os_str().as_bytes())?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        if parts.peek().is_some() {
            flags |= libc::O_DIRECTORY;
        }
        // SAFETY: the directory descriptor and NUL-terminated name are valid.
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned a new descriptor, now owned only by this File.
        file = unsafe { File::from_raw_fd(fd) };
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_output(root: &Path, relative: &Path) -> io::Result<File> {
    File::open(root.join(relative))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            Self::at(&std::env::temp_dir())
        }

        fn at(root: &Path) -> Self {
            let path = root.join(format!("monocode-task-output-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, relative: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }

        fn read(&self, path: &Path) -> Result<Option<TaskOutputTail>, String> {
            read_tail(path, std::slice::from_ref(&self.0))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn short_file() {
        let fixture = Fixture::new();
        let path = fixture.file(
            "claude-501/project/session/tasks/b1.output",
            "hello\nworld\n",
        );
        let tail = fixture.read(&path).unwrap().unwrap();
        assert_eq!(tail.text, "hello\nworld\n");
        assert!(!tail.truncated);
        assert_eq!(tail.size, 12);
    }

    #[test]
    fn accepts_the_system_temp_root() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/session/tasks/b1.output", "hello");
        let tail = read_tail(&path, &[std::env::temp_dir(), PathBuf::from("/tmp")])
            .unwrap()
            .unwrap();
        assert_eq!(tail.text, "hello");
    }

    #[cfg(unix)]
    #[test]
    fn accepts_tmp_even_when_the_system_temp_root_differs() {
        let fixture = Fixture::at(Path::new("/tmp"));
        let path = fixture.file("claude-501/session/tasks/b1.output", "hello");
        let tail = read_tail(&path, &[std::env::temp_dir(), PathBuf::from("/tmp")])
            .unwrap()
            .unwrap();
        assert_eq!(tail.text, "hello");
    }

    #[test]
    fn long_file_drops_the_partial_first_line() {
        let fixture = Fixture::new();
        let text = format!("{}\nlast line\n", "x".repeat(MAX_TAIL_BYTES + 100));
        let path = fixture.file("claude-501/tasks/b1.output", &text);
        let tail = fixture.read(&path).unwrap().unwrap();
        assert_eq!(tail.text, "last line\n");
        assert!(tail.truncated);
        assert_eq!(tail.size, text.len() as u64);
        assert!(tail.text.len() <= MAX_TAIL_BYTES);
    }

    #[test]
    fn preserves_a_complete_line_at_the_tail_boundary() {
        let fixture = Fixture::new();
        let suffix = "x".repeat(MAX_TAIL_BYTES);
        let path = fixture.file("claude-501/tasks/b1.output", format!("first\n{suffix}"));
        let tail = fixture.read(&path).unwrap().unwrap();
        assert_eq!(tail.text, suffix);
        assert!(tail.truncated);
    }

    #[test]
    fn exact_limit_and_empty_files_are_not_truncated() {
        let fixture = Fixture::new();
        for text in [String::new(), "x".repeat(MAX_TAIL_BYTES)] {
            let path = fixture.file("claude-501/tasks/b1.output", &text);
            let tail = fixture.read(&path).unwrap().unwrap();
            assert_eq!(tail.text, text);
            assert_eq!(tail.size, text.len() as u64);
            assert!(!tail.truncated);
        }
    }

    #[test]
    fn multibyte_character_cut_at_the_boundary() {
        let fixture = Fixture::new();
        // The tail starts on the second byte of the first euro sign.
        let suffix = format!("{}ab", "€".repeat((MAX_TAIL_BYTES - 3) / 3));
        let text = format!("€\n{suffix}");
        assert_eq!(text.len(), MAX_TAIL_BYTES + 1);
        let path = fixture.file("claude-501/tasks/b1.output", &text);
        let tail = fixture.read(&path).unwrap().unwrap();
        assert_eq!(tail.text, suffix);
        assert!(!tail.text.contains('\u{fffd}'));
        assert!(tail.truncated);
        assert_eq!(tail.size, text.len() as u64);
    }

    #[test]
    fn decodes_invalid_utf8_lossily() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/tasks/b1.output", b"hi\xff\n");
        assert_eq!(fixture.read(&path).unwrap().unwrap().text, "hi\u{fffd}\n");
    }

    #[test]
    fn a_single_oversized_line_keeps_its_tail() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/tasks/b1.output", vec![b'x'; MAX_TAIL_BYTES + 1]);
        let tail = fixture.read(&path).unwrap().unwrap();
        assert_eq!(tail.text.len(), MAX_TAIL_BYTES);
        assert!(tail.truncated);
    }

    #[test]
    fn an_oversized_line_that_just_ended_keeps_its_tail() {
        let fixture = Fixture::new();
        let text = format!("{}\n", "x".repeat(MAX_TAIL_BYTES + 1));
        let path = fixture.file("claude-501/tasks/b1.output", &text);
        let tail = fixture.read(&path).unwrap().unwrap();
        assert_eq!(tail.text.len(), MAX_TAIL_BYTES);
        assert!(tail.text.ends_with("x\n"));
        assert!(tail.truncated);
    }

    #[test]
    fn an_oversized_line_starts_on_a_whole_character() {
        let fixture = Fixture::new();
        // The cut lands inside a euro sign and the tail has no newline to skip to.
        let text = "€".repeat(MAX_TAIL_BYTES / 3 + 1);
        let path = fixture.file("claude-501/tasks/b1.output", &text);
        let tail = fixture.read(&path).unwrap().unwrap();
        assert!(!tail.text.is_empty());
        assert!(!tail.text.contains('\u{fffd}'));
        assert!(tail.truncated);
    }

    #[test]
    fn missing_file_and_missing_parent_return_none() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/tasks/b1.output", "");
        fs::remove_file(&path).unwrap();
        assert!(fixture.read(&path).unwrap().is_none());
        fs::remove_dir(path.parent().unwrap()).unwrap();
        assert!(fixture.read(&path).unwrap().is_none());
    }

    #[test]
    fn refuses_files_without_the_output_suffix() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/tasks/id_rsa", "secret");
        assert!(fixture.read(&path).is_err());
    }

    #[test]
    fn refuses_files_outside_a_tasks_folder() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/not-tasks/b1.output", "secret");
        assert!(fixture.read(&path).is_err());
    }

    #[test]
    fn refuses_files_without_a_claude_folder_suffix() {
        let fixture = Fixture::new();
        for folder in ["not-claude-501", "claude", "claude-"] {
            let path = fixture.file(&format!("{folder}/tasks/b1.output"), "secret");
            assert!(fixture.read(&path).is_err(), "{folder}");
        }
    }

    #[test]
    fn refuses_files_outside_the_canonical_root() {
        let fixture = Fixture::new();
        let allowed = fixture.0.join("allowed");
        fs::create_dir(&allowed).unwrap();
        let path = fixture.file("allowed-sibling/claude-501/tasks/b1.output", "secret");
        assert!(read_tail(&path, &[allowed]).is_err());
    }

    #[test]
    fn refuses_directories() {
        let fixture = Fixture::new();
        let path = fixture.0.join("claude-501/tasks/b1.output");
        fs::create_dir_all(&path).unwrap();
        assert!(fixture.read(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_escaping_the_root() {
        let fixture = Fixture::new();
        let target = fixture.file("outside/claude-501/tasks/b1.output", "secret");
        let link = fixture.file("allowed/claude-501/tasks/b1.output", "");
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(read_tail(&link, &[fixture.0.join("allowed")]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_hiding_an_invalid_filename() {
        let fixture = Fixture::new();
        let target = fixture.file("claude-501/tasks/id_rsa", "secret");
        let link = target.with_file_name("b1.output");
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(fixture.read(&link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlink_only_to_an_allowed_output_file() {
        let fixture = Fixture::new();
        let target = fixture.file("claude-501/tasks/b1.output", "hello");
        let link = fixture.0.join("alias");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(fixture.read(&link).unwrap().unwrap().text, "hello");
        fs::remove_file(target).unwrap();
        assert!(fixture.read(&link).unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_parent_symlink_swapped_in_after_validation() {
        let fixture = Fixture::new();
        let path = fixture.file("allowed/claude-501/tasks/b1.output", "hello");
        let target = fixture.file("outside/tasks/b1.output", "secret");
        let parent = path.parent().unwrap();
        fs::rename(parent, parent.with_file_name("old-tasks")).unwrap();
        std::os::unix::fs::symlink(target.parent().unwrap(), parent).unwrap();
        let root = fixture.0.join("allowed").canonicalize().unwrap();
        assert!(open_output(&root, Path::new("claude-501/tasks/b1.output")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_fifo_without_opening_it() {
        use std::os::unix::ffi::OsStrExt;
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/tasks/b1.output", "");
        fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(fixture.read(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_device() {
        let fixture = Fixture::new();
        let path = fixture.file("claude-501/tasks/b1.output", "");
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/dev/null", &path).unwrap();
        assert!(fixture.read(&path).is_err());
    }
}
