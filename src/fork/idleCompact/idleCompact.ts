// Fork: compact a big Claude thread around its prompt cache running out
// (T3 Code's "Compact idle threads"). Claude caches the conversation it has
// read for about an hour on a subscription. Once that runs out, the next
// message re-reads the whole thread at full price, and so does every turn
// after it until the cache is rebuilt. A summary first makes those turns small.
import type { Session } from "../../features/sessions/model/session";

export type IdleCompactMode = "return" | "before-expiry" | "never";

/** Threads below this many context tokens are left alone. */
export const IDLE_COMPACT_THRESHOLD = 200_000;
/** Claude's prompt cache on a subscription. API keys get 5 minutes; MonoCode runs subscriptions. */
export const CLAUDE_CACHE_TTL_MS = 60 * 60 * 1000;
/** "Before the cache expires" compacts this long before it would. */
export const EARLY_COMPACT_MS = 5 * 60 * 1000;

const MODE_KEY = "monocode.fork.idleCompact.mode";
const ENDS_KEY = "monocode.fork.idleCompact.turnEnds";
const MAX_ENDS = 400;

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeIdleCompact(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const idleCompactVersion = () => version;

export function loadIdleCompactMode(): IdleCompactMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "return" || saved === "before-expiry" || saved === "never") return saved;
  } catch {
    // Storage unavailable: the default applies.
  }
  return "return";
}

export function saveIdleCompactMode(mode: IdleCompactMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Kept for this window only.
  }
  changed();
}

type Ends = Record<string, number>;
let ends: Ends | null = null;

function readEnds(): Ends {
  if (ends) return ends;
  try {
    const parsed = JSON.parse(localStorage.getItem(ENDS_KEY) ?? "{}") as unknown;
    ends = parsed && typeof parsed === "object" ? (parsed as Ends) : {};
  } catch {
    ends = {};
  }
  return ends;
}

/** When the session's last provider turn ended, which is when its cache was last refreshed. */
export function lastTurnEnd(sessionId: string): number | undefined {
  const at = readEnds()[sessionId];
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

export function noteTurnEnded(sessionId: string, at = Date.now()) {
  const next = { ...readEnds(), [sessionId]: at };
  const ids = Object.keys(next);
  if (ids.length > MAX_ENDS) {
    ids
      .sort((a, b) => next[a] - next[b])
      .slice(0, ids.length - MAX_ENDS)
      .forEach((id) => delete next[id]);
  }
  ends = next;
  try {
    localStorage.setItem(ENDS_KEY, JSON.stringify(next));
  } catch {
    // Kept in memory; the session's save time is the fallback after a restart.
  }
  changed();
}

const COMPACTED_KEY = "monocode.fork.idleCompact.compacted";
let compacted: Ends | null = null;

function readCompacted(): Ends {
  if (compacted) return compacted;
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPACTED_KEY) ?? "{}") as unknown;
    compacted = parsed && typeof parsed === "object" ? (parsed as Ends) : {};
  } catch {
    compacted = {};
  }
  return compacted;
}

/**
 * A compaction finished. Claude reports no new usage for /compact, so the old
 * reading stays until a real turn; while it does, the thread counts as compacted.
 */
export function noteCompacted(sessionId: string, usedBefore: number | undefined) {
  if (usedBefore == null) return;
  const next = { ...readCompacted(), [sessionId]: usedBefore };
  const ids = Object.keys(next);
  if (ids.length > MAX_ENDS) ids.slice(0, ids.length - MAX_ENDS).forEach((id) => delete next[id]);
  compacted = next;
  try {
    localStorage.setItem(COMPACTED_KEY, JSON.stringify(next));
  } catch {
    // Kept in memory.
  }
  changed();
}

function alreadyCompacted(session: Session): boolean {
  const used = readCompacted()[session.id];
  return used != null && used === session.context?.used;
}

/** Sessions whose message was queued behind a compaction started by Send. */
const sendAfter = new Set<string>();

export function markSendAfterCompact(sessionId: string) {
  sendAfter.add(sessionId);
}

export function takeSendAfterCompact(sessionId: string): boolean {
  return sendAfter.delete(sessionId);
}

/** "Keep" on the chip: the next message goes with the full history. */
const keeping = new Set<string>();

export function isKeepingHistory(sessionId: string): boolean {
  return keeping.has(sessionId);
}

export function setKeepHistory(sessionId: string, keep: boolean) {
  if (keep) keeping.add(sessionId);
  else keeping.delete(sessionId);
  changed();
}

/** A big, idle Claude thread that can be compacted. */
function bigIdleClaude(session: Session): boolean {
  return (
    session.harness === "claude" &&
    !session.busy &&
    !session.usageLimit &&
    !session.worktreeRemoved &&
    !session.pendingSwitch &&
    !session.ephemeral &&
    !session.orchestrationLeadId &&
    !session.queuedMessages?.length &&
    !session.backgroundTasks?.length &&
    !!session.providerSessionId &&
    (session.context?.used ?? 0) >= IDLE_COMPACT_THRESHOLD &&
    !alreadyCompacted(session)
  );
}

/** When the cache runs out, or undefined if the thread is not a candidate. */
export function cacheExpiresAt(session: Session): number | undefined {
  if (!bigIdleClaude(session)) return undefined;
  // Only turns seen ending here count (kept across restarts); without one,
  // the chip stays away rather than guess.
  const end = lastTurnEnd(session.id);
  return end != null ? end + CLAUDE_CACHE_TTL_MS : undefined;
}

/** The chip shows: the cache has run out on a big thread, and the setting allows it. */
export function showCompactChip(
  session: Session,
  now = Date.now(),
  mode = loadIdleCompactMode(),
): boolean {
  if (mode === "never") return false;
  const expires = cacheExpiresAt(session);
  return expires != null && now >= expires;
}

/** Send runs /compact first. Takes back a one-message "Keep". */
export function takeCompactBeforeSend(session: Session, now = Date.now()): boolean {
  if (!showCompactChip(session, now)) return false;
  if (keeping.has(session.id)) {
    setKeepHistory(session.id, false);
    return false;
  }
  return true;
}

const tried = new Map<string, number>();

/** "Before the cache expires": due in the last few minutes of the cache, once per idle stretch. */
export function earlyCompactDue(
  session: Session,
  now = Date.now(),
  mode = loadIdleCompactMode(),
): boolean {
  if (mode !== "before-expiry" || !bigIdleClaude(session)) return false;
  // Only a turn seen ending in this app counts; a guess could compact a cold thread.
  const end = lastTurnEnd(session.id);
  if (end == null || tried.get(session.id) === end) return false;
  const expires = end + CLAUDE_CACHE_TTL_MS;
  return now >= expires - EARLY_COMPACT_MS && now < expires - 30_000;
}

export function noteEarlyCompactTried(sessionId: string) {
  const end = lastTurnEnd(sessionId);
  if (end != null) tried.set(sessionId, end);
}

/** Tests only. */
export function resetIdleCompactForTests() {
  ends = null;
  compacted = null;
  sendAfter.clear();
  keeping.clear();
  tried.clear();
  changed();
}
