import { invoke } from "@tauri-apps/api/core";
import type { Block } from "../../features/sessions/model/session";
import { isMonoSession } from "../../features/monos/model/mono";
import { parsePeerMessage } from "./peerMessage";
import { isPeerBlock } from "./peerTranscript";

/**
 * Fork feature: the message badge on a session card. Counts the messages
 * other sessions sent into this one (peer blocks) and the ones it sent out
 * (SendMessage calls to other sessions, not to its own subagents), from the
 * saved transcript. "Unread" is every message in since the card was last open.
 */

export type PeerIn = {
  name: string;
  at?: number;
  body: string;
  urgent: boolean;
};

export type PeerStats = {
  incoming: PeerIn[];
  /** Names this session sent messages to, one per message. */
  outgoing: string[];
};

/** A subagent's id, as SendMessage's result names it: not another session. */
const AGENT_ID = /^a[0-9a-f]{15,}$/;
const URGENT = /\burgent\b|^\s*(?:stop|asap)\b/i;

export function isUrgentPeer(body: string): boolean {
  return URGENT.test(body.slice(0, 200));
}

function recipient(block: Pick<Block, "tool">): string | null {
  const tool = block.tool;
  if (!tool || (tool.kind !== "SendMessage" && tool.title !== "SendMessage")) {
    return null;
  }
  if (tool.status && tool.status !== "completed") {
    return null;
  }
  let name = "";
  try {
    const result = JSON.parse(tool.detail ?? "") as {
      success?: boolean;
      pin?: { name?: unknown; id?: unknown };
    };
    if (result.success === false) {
      return null;
    }
    name = String(result.pin?.name ?? result.pin?.id ?? "");
  } catch {
    // An older or odd result: still a message sent, to someone.
  }
  if (AGENT_ID.test(name)) {
    return null;
  }
  return name || "a session";
}

export function peerStatsOfBlocks(
  blocks: readonly Pick<Block, "role" | "text" | "tool" | "interjection">[],
): PeerStats {
  const incoming: PeerIn[] = [];
  const outgoing: string[] = [];
  for (const block of blocks) {
    if (isPeerBlock(block as Block)) {
      const m = parsePeerMessage(block.text);
      const body = m?.body ?? block.text;
      incoming.push({
        name: m?.name ?? "Session",
        ...(m?.at ? { at: m.at } : {}),
        body,
        urgent: isUrgentPeer(body),
      });
      continue;
    }
    if (block.role === "tool") {
      const to = recipient(block);
      if (to) {
        outgoing.push(to);
      }
    }
  }
  return { incoming, outgoing };
}

/** The messages in since the card was last open (`seen` = how many were read). */
export function unread(stats: PeerStats, seen: number): PeerIn[] {
  return stats.incoming.slice(
    Math.min(Math.max(seen, 0), stats.incoming.length),
  );
}

function firstLine(text: string, max = 80): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Hover text for the badge: who, when and the first line of each unread. */
export function unreadTooltip(
  messages: readonly PeerIn[],
  time: (at: number) => string,
): string {
  const head = `${messages.length} new message${messages.length === 1 ? "" : "s"} from other sessions`;
  const rows = messages
    .slice(-5)
    .map(
      (m) =>
        `${m.urgent ? "Urgent · " : ""}${m.name}${m.at ? ` ${time(m.at)}` : ""}: ${firstLine(m.body)}`,
    );
  const more =
    messages.length > 5 ? [`and ${messages.length - 5} earlier`] : [];
  return [head, ...more, ...rows].join("\n");
}

export function sentTooltip(outgoing: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of outgoing) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const who = [...counts]
    .map(([name, n]) => (n > 1 ? `${name} (${n})` : name))
    .join(", ");
  return `Sent ${outgoing.length} message${outgoing.length === 1 ? "" : "s"} to ${who}`;
}

// --- Store -----------------------------------------------------------------

/** Where the session is, for the Messages pane. */
export type SessionInfo = { title: string; cwd: string };

type Entry = { at: number; stats: PeerStats; info: SessionInfo };

const SEEN_KEY = "monocode.fork.peerSeen";
const INSTALLED_KEY = "monocode.fork.peerSeenSince";
const STARTED = Date.now();
/** A working session saves often; read its transcript at most this often. */
const BUSY_GAP_MS = 30_000;

const entries = new Map<string, Entry>();
const lastRead = new Map<string, number>();
let seenCache: Record<string, number> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const queue = new Map<string, number>();
const later = new Map<string, ReturnType<typeof setTimeout>>();
let pumping = false;

function emit() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePeerStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peerStatsVersion(): number {
  return version;
}

export function cachedPeerStats(sessionId: string): PeerStats | null {
  return entries.get(sessionId)?.stats ?? null;
}

function seenMap(): Record<string, number> {
  if (seenCache) {
    return seenCache;
  }
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SEEN_KEY) ?? "{}",
    ) as unknown;
    seenCache =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, number>)
        : {};
  } catch {
    seenCache = {};
  }
  return seenCache;
}

/** How many of the session's incoming messages the user has seen. */
export function seenCount(sessionId: string): number {
  const n = seenMap()[sessionId];
  return typeof n === "number" ? n : 0;
}

/** Marks every incoming message so far as read (the card is open). */
export function markPeerSeen(sessionId: string) {
  const stats = cachedPeerStats(sessionId);
  if (!stats || seenCount(sessionId) === stats.incoming.length) {
    return;
  }
  writeSeen(sessionId, stats.incoming.length);
  emit();
}

function writeSeen(sessionId: string, count: number) {
  const map = seenMap();
  delete map[sessionId]; // re-added last, so pruning drops the oldest
  map[sessionId] = count;
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - 400))) {
    delete map[key];
  }
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    // Blocked storage: read state lasts this run only.
  }
}

/**
 * When this feature first ran here. Messages that arrived before it count as
 * read, so the badge doesn't light up on every old session at once.
 */
function installedAt(): number {
  try {
    const raw = Number(localStorage.getItem(INSTALLED_KEY));
    if (Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    const now = Date.now();
    localStorage.setItem(INSTALLED_KEY, String(now));
    return now;
  } catch {
    return STARTED;
  }
}

/** Records stats directly (tests, or a caller that already has the blocks). */
export function setPeerStats(
  sessionId: string,
  updatedAt: number,
  stats: PeerStats,
  info: SessionInfo = { title: "", cwd: "" },
) {
  entries.set(sessionId, { at: updatedAt, stats, info });
  if (!(sessionId in seenMap())) {
    const since = installedAt();
    const old = stats.incoming.filter((m) => (m.at ?? 0) < since).length;
    writeSeen(sessionId, old);
  }
  emit();
}

/**
 * Reads the session's transcript once per save; a working session at most
 * every BUSY_GAP_MS, with the last save read when the gap is over.
 */
export function requestPeerStats(
  sessionId: string,
  updatedAt: number,
  busy: boolean,
) {
  if (isMonoSession(sessionId) || entries.get(sessionId)?.at === updatedAt) {
    return;
  }
  const wait = busy
    ? (lastRead.get(sessionId) ?? 0) + BUSY_GAP_MS - Date.now()
    : 0;
  if (wait > 0) {
    const old = later.get(sessionId);
    if (old) {
      clearTimeout(old);
    }
    later.set(
      sessionId,
      setTimeout(() => {
        later.delete(sessionId);
        queue.set(sessionId, updatedAt);
        void pump();
      }, wait),
    );
    return;
  }
  const pending = later.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    later.delete(sessionId);
  }
  queue.set(sessionId, updatedAt);
  void pump();
}

async function pump() {
  if (pumping) {
    return;
  }
  pumping = true;
  try {
    while (queue.size > 0) {
      const [sessionId, updatedAt] = queue.entries().next().value as [
        string,
        number,
      ];
      queue.delete(sessionId);
      if (entries.get(sessionId)?.at === updatedAt) {
        continue;
      }
      lastRead.set(sessionId, Date.now());
      let record: { blocks?: Block[]; title?: string; cwd?: string } | null;
      try {
        // Direct row read, like the close badges: getSession may write repairs.
        record = await invoke<{
          blocks?: Block[];
          title?: string;
          cwd?: string;
        } | null>("session_get", {
          sessionId,
        });
      } catch {
        continue;
      }
      setPeerStats(
        sessionId,
        updatedAt,
        peerStatsOfBlocks(record?.blocks ?? []),
        {
          title: record?.title ?? "",
          cwd: record?.cwd ?? "",
        },
      );
    }
  } finally {
    pumping = false;
  }
}

// --- Messages pane -----------------------------------------------------------

export type InboxRow = PeerIn & {
  sessionId: string;
  /** The receiving session's title and project folder name. */
  title: string;
  project: string;
  unread: boolean;
};

function folderName(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
}

/**
 * Every message other sessions sent into the sessions read so far, newest
 * first. Only sessions whose card has been listed are read.
 */
export function inboxRows(): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const [sessionId, entry] of entries) {
    const seen = seenCount(sessionId);
    entry.stats.incoming.forEach((m, i) => {
      rows.push({
        ...m,
        sessionId,
        title: entry.info.title || "Untitled session",
        project: folderName(entry.info.cwd),
        unread: i >= seen,
      });
    });
  }
  return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
