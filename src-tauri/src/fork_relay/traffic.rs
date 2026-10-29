//! What the relay did with each line it carried: a ring of the last
//! TRAFFIC_MAX hops, in memory only (`RelayHop` in messageLogProtocol.ts).
//! Names, session ids and msg ids come from the frame; no socket path, pid
//! or token is kept.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fork_messages::{attr, clip, key_of, wrapper, Since};

pub(crate) const TRAFFIC_MAX: usize = 500;
const REASON_MAX: usize = 300;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayHop {
    pub id: String,
    pub seq: u64,
    pub at: i64,
    pub peer: String,
    pub direction: &'static str,
    pub kind: &'static str,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RelayTrafficParams {
    pub since: Option<Since>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTrafficAnswer {
    pub version: u8,
    pub machine: String,
    pub epoch: String,
    pub cursor: u64,
    pub enabled: bool,
    pub hops: Vec<RelayHop>,
}

/// One hop as the relay saw it, before it gets its id and place.
#[derive(Clone, Debug, Default)]
pub(crate) struct Seen {
    pub peer: String,
    pub direction: &'static str,
    pub outcome: &'static str,
    pub reason: Option<String>,
    pub from_session_id: Option<String>,
    pub to_session_id: Option<String>,
    pub to_name: Option<String>,
}

pub(crate) struct Recorder {
    epoch: String,
    seq: u64,
    hops: VecDeque<RelayHop>,
}

impl Recorder {
    pub fn new() -> Recorder {
        Recorder {
            epoch: uuid::Uuid::new_v4().to_string(),
            seq: 0,
            hops: VecDeque::new(),
        }
    }

    /// Records the line, when it is a message or a delivery receipt.
    pub fn record(&mut self, line: &str, seen: Seen, at: i64) {
        let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
            return;
        };
        let kind = match (frame["type"].as_str(), frame["action"].as_str()) {
            (Some("user"), _) => "message",
            (Some("control"), Some("peer_message_status")) => "receipt",
            _ => return,
        };
        let text = match &frame["message"]["content"] {
            Value::String(s) => Some(s.clone()),
            Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        };
        let wrapped = text.as_deref().and_then(wrapper);
        self.seq += 1;
        let hop = RelayHop {
            id: format!("{}-{}", self.epoch, self.seq),
            seq: self.seq,
            at,
            peer: seen.peer,
            direction: seen.direction,
            kind,
            outcome: seen.outcome,
            reason: seen.reason.and_then(|r| clip(&r, REASON_MAX)),
            from_name: wrapped
                .and_then(|(tag, _)| attr(tag, "from-name"))
                .and_then(|n| clip(&n, REASON_MAX)),
            to_name: seen.to_name.and_then(|n| clip(&n, REASON_MAX)),
            from_session_id: seen.from_session_id,
            to_session_id: seen.to_session_id,
            msg_id: frame["msg_id"].as_str().filter(|m| !m.is_empty()).map(str::to_string),
            key: wrapped.map(|(_, body)| key_of(body)).filter(|k| !k.is_empty()),
        };
        self.hops.push_back(hop);
        while self.hops.len() > TRAFFIC_MAX {
            self.hops.pop_front();
        }
    }

    pub fn answer(&self, since: Option<&Since>, machine: String, enabled: bool) -> RelayTrafficAnswer {
        let after = since.filter(|s| s.epoch == self.epoch).map_or(0, |s| s.cursor);
        RelayTrafficAnswer {
            version: 1,
            machine,
            epoch: self.epoch.clone(),
            cursor: self.seq,
            enabled,
            hops: self.hops.iter().filter(|h| h.seq > after).cloned().collect(),
        }
    }
}

static RECORDER: LazyLock<Mutex<Recorder>> = LazyLock::new(|| Mutex::new(Recorder::new()));

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub(crate) fn record(line: &str, seen: Seen) {
    RECORDER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .record(line, seen, now_ms());
}

pub(crate) fn answer(since: Option<&Since>, machine: String, enabled: bool) -> RelayTrafficAnswer {
    RECORDER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .answer(since, machine, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(n: usize) -> String {
        serde_json::json!({
            "type": "user",
            "msg_id": format!("m{n}"),
            "from": "uds:/tmp/cc-socks/1.sock",
            "message": {"role": "user", "content":
                "<cross-session-message from=\"uds:/tmp/cc-socks/1.sock\" from-name=\"alpha\">\n  hi   there\n</cross-session-message>"},
        })
        .to_string()
    }

    fn out(outcome: &'static str, reason: Option<&str>) -> Seen {
        Seen {
            peer: "vivobook".into(),
            direction: "out",
            outcome,
            reason: reason.map(str::to_string),
            from_session_id: Some("s1".into()),
            to_session_id: Some("r1".into()),
            to_name: Some("worker".into()),
        }
    }

    #[test]
    fn keeps_the_newest_hops_and_answers_since_a_cursor() {
        let mut rec = Recorder::new();
        assert_eq!(rec.answer(None, "mac".into(), false).cursor, 0);
        for n in 0..TRAFFIC_MAX + 3 {
            rec.record(&line(n), out("passed", None), 1000 + n as i64);
        }
        rec.record("not json", out("passed", None), 0);
        rec.record(r#"{"type":"auth","token":"t"}"#, out("passed", None), 0);
        let all = rec.answer(None, "mac".into(), true);
        assert_eq!(all.hops.len(), TRAFFIC_MAX);
        assert_eq!(all.cursor, (TRAFFIC_MAX + 3) as u64);
        assert_eq!(all.hops[0].seq, 4);
        let hop = &all.hops[0];
        assert_eq!(hop.key.as_deref(), Some("hi there"));
        assert_eq!(hop.from_name.as_deref(), Some("alpha"));
        assert_eq!(hop.msg_id.as_deref(), Some("m3"));
        assert_eq!(hop.kind, "message");
        let text = serde_json::to_string(&all).unwrap();
        assert!(!text.contains("cc-socks") && !text.contains("uds:/"));

        let since = Since {
            epoch: all.epoch.clone(),
            cursor: all.cursor - 1,
        };
        assert_eq!(rec.answer(Some(&since), "mac".into(), true).hops.len(), 1);
        let other = Since {
            epoch: "else".into(),
            cursor: all.cursor,
        };
        assert_eq!(rec.answer(Some(&other), "mac".into(), true).hops.len(), TRAFFIC_MAX);

        rec.record(
            r#"{"type":"control","action":"peer_message_status","msg_id":"m9","from":"uds:/x"}"#,
            out("dropped", Some("Could not reach vivobook")),
            5,
        );
        let last = rec.answer(Some(&since), "mac".into(), true).hops.pop().unwrap();
        assert_eq!(last.kind, "receipt");
        assert_eq!(last.outcome, "dropped");
        assert_eq!(last.reason.as_deref(), Some("Could not reach vivobook"));
        assert_eq!(last.key, None);
    }
}
