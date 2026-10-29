/**
 * Fork feature: the message log. What Claude sessions said to each other, on
 * this Mac and on each paired host, read from their transcripts, plus what the
 * MonoCode relay did with each message it carried between machines.
 *
 * Three readers share these shapes and must agree:
 * - this Mac: `fork_message_log` and `fork_relay_traffic` (Rust,
 *   src-tauri/src/fork_messages.rs and src-tauri/src/fork_relay/traffic.rs);
 * - a host: `messages.list` (host/messages.ts, capability "messages.v1") and
 *   `relay.traffic` (host/relay.ts, capability "relay.traffic.v1");
 * - the desktop merges them (messageLogModel.ts, messageLogStore.ts).
 *
 * Read-only: nothing here sends, holds or deletes a message. Nothing is saved
 * to disk; previews live in memory while MonoCode runs. No socket path, pid or
 * token ever leaves the machine that read it.
 *
 * Both transcript readers test against one fixture: tests/fixtures/message-log/
 * (a home folder, two files appended during the test, and expected.json with
 * the answers each step must give; make_fixture.py writes them).
 *
 * ---------------------------------------------------------------------------
 * How a transcript reader works (normative; Rust and host do the same)
 * ---------------------------------------------------------------------------
 *
 * A reader is one long-lived object (one per process). Each call scans with:
 * the home folder, this machine's relay name (`machine`), the time now, and a
 * liveness check for registry entries (the existing ones:
 * fork_external_sessions.rs `is_live`, host/external-sessions.ts
 * `sessionLiveness`). Tests pass all four, and may lower TAIL_MAX_BYTES.
 *
 * Accounts. `.claude` is "main"; `.claude-exec` and `.claude-cx` are "cx".
 * A folder that resolves (symlinks) to one already read is skipped.
 *
 * Files. Every `<home>/<account>/projects/<dir>/<id>.jsonl` (direct children
 * of each project folder only, so subagent transcripts are skipped) whose
 * `<id>` matches SESSION_FILE and whose mtime is at or after
 * `now - windowHours` (no upper bound). `<id>` is the session id. The first
 * scan of a file reads it from the start, or from `size - TAIL_MAX_BYTES`
 * (then from just after the next newline) when it is bigger. Later scans read
 * only what was appended. A file that shrank or was replaced (new inode, or
 * new file id) is read again from the start, and its events count as changed.
 * Read up to the last newline only: a last line without one is read again,
 * whole, by the next scan.
 *
 * Lines. One JSON record per line. Only a line containing one of LINE_HINTS,
 * or the id of a SendMessage tool_use still waiting for its result, needs
 * parsing; skip the rest unparsed. `at` is the record's `timestamp` (ISO 8601,
 * UTC, as Claude Code writes it) in ms since the epoch; a record without a
 * timestamp that parses is ignored.
 *
 * 1. Send. A record with `type: "assistant"` whose `message.content` array
 *    has a part `{type: "tool_use", name: "SendMessage", id, input}`.
 *    `to` = `input.to ?? input.recipient` (a string); text = `input.message`,
 *    else `input.content` (strings). Skip the part when `to` matches
 *    SUBAGENT_ID, when `input.recipient_kind === "agent"` (a subagent, not a
 *    session), or when the text is empty after trimming (`notify_when_idle`
 *    alone: a subscription, not a message). summary = `input.summary`.
 *    Status "pending", `updatedAt` = `at`, until its result arrives.
 *    An address is never sent on: `to` "uds:<path>" becomes `to: ""`,
 *    `toAddress: "socket"`; "bridge:<id>" becomes `to: ""`,
 *    `toAddress: "bridge"`; anything else is a name, `toAddress: "name"`.
 *
 * 2. Send result. A record with `type: "user"` whose `message.content` array
 *    has `{type: "tool_result", tool_use_id}` naming a waiting send. The
 *    result is the record's `toolUseResult` when it is an object; else
 *    JSON-parse the part's text (`content` when it is a string, else its
 *    first `{type: "text"}` part's `text`).
 *    - `pin` or `resumedAgentId` set, or a message starting "Resuming agent"
 *      or "Message queued for delivery to": drop the send (a subagent).
 *    - `success === false`, or the part's `is_error === true`: status
 *      "failed", `error` = the message (when there is no result object: the
 *      part's text without a surrounding <tool_use_error>…</tool_use_error>),
 *      or "Not sent" when there is neither.
 *    - Otherwise: status "sent", `msgId` = `msg_id` when it is a string.
 *      `toName` (only when `to` was an address): take the message after its
 *      first "” → " (U+201D, space, U+2192, space), or after a leading "→ ";
 *      cut at the first " (", ";" or newline; trim. Leave it out when empty,
 *      or when it starts with "uds:" or "bridge:".
 *    `updatedAt` = this record's `at`. The send stops waiting either way.
 *
 * 3. Delivery notice. A record with `type: "user"` whose content text (the
 *    string, or its text parts joined with "\n") starts with NOTICE_PREFIX
 *    and has "msg_id: " followed by a 36-character id. Of the phrases below,
 *    the one found earliest in the text decides (later text in a notice
 *    repeats words like "approve" and "expires"):
 *      "held by that session"          -> status "held"
 *      "approved and released"         -> status "released"
 *      "not approved before expiry"    -> status "expired"
 *      "denied by the recipient user"  -> "failed", error "Denied by that session's user"
 *      "refused"                       -> "failed", error "Refused: that session is not accepting messages from other sessions"
 *    It updates the send with that `msgId` in the same transcript (status,
 *    `error`, `updatedAt` = the notice's `at`). Notices with no msg id, no
 *    known phrase, or an unknown msg id are ignored.
 *
 * 4. Receive. A record with `type: "user"` and `origin.kind === "peer"`, or,
 *    with no `origin`, a user record whose content text contains
 *    "<cross-session-message". Never an `attachment` or `queue-operation`
 *    record. body = `origin.body` (a string), else the text inside the first
 *    `<cross-session-message …>…</cross-session-message>`; from =
 *    `origin.from`, else the wrapper's from="…"; `fromName` = `origin.name`,
 *    else the wrapper's from-name="…"; `msgId` = `origin.msg_id`.
 *    `fromAddress`: "socket" for "uds:…", "bridge" for "bridge:…", else
 *    "name". The address itself is never sent on. `updatedAt` = `at`.
 *
 * Text. Whitespace means the ASCII characters 0x09-0x0D and 0x20, nothing
 * else (not JS `\s`, not Rust `char::is_whitespace`). Count code points, not
 * UTF-16 units or bytes, so Rust and JS agree. Every text field is scrubbed
 * first: each match of SCRUB_SOCKET becomes "uds:…", then each match of
 * SCRUB_QUOTED_PATH becomes "'…'".
 * - `preview` = scrub(body), trimmed, first PREVIEW_MAX code points, end trimmed.
 * - `key` = scrub(body), trimmed, every whitespace run turned into one space,
 *   first KEY_MAX code points, end trimmed. Both ends compute it the same way,
 *   so a send and its receive have the same key.
 * - `summary` = scrub(summary), trimmed, first SUMMARY_MAX, end trimmed; left
 *   out when empty. `error` the same with ERROR_MAX.
 *
 * Who is who. Read this machine's registries at the start of each scan:
 * `<home>/<account>/sessions/<digits>.json` only (never `*.key`, never any
 * other name), every entry, live or not.
 * - A relay copy (`monocodeRelay` set, or `pidDomain` starting "relay:")
 *   stands for a session on another machine: machine =
 *   `monocodeRelay.machine` (else the part after "relay:"), session id =
 *   `monocodeRelay.remoteSessionId` (else `sessionId`), account from
 *   `monocodeRelay.account` (".claude" main, ".claude-exec" or ".claude-cx"
 *   cx, else left out), name = `name`. The relay writes one copy into each
 *   account, so count each (machine, session id) once.
 * - Any other entry is a session on this machine: its own session id, the
 *   account whose folder holds it, `name`.
 * An event's target (send) or sender (receive) is resolved when the event
 * appears or changes, against the registries of that scan, by the first of:
 * - socket: an entry's `messagingSocketPath` equals the address's path
 *   (compare canonical paths when both exist, so /tmp and /private/tmp match);
 * - bridge: an entry's `bridgeSessionId` equals the part after "bridge:";
 * - name: an entry's `name` equals `to` (send), `toName` (send to an address),
 *   or `fromName` (receive); the newest `updatedAt` wins.
 * Route: "relay" for a relay copy, "local" for a session here, and "bridge"
 * for either when it was found by bridge id. Nothing found: no target/sender.
 *
 * Ids. A send is `<sessionId>:<tool_use id>`; a receive is
 * `<sessionId>:<record uuid>`, or `<sessionId>:r<byte offset of its line>`
 * without one.
 *
 * Answers. `sessions`: the live entries that are not relay copies, sorted by
 * session id (one per session id, newest `updatedAt`); `project` = the last
 * folder name of `cwd`. `proxies`: the relay copies, one per (machine,
 * session id), sorted by session id. `events`: sorted by (`at`, `id`). Leave
 * optional fields out rather than sending null.
 *
 * Incremental answers. The reader keeps a scan counter that goes up by one
 * on every call, and an `epoch` string that is new for each reader. An
 * event's `rev` is the counter of the scan where it appeared or last changed.
 * With `since` from the same reader (`epoch` matches) and the same window,
 * the answer holds only events with `rev > since.cursor`, `full: false`.
 * Otherwise (no `since`, another epoch, or another window than the last
 * call) it holds every event in the window, `full: true`; past EVENTS_MAX it
 * keeps the newest and sets `truncated: true`. Events with `at < now -
 * windowHours` are never returned; the reader forgets events older than
 * WINDOW_HOURS_MAX.
 */

export const MESSAGES_CAPABILITY = "messages.v1";
export const RELAY_TRAFFIC_CAPABILITY = "relay.traffic.v1";

/** A transcript file's name without `.jsonl`: a session id. */
export const SESSION_FILE = /^[A-Za-z0-9_-]{8,64}$/;
/** A subagent's id: SendMessage to one is not a message between sessions. */
export const SUBAGENT_ID = /^a[0-9a-f]{15,}$/;
export const NOTICE_PREFIX = "[Cross-session delivery notice]";
/** A line needs parsing only when it holds one of these (or a waiting tool_use id). */
export const LINE_HINTS = ["SendMessage", "cross-session", '"peer"', "delivery notice"] as const;
/** A socket address in text: "uds:" up to whitespace, a quote, ")", "," or ";",
 *  not ending in ":" or ".". Same pattern in Rust. */
export const SCRUB_SOCKET = /uds:[^\t\n\x0B\x0C\r '"),;]*[^\t\n\x0B\x0C\r '"),;:.]/g;
/** A quoted absolute path, e.g. lstat '/tmp/cc-socks/1.sock'. */
export const SCRUB_QUOTED_PATH = /'\/[^']*'/g;

export const PREVIEW_MAX = 600;
export const KEY_MAX = 160;
export const SUMMARY_MAX = 200;
export const ERROR_MAX = 300;
export const EVENTS_MAX = 2000;
export const TAIL_MAX_BYTES = 64 * 1024 * 1024;
export const WINDOW_HOURS_DEFAULT = 24;
export const WINDOW_HOURS_MAX = 168;
/** Relay hops kept in memory, per recorder. */
export const TRAFFIC_MAX = 500;

export type LogAccount = "main" | "cx";
export type Route = "local" | "relay" | "bridge";
export type Address = "name" | "socket" | "bridge";

/** Who a send went to, or who a receive came from, as resolved where it was read. */
export type Resolved = {
  /** The machine's name as the relay knows it (`monocodeRelay.machine`), or
   *  the reader's own `machine` for a local session. */
  machine?: string;
  sessionId?: string;
  account?: LogAccount;
  name?: string;
  route?: Route;
};

export type SendStatus = "pending" | "sent" | "failed" | "held" | "released" | "expired";

export type SendEvent = {
  kind: "send";
  id: string;
  rev: number;
  at: number;
  updatedAt: number;
  /** The sender: a session on the machine that read this. */
  sessionId: string;
  account: LogAccount;
  /** The name as written; "" when the sender used an address. */
  to: string;
  toAddress: Address;
  /** The name the send result gave, when `to` was an address. */
  toName?: string;
  target?: Resolved;
  summary?: string;
  preview: string;
  key: string;
  msgId?: string;
  status: SendStatus;
  /** Plain words from the tool or the notice, scrubbed; failed sends only. */
  error?: string;
};

export type ReceiveEvent = {
  kind: "receive";
  id: string;
  rev: number;
  at: number;
  updatedAt: number;
  /** The receiver: a session on the machine that read this. */
  sessionId: string;
  account: LogAccount;
  fromName?: string;
  fromAddress: Address;
  sender?: Resolved;
  preview: string;
  key: string;
  msgId?: string;
};

export type LogEvent = SendEvent | ReceiveEvent;

/** A live session on the machine that read the log (relay copies left out). */
export type LogSession = {
  sessionId: string;
  account: LogAccount;
  name?: string;
  cwd: string;
  /** The cwd's last folder name. */
  project: string;
  /** The registry's status ("busy", "idle", "waiting"…), when it has one. */
  status?: string;
  updatedAt?: number;
};

/** A relay copy on the machine that read the log: a session on another machine. */
export type LogProxy = {
  name: string;
  machine: string;
  sessionId: string;
  account?: LogAccount;
};

export type MessageLogParams = {
  since?: { epoch: string; cursor: number };
  /** Whole hours, 1 to WINDOW_HOURS_MAX (clamped); WINDOW_HOURS_DEFAULT when left out. */
  windowHours?: number;
};

export type MessageLogAnswer = {
  version: 1;
  /** This machine's name as the relay knows it: the Mac's device name
   *  (what `fork_relay` sends as `machine`), or the host's machine name. */
  machine: string;
  epoch: string;
  cursor: number;
  full: boolean;
  truncated?: boolean;
  windowHours: number;
  /** The scan's `now`. */
  scannedAt: number;
  sessions: LogSession[];
  proxies: LogProxy[];
  events: LogEvent[];
};

// ---- relay hops ----

/**
 * One line the relay carried, or failed to. The Mac records lines its
 * sessions write to a stand-in (`out`) and lines it hands to its sessions
 * (`in`); a host records lines it hands to its own sessions (`in`) and lines
 * it queues for, or drops before, another machine (`out`). A line is
 * recorded once per machine, when its fate there is known: handed on
 * ("passed"), or lost ("dropped", with the reason).
 *
 * `key` uses the transcript rule on the body inside the line's
 * `<cross-session-message …>` wrapper, so a hop matches the send and the
 * receive. Names, session ids and msg ids come from the frame; no socket
 * path, pid or token is recorded.
 */
export type RelayHop = {
  /** Unique per recorder; `seq` orders them. */
  id: string;
  seq: number;
  at: number;
  /** The machine on the other end, by its relay name. */
  peer: string;
  direction: "out" | "in";
  /** A message (`type: "user"` frame) or a delivery receipt (`control`). */
  kind: "message" | "receipt";
  outcome: "passed" | "dropped";
  /** Plain words, scrubbed; dropped hops only, e.g. "Not picked up within
   *  45 s", "The queue for Mac desktop was full", "That session has closed". */
  reason?: string;
  fromName?: string;
  toName?: string;
  fromSessionId?: string;
  toSessionId?: string;
  msgId?: string;
  key?: string;
};

export type RelayTrafficParams = {
  /** The `cursor` of the last answer from the same `epoch`. */
  since?: { epoch: string; cursor: number };
};

export type RelayTrafficAnswer = {
  version: 1;
  machine: string;
  epoch: string;
  /** The newest `seq`; 0 when nothing was recorded. */
  cursor: number;
  /** Whether the relay is switched on here (a Mac: on with any host). */
  enabled: boolean;
  /** Hops with `seq > since.cursor` (all kept ones for a new epoch), oldest first. */
  hops: RelayHop[];
};
