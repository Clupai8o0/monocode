import { useSyncExternalStore } from "react";
import type { Session } from "../../../features/sessions/model/session";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";

/**
 * Fork: Turn Bet. Guess how long a running agent turn will take; the closer
 * the guess and the earlier it was placed, the more it pays. The turns are the
 * app's own: App publishes its sessions here (through publishRunningWork), so
 * bets settle whether or not the games panel is open.
 */

export type LiveTurn = {
  sessionId: string;
  title: string;
  startedAt: number;
  /** False for a turn already running when the app first saw it: its start is a guess, so no bets. */
  knownStart: boolean;
};

export type Bet = {
  sessionId: string;
  startedAt: number;
  guessMs: number;
  /** How far into the turn the bet went down. */
  placedAfterMs: number;
  mode: ArcadeMode;
};

export type BetResult = {
  title: string;
  guessMs: number;
  actualMs: number;
  points: number;
  settledAt: number;
};

export type BetRecord = {
  points: number;
  bets: number;
  best: number;
  recent: BetResult[];
};

/** How far off, as a ratio, a guess may be and still pay anything. */
export const TOLERANCE: Record<ArcadeMode, number> = { low: 3, mid: 2, hard: 1.5 };
export const MAX_POINTS = 100;
/** A bet placed at the very end still pays this share, so a late bet is never worthless. */
export const MIN_LEAD = 0.1;
/** A guess has to leave the turn some room to run. */
export const MIN_AHEAD_MS = 5_000;
const RECENT = 6;
const RECORD_KEY = "monocode.fork.games.turnBet.record";

/** Closeness on a log scale (twice as long hurts like half as long), times how early it was. */
export function scoreBet(
  bet: Pick<Bet, "guessMs" | "placedAfterMs" | "mode">,
  actualMs: number,
): number {
  if (actualMs <= 0 || bet.guessMs <= 0) {
    return 0;
  }
  const off = Math.abs(Math.log(actualMs / bet.guessMs));
  const closeness = Math.max(0, 1 - off / Math.log(TOLERANCE[bet.mode]));
  const lead = Math.min(1, Math.max(MIN_LEAD, (actualMs - bet.placedAfterMs) / actualMs));
  return Math.round(MAX_POINTS * closeness * lead);
}

/** The smallest guess allowed this far into a turn. */
export function minGuess(elapsedMs: number) {
  return Math.max(MIN_AHEAD_MS, elapsedMs + MIN_AHEAD_MS);
}

/** Guesses step on a log scale, so + and - feel the same at 20s and at 20m. */
export function stepGuess(guessMs: number, dir: 1 | -1, elapsedMs: number) {
  const next = dir > 0 ? guessMs * 1.25 : guessMs / 1.25;
  return Math.max(minGuess(elapsedMs), roundGuess(next));
}

function roundGuess(ms: number) {
  const unit = ms < 60_000 ? 5_000 : ms < 600_000 ? 15_000 : 60_000;
  return Math.max(unit, Math.round(ms / unit) * unit);
}

/** Where the guess starts: twice what has gone so far, and at least a minute. */
export function firstGuess(elapsedMs: number) {
  return Math.max(minGuess(elapsedMs), roundGuess(Math.max(60_000, elapsedMs * 2)));
}

/** "45s", "2m 05s", "1h 03m" */
export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

// --- Store -------------------------------------------------------------------

type State = {
  live: LiveTurn[];
  bets: Bet[];
  record: BetRecord;
};

const EMPTY_RECORD: BetRecord = { points: 0, bets: 0, best: 0, recent: [] };

function readRecord(): BetRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY) ?? "null") as Partial<BetRecord> | null;
    if (!raw || typeof raw !== "object") {
      return EMPTY_RECORD;
    }
    return {
      points: Number(raw.points) || 0,
      bets: Number(raw.bets) || 0,
      best: Number(raw.best) || 0,
      recent: Array.isArray(raw.recent) ? raw.recent.slice(0, RECENT) : [],
    };
  } catch {
    return EMPTY_RECORD;
  }
}

function writeRecord(record: BetRecord) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch {
    // A full or blocked store only forgets the tally.
  }
}

let state: State | null = null;
/** Sessions seen at least once, so a turn starting later has a known start. */
let seen = false;
const listeners = new Set<() => void>();

function current(): State {
  state ??= { live: [], bets: [], record: readRecord() };
  return state;
}

function emit(next: State) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

/** For tests: forget everything, including what has been seen. */
export function resetTurnBet() {
  state = null;
  seen = false;
}

export function settle(record: BetRecord, result: BetResult): BetRecord {
  return {
    points: record.points + result.points,
    bets: record.bets + 1,
    best: Math.max(record.best, result.points),
    recent: [result, ...record.recent].slice(0, RECENT),
  };
}

/**
 * App calls this with every session change. A turn starts when a session goes
 * busy and ends when it stops; ending settles any bet on it.
 */
export function publishTurns(
  sessions: readonly (Pick<Session, "id" | "title" | "busy"> &
    Partial<Pick<Session, "ephemeral" | "inboxAsk" | "sidebarHidden">>)[],
  now: number = Date.now(),
) {
  const was = current();
  const before = new Map(was.live.map((turn) => [turn.sessionId, turn]));
  const live: LiveTurn[] = [];
  for (const session of sessions) {
    // Only the chats you can see: habit runs and Inbox asks aren't yours to bet on.
    if (!session.busy || session.ephemeral || session.inboxAsk || session.sidebarHidden) {
      continue;
    }
    const known = before.get(session.id);
    live.push(
      known
        ? { ...known, title: session.title || known.title }
        : {
            sessionId: session.id,
            title: session.title || "Untitled",
            startedAt: now,
            knownStart: seen,
          },
    );
  }
  seen = true;

  const still = new Set(live.map((turn) => turn.sessionId));
  // Only a session that is still here, still shown and now idle has finished
  // its turn; one that vanished or was hidden mid-turn never did.
  const finished = new Set(
    sessions
      .filter((session) => !session.busy && !session.ephemeral && !session.inboxAsk && !session.sidebarHidden)
      .map((session) => session.id),
  );
  let record = was.record;
  const bets: Bet[] = [];
  for (const bet of was.bets) {
    const turn = before.get(bet.sessionId);
    if (still.has(bet.sessionId) || !turn || turn.startedAt !== bet.startedAt) {
      bets.push(bet);
      continue;
    }
    if (!finished.has(bet.sessionId)) {
      continue;
    }
    const actualMs = now - bet.startedAt;
    record = settle(record, {
      title: turn.title,
      guessMs: bet.guessMs,
      actualMs,
      points: scoreBet(bet, actualMs),
      settledAt: now,
    });
  }
  // A bet whose turn is gone without finishing is dropped, unpaid.
  const kept = bets.filter((bet) => still.has(bet.sessionId));

  const changed =
    record !== was.record ||
    kept.length !== was.bets.length ||
    live.length !== was.live.length ||
    live.some((turn, index) => {
      const old = was.live[index];
      return !old || old.sessionId !== turn.sessionId || old.title !== turn.title;
    });
  if (!changed) {
    return;
  }
  if (record !== was.record) {
    writeRecord(record);
  }
  emit({ live, bets: kept, record });
}

/** One bet per turn, never shorter than the turn has run; false when the turn can't take it. */
export function placeBet(
  sessionId: string,
  guessMs: number,
  mode: ArcadeMode,
  now: number = Date.now(),
): boolean {
  const was = current();
  const turn = was.live.find((item) => item.sessionId === sessionId);
  if (!turn || !turn.knownStart || was.bets.some((bet) => bet.sessionId === sessionId)) {
    return false;
  }
  const placedAfterMs = now - turn.startedAt;
  // The guess on screen was floored a moment ago; floor it again at the click,
  // so a second's drift raises it rather than refusing the bet.
  const guess = Math.max(guessMs, minGuess(placedAfterMs));
  emit({
    ...was,
    bets: [...was.bets, { sessionId, startedAt: turn.startedAt, guessMs: guess, placedAfterMs, mode }],
  });
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function turnBetSnapshot(): State {
  return current();
}

export function useTurnBet(): State {
  return useSyncExternalStore(subscribe, turnBetSnapshot, turnBetSnapshot);
}
