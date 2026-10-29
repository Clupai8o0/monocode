/**
 * Fork feature: the session relay's pure parts (host side). Proxy pids, the
 * names relayed sessions go by, checks on what a peer sends, the rewrite of
 * a relayed line, and the per-peer delivery queue. The rest of the relay is
 * in relay.ts and relay-registry.ts; shapes are in src/fork/lab/labProtocol.ts.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { RelayDelivery, RelaySession } from "../src/fork/lab/labProtocol";

/** Proxy pids live in [1e9, 2e9): above any real pid. */
export const PID_BASE = 1_000_000_000;
export const PID_SPAN = 1_000_000_000;
/** Claude Code's own cap on one NDJSON line. */
export const LINE_MAX = 1024 * 1024;
export const QUEUE_MAX = 500;
/** Bytes of serialised deliveries one relay.next answer carries (always at
 *  least one); the Mac refuses an answer over 16 MiB. */
export const NEXT_BYTES_MAX = 8 * 1024 * 1024;
/** Bytes of serialised deliveries one peer may have waiting. */
export const QUEUE_BYTES_MAX = 32 * 1024 * 1024;
export const QUEUE_TTL_MS = 45_000;
export const NEXT_WAIT_MAX_MS = 25_000;
/** Sessions one peer may offer. */
export const PEER_SESSIONS_MAX = 200;
const NAME_MAX = 64;
const CWD_MAX = 1024;
/** "/" + a 10-digit pid + ".sock" must still fit a Mac socket path (103). */
const SOCK_DIR_MAX = 86;
const RESERVED_NAMES = new Set(["main", "team-lead", "user", "system"]);
const KINDS = new Set(["interactive", "background", "headless", "sdk"]);
const ACCOUNTS = new Set([".claude", ".claude-exec", ".claude-cx"]);
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;
const STATUS = /^[a-z_-]{1,24}$/;
const SOCK_DIR = /^\/[A-Za-z0-9._/-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
const WRAPPER = /^\s*<cross-session-message\b[^>]*>[\s\S]*<\/cross-session-message>\s*$/;
const WRAPPER_OPEN = /<cross-session-message\b[^>]*>/;

/** A peer's session as the host keeps it; `version` is its Claude version
 *  when the peer sends one. */
export type PeerSession = RelaySession & { version?: string };

/** The proxy pid a session from `sourceKey` ("host" or a peer's device id)
 *  starts from, before probing past collisions. */
export function proxyPid(sourceKey: string, sessionId: string): number {
  const digest = createHash("sha256").update(`${sourceKey}\n${sessionId}`).digest();
  return PID_BASE + (digest.readUInt32BE(0) % PID_SPAN);
}

/** The first pid from `start` on (wrapping inside the range) not taken. */
export function probePid(start: number, taken: (pid: number) => boolean): number {
  let pid = start;
  for (let tries = 0; tries < PID_SPAN; tries++) {
    if (!taken(pid)) return pid;
    pid = pid + 1 >= PID_BASE + PID_SPAN ? PID_BASE : pid + 1;
  }
  throw new Error("No proxy pid is free");
}

/** The proxy pids on one target machine, by source session. */
export class PidTable {
  private readonly byKey = new Map<string, number>();
  private readonly byPid = new Map<number, { sourceKey: string; sessionId: string }>();

  constructor(private readonly startPid: typeof proxyPid = proxyPid) {}

  /** The pid standing for this session, made on first ask. */
  pid(sourceKey: string, sessionId: string): number {
    const key = `${sourceKey}\n${sessionId}`;
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const pid = probePid(this.startPid(sourceKey, sessionId), (candidate) => this.byPid.has(candidate));
    this.byKey.set(key, pid);
    this.byPid.set(pid, { sourceKey, sessionId });
    return pid;
  }

  lookup(pid: number): { sourceKey: string; sessionId: string } | undefined {
    return this.byPid.get(pid);
  }

  /** Frees every pid whose session `keep` does not want. */
  retain(keep: (sourceKey: string, sessionId: string) => boolean): void {
    for (const [pid, source] of this.byPid) {
      if (keep(source.sourceKey, source.sessionId)) continue;
      this.byPid.delete(pid);
      this.byKey.delete(`${source.sourceKey}\n${source.sessionId}`);
    }
  }

  get size(): number {
    return this.byPid.size;
  }
}

function clean(value: string, max: number): string {
  return value.replace(CONTROL, "").trim().slice(0, max);
}

/** What a relayed session is called: its own name without `@` and `*`, or
 *  its folder's name when that name is empty, looks like an address, or is
 *  one Claude keeps for itself. */
export function relayName(name: string | undefined, cwd: string): string {
  const usable = (value: string) => {
    const stripped = clean(value, NAME_MAX).replace(/[@*]/g, "").trim();
    return stripped && !/[:/]/.test(stripped) && !RESERVED_NAMES.has(stripped.toLowerCase())
      ? stripped
      : "";
  };
  return usable(name ?? "") || usable(basename(cwd)) || "session";
}

/** A machine name safe for a pidDomain, or `fallback`. */
export function cleanMachine(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return name || fallback;
}

/** A peer's socket folder: absolute, plain characters, no "..", short
 *  enough for its proxies' paths. */
export function cleanSockDir(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const dir = value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (dir.length < 2 || dir.length > SOCK_DIR_MAX || !SOCK_DIR.test(dir)) return null;
  if (dir.split("/").some((part) => part === "." || part === "..")) return null;
  return dir;
}

/** A session a peer offers, checked and trimmed, or null. */
export function cleanSession(value: unknown): PeerSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.sessionId !== "string" || !SESSION_ID.test(raw.sessionId)) return null;
  if (typeof raw.cwd !== "string" || !raw.cwd || raw.cwd.length > CWD_MAX) return null;
  if (HAS_CONTROL.test(raw.cwd)) return null;
  const account =
    typeof raw.account === "string" && ACCOUNTS.has(raw.account) ? raw.account : ".claude";
  const session: PeerSession = {
    sessionId: raw.sessionId,
    account,
    name: relayName(typeof raw.name === "string" ? raw.name : undefined, raw.cwd),
    cwd: raw.cwd,
    kind: typeof raw.kind === "string" && KINDS.has(raw.kind) ? raw.kind : "interactive",
  };
  if (typeof raw.status === "string" && STATUS.test(raw.status)) session.status = raw.status;
  if (typeof raw.bridgeSessionId === "string" && BRIDGE_ID.test(raw.bridgeSessionId)) {
    session.bridgeSessionId = raw.bridgeSessionId;
  }
  if (typeof raw.version === "string" && VERSION.test(raw.version)) session.version = raw.version;
  return session;
}

/** Whether a string fits the formats above; local sessions use these too. */
export const formats = {
  sessionId: (value: string) => SESSION_ID.test(value),
  bridgeSessionId: (value: string) => BRIDGE_ID.test(value),
  version: (value: string) => VERSION.test(value),
  status: (value: string) => STATUS.test(value),
  kind: (value: string) => KINDS.has(value),
};

export type Frame = Record<string, unknown> & { type: "user" | "control" };

/**
 * One relayable frame, or null: a user message wrapped in
 * `<cross-session-message>`, or a delivery receipt. Auth lines, other
 * frames and lines over 1 MiB are dropped.
 */
export function readFrame(line: string): Frame | null {
  if (line.length > LINE_MAX || Buffer.byteLength(line, "utf8") > LINE_MAX) return null;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (record.type === "user") {
    const message = record.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object" || message.role !== "user") return null;
    if (typeof message.content !== "string" || !WRAPPER.test(message.content)) return null;
    return record as Frame;
  }
  if (record.type === "control" && record.action === "peer_message_status") {
    return record as Frame;
  }
  return null;
}

/** The sender address in a frame, e.g. "/tmp/cc-socks/88142.sock". */
export function frameSender(frame: Frame): string | null {
  return typeof frame.from === "string" && frame.from.startsWith("uds:")
    ? frame.from.slice(4)
    : null;
}

/**
 * The frame as the receiving machine should see it: sent from `fromSocket`
 * (the proxy there standing for the sender), in `from` and in the wrapper's
 * from="…"; session_id and file_attachments removed. msg_id, from-session,
 * from-name, from-mode and hop-chain stay.
 */
export function rewriteFrame(frame: Frame, fromSocket: string): string | null {
  const from = `uds:${fromSocket}`;
  const out: Record<string, unknown> = { ...frame, from };
  delete out.session_id;
  delete out.file_attachments;
  if (frame.type === "user") {
    const message = frame.message as Record<string, unknown>;
    const content = message.content as string;
    const attr = `from="${from.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
    const rewritten = content.replace(WRAPPER_OPEN, (open) =>
      /\sfrom="[^"]*"/.test(open)
        ? open.replace(/\sfrom="[^"]*"/, () => ` ${attr}`)
        : open.replace("<cross-session-message", () => `<cross-session-message ${attr}`),
    );
    out.message = { ...message, content: rewritten };
  }
  const line = JSON.stringify(out);
  return Buffer.byteLength(line, "utf8") > LINE_MAX ? null : line;
}

/** readFrame then rewriteFrame. */
export function rewriteLine(line: string, fromSocket: string): string | null {
  const frame = readFrame(line);
  return frame ? rewriteFrame(frame, fromSocket) : null;
}

/**
 * Lines waiting for one peer. Capped at 500 (the oldest go first) and 32 MiB
 * (a push past it is refused), and kept 45 s. `next` answers at once when
 * something is past the cursor, else waits for a push, a wake or `waitMs`;
 * one answer carries about 8 MiB, the rest come on the next poll.
 */
/** Why a queued line left without being handed on. */
export type QueueDrop = "expired" | "full" | "cleared";

export class DeliveryQueue {
  private items: Array<{ seq: number; at: number; bytes: number; delivery: RelayDelivery; handed?: boolean }> =
    [];
  private readonly waiters = new Set<() => void>();
  /** The newest poll; an older one still waiting answers empty, so two
   *  overlapping polls never both hand out the same line. */
  private poll = 0;

  constructor(
    private readonly now: () => number,
    /** The relay-wide sequence: `next()` takes one, `current()` reads it. */
    private readonly seq: { next(): number; current(): number },
    /** Told once per line: when it is first handed on, or when it goes
     *  without having been. */
    private readonly settle?: (delivery: RelayDelivery, drop?: QueueDrop) => void,
  ) {}

  private expire(keep: (item: { seq: number; at: number }) => boolean): void {
    const oldest = this.now() - QUEUE_TTL_MS;
    this.items = this.items.filter((item) => {
      if (item.at >= oldest && keep(item)) return true;
      if (!item.handed) this.settle?.(item.delivery, item.at < oldest ? "expired" : "cleared");
      return false;
    });
  }

  /** Queues a delivery; false, queueing nothing, when too much is waiting. */
  push(delivery: RelayDelivery): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(delivery), "utf8");
    this.expire(() => true);
    const waiting = this.items.reduce((total, item) => total + item.bytes, 0);
    if (waiting + bytes > QUEUE_BYTES_MAX) return false;
    this.items.push({ seq: this.seq.next(), at: this.now(), bytes, delivery });
    if (this.items.length > QUEUE_MAX) {
      for (const item of this.items.splice(0, this.items.length - QUEUE_MAX)) {
        if (!item.handed) this.settle?.(item.delivery, "full");
      }
    }
    this.wake();
    return true;
  }

  /** Ends every wait now. */
  wake(): void {
    for (const wake of [...this.waiters]) wake();
  }

  clear(): void {
    for (const item of this.items) if (!item.handed) this.settle?.(item.delivery, "cleared");
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  /** Deliveries past `cursor`, up to the answer budget; ones at or before
   *  it were taken, so go. The cursor answered is the last one included. */
  take(cursor: number): { cursor: number; deliveries: RelayDelivery[] } {
    const current = this.seq.current();
    // A cursor from before a restart is ahead of this run's sequence.
    const after = cursor > current ? 0 : cursor;
    this.expire((item) => item.seq > after);
    let bytes = 0;
    let count = 0;
    while (count < this.items.length) {
      const item = this.items[count];
      if (count > 0 && bytes + item.bytes > NEXT_BYTES_MAX) break;
      bytes += item.bytes;
      count++;
    }
    const included = this.items.slice(0, count);
    for (const item of included) {
      if (item.handed) continue;
      item.handed = true;
      this.settle?.(item.delivery);
    }
    return {
      cursor: count < this.items.length ? included[count - 1].seq : current,
      deliveries: included.map((item) => item.delivery),
    };
  }

  async next(
    cursor: number,
    waitMs: number,
  ): Promise<{ cursor: number; deliveries: RelayDelivery[] }> {
    const mine = ++this.poll;
    this.wake();
    const first = this.take(cursor);
    if (first.deliveries.length || waitMs <= 0) return first;
    await new Promise<void>((done) => {
      let timer: NodeJS.Timeout | undefined = undefined;
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        done();
      };
      timer = setTimeout(wake, Math.min(waitMs, NEXT_WAIT_MAX_MS));
      this.waiters.add(wake);
    });
    if (mine !== this.poll) return { cursor, deliveries: [] };
    return this.take(cursor);
  }
}
