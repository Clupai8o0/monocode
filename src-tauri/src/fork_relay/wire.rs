//! Claude's peer wire: NDJSON lines of at most 1 MiB. An optional auth line
//! may come first; the relay drops it and never sends one.

use std::io::Read;
use std::path::PathBuf;

use serde_json::Value;

pub(crate) const MAX_LINE: usize = 1024 * 1024;

/// Cuts a byte stream into lines. A line longer than [`MAX_LINE`] is dropped
/// whole, up to its newline.
#[derive(Default)]
pub(crate) struct Lines {
    buf: Vec<u8>,
    overflow: bool,
}

impl Lines {
    /// Feeds bytes; answers the lines they completed.
    pub fn push(&mut self, mut chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut done = Vec::new();
        while let Some(at) = chunk.iter().position(|&b| b == b'\n') {
            if !self.overflow && self.buf.len() + at <= MAX_LINE {
                self.buf.extend_from_slice(&chunk[..at]);
                done.push(std::mem::take(&mut self.buf));
            }
            self.buf.clear();
            self.overflow = false;
            chunk = &chunk[at + 1..];
        }
        if !self.overflow {
            if self.buf.len() + chunk.len() > MAX_LINE {
                self.overflow = true;
                self.buf = Vec::new();
            } else {
                self.buf.extend_from_slice(chunk);
            }
        }
        done
    }

    /// The last line, when the stream ended without a newline.
    pub fn finish(self) -> Option<Vec<u8>> {
        (!self.overflow && !self.buf.is_empty()).then_some(self.buf)
    }
}

/// Reads a connection to its end (or until it stalls past its read timeout),
/// handing each line on as soon as it is complete.
pub(crate) fn read_lines(mut stream: impl Read, mut each: impl FnMut(String)) {
    let mut lines = Lines::default();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut hand_on = |line: Vec<u8>| {
        if let Ok(line) = String::from_utf8(line) {
            each(line);
        }
    };
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => lines.push(&chunk[..n]).into_iter().for_each(&mut hand_on),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
    if let Some(line) = lines.finish() {
        hand_on(line);
    }
}

/// The socket a frame says it comes from (`"from": "uds:<path>"`), or None
/// for a line the relay drops: an auth line, or anything that is not a
/// frame from a local socket.
pub(crate) fn sender(line: &str) -> Option<PathBuf> {
    let frame: Value = serde_json::from_str(line.trim()).ok()?;
    if frame["type"].as_str() == Some("auth") {
        return None;
    }
    let path = frame["from"].as_str()?.strip_prefix("uds:")?;
    (path.starts_with('/') && !path.contains('\0')).then(|| PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_and_drops_ones_over_a_mebibyte() {
        let mut lines = Lines::default();
        assert_eq!(lines.push(b"ab"), Vec::<Vec<u8>>::new());
        assert_eq!(
            lines.push(b"c\nde\n\nf"),
            vec![b"abc".to_vec(), b"de".to_vec(), vec![]]
        );
        assert_eq!(lines.finish(), Some(b"f".to_vec()));

        // Exactly the cap passes; one byte more is dropped, in one chunk or
        // spread over several, and the next line still arrives.
        let mut lines = Lines::default();
        let fits = vec![b'x'; MAX_LINE];
        let mut input = fits.clone();
        input.push(b'\n');
        assert_eq!(lines.push(&input), vec![fits]);
        let mut too_long = vec![b'y'; MAX_LINE + 1];
        too_long.extend_from_slice(b"\nok\n");
        assert_eq!(lines.push(&too_long), vec![b"ok".to_vec()]);
        for _ in 0..3 {
            assert!(lines.push(&vec![b'z'; MAX_LINE / 2]).is_empty());
        }
        assert_eq!(lines.push(b"tail\nnext\n"), vec![b"next".to_vec()]);
        assert!(lines.push(&vec![b'w'; MAX_LINE + 5]).is_empty());
        assert_eq!(lines.finish(), None);
    }

    #[test]
    fn reads_every_line_of_a_connection() {
        let input = b"{\"type\":\"auth\",\"token\":\"t\"}\none\n\xff\xfe\nlast".to_vec();
        let mut got = Vec::new();
        read_lines(&input[..], |line| got.push(line));
        assert_eq!(got, vec![r#"{"type":"auth","token":"t"}"#, "one", "last"]);
    }

    #[test]
    fn only_frames_from_a_local_socket_are_relayed() {
        assert_eq!(
            sender(r#"{"type":"user","from":"uds:/tmp/cc-socks/1.sock","msg_id":"m"}"#),
            Some(PathBuf::from("/tmp/cc-socks/1.sock"))
        );
        assert_eq!(
            sender(
                r#"{"type":"control","action":"peer_message_status","from":"uds:/tmp/cc-socks/2-0123abcd.sock"}"#
            ),
            Some(PathBuf::from("/tmp/cc-socks/2-0123abcd.sock"))
        );
        for line in [
            r#"{"type":"auth","token":"secret","from":"uds:/tmp/cc-socks/1.sock"}"#,
            r#"{"type":"user","from":"tcp:1.2.3.4"}"#,
            r#"{"type":"user","from":"uds:relative.sock"}"#,
            r#"{"type":"user"}"#,
            "not json",
            "",
        ] {
            assert_eq!(sender(line), None, "{line}");
        }
    }
}
