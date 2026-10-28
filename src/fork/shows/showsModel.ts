/**
 * Fork feature: show on the Mac. An agent on another machine runs
 * `monocode-show <file|url>` (or `xdg-open`, `open` or `$BROWSER`, which the
 * host points at it), and the file or link opens in MonoCode on the Mac
 * instead of on that machine's screen.
 *
 * The host snapshots each file into a spool and queues it. The Mac always
 * asks; the host never pushes. On `/rpc` only:
 *
 * - `shows.next {after?, epoch?, waitMs?}` -> `ShowsNextResult`: items newer
 *   than `after`, held up to `SHOWS_WAIT_MAX_MS` while there are none.
 * - `shows.read {id, offset}` -> `ShowsReadResult`, `SHOW_CHUNK_BYTES` of a
 *   spooled file at a time. It reads only spooled snapshots, never a path.
 *
 * A host from before this feature lacks the `shows` capability in
 * `environment.describe` and answers the methods with "unknown method".
 *
 * Agents reach the host over a Unix socket (`ShowRequest` and `ShowResponse`,
 * one JSON line each way), `$XDG_RUNTIME_DIR/monocode-host/show.sock`.
 */

export const SHOWS_CAPABILITY = "shows";
/** Largest file the host spools. */
export const SHOW_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** One `shows.read` chunk, before base64. */
export const SHOW_CHUNK_BYTES = 512 * 1024;
/** Longest `shows.next` hold; under the desktop's 30 s request timeout. */
export const SHOWS_WAIT_MAX_MS = 25_000;
/** The spool keeps at most this many items and bytes, for this long. */
export const SHOW_SPOOL_MAX_ITEMS = 50;
export const SHOW_SPOOL_MAX_BYTES = 200 * 1024 * 1024;
export const SHOW_TTL_MS = 24 * 60 * 60_000;
/** Items younger than this (host clock) may open by themselves on the Mac. */
export const SHOW_FRESH_MS = 2 * 60_000;
/** Item ids, and the machine ids the Mac files them under. */
export const SHOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL_LENGTH = 4096;

export type ShowKind = "file" | "url";

export type ShowItem = {
  /** Unique on its host; matches `SHOW_ID_PATTERN`. */
  id: string;
  /** Grows by one per item; `shows.next` takes the last one seen as `after`. */
  seq: number;
  kind: ShowKind;
  /** file: its base name, cleaned. url: the link's host. */
  name: string;
  /** From `monocode-show --title`. */
  title?: string;
  /** file: bytes in the snapshot. */
  size?: number;
  /** file: a type guessed from the extension. */
  mime?: string;
  /** url: an http or https link. The host never fetches it. */
  url?: string;
  /** file: its absolute path on the host, for the toast. */
  sourcePath?: string;
  /** The working folder of the agent that sent it, on the host. */
  cwd?: string;
  /** The host project whose folder holds `cwd`, when there is one. */
  projectId?: string;
  /** The host session that sent it, when MonoCode's host started the agent. */
  sessionId?: string;
  /** Host clock, ms since the epoch. */
  createdAt: number;
};

export type ShowsNextParams = {
  /** The `cursor` of the last answer; 0 or absent for everything queued. */
  after?: number;
  /** The `epoch` of the last answer; another epoch means start over. */
  epoch?: string;
  /** How long to hold an empty answer, capped at `SHOWS_WAIT_MAX_MS`. */
  waitMs?: number;
};

export type ShowsNextResult = {
  /** Changes when the spool is wiped; `after` from another epoch counts as 0. */
  epoch: string;
  /** Oldest first. */
  items: ShowItem[];
  /** The highest seq handed out; pass it back as `after`. */
  cursor: number;
  /** Host clock now, so freshness never depends on the two clocks agreeing. */
  now: number;
};

export type ShowsReadParams = { id: string; offset: number };

export type ShowsReadResult = {
  /** Base64 of up to `SHOW_CHUNK_BYTES` bytes from `offset`. */
  data: string;
  offset: number;
  /** The whole snapshot's size. */
  size: number;
  done: boolean;
};

/** What `monocode-show` sends over the socket. */
export type ShowRequest = {
  v: 1;
  kind: ShowKind;
  /** file: absolute, resolved by the command against its own cwd. */
  path?: string;
  url?: string;
  title?: string;
  cwd?: string;
  sessionId?: string;
};

export type ShowResponse =
  | {
      ok: true;
      id: string;
      /** For the agent: "Sent to the Mac: report.pdf" or "Queued until the Mac connects: report.pdf". */
      message: string;
    }
  | { ok: false; error: string };

/** An http or https link, or undefined. */
export function showableUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A host's item, checked before the Mac uses any of it. */
export function parseShowItem(value: unknown): ShowItem | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const text = (field: unknown, max: number) =>
    typeof field === "string" && field ? field.slice(0, max) : undefined;
  const kind = record.kind;
  if (
    typeof record.id !== "string" ||
    !SHOW_ID_PATTERN.test(record.id) ||
    typeof record.seq !== "number" ||
    !Number.isSafeInteger(record.seq) ||
    record.seq < 1 ||
    (kind !== "file" && kind !== "url") ||
    typeof record.createdAt !== "number"
  ) {
    return undefined;
  }
  const url = kind === "url" ? showableUrl(record.url) : undefined;
  const size =
    typeof record.size === "number" && Number.isSafeInteger(record.size) && record.size >= 0
      ? record.size
      : undefined;
  if (kind === "url" ? !url : size === undefined || size > SHOW_MAX_FILE_BYTES) {
    return undefined;
  }
  const name = text(record.name, 200);
  if (!name) {
    return undefined;
  }
  return {
    id: record.id,
    seq: record.seq,
    kind,
    name,
    title: text(record.title, 200),
    size,
    mime: text(record.mime, 100),
    url,
    sourcePath: text(record.sourcePath, 1024),
    cwd: text(record.cwd, 1024),
    projectId: text(record.projectId, 200),
    sessionId: text(record.sessionId, 200),
    createdAt: record.createdAt,
  };
}
