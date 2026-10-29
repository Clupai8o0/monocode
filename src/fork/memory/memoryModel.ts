/**
 * Fork: the Memory manager's rules. Pure functions, so the ranking and the
 * auto-park decision are tested without a Mac, a harness or a clock.
 *
 * "Parking" stops an idle session's agent process; its conversation stays
 * saved and the next message resumes the same Claude session id.
 */

export type MemoryPressure = "normal" | "warn" | "critical";

/** What `fork_memory_report` returns. */
export type MemoryReport = {
  pressure: MemoryPressure;
  totalBytes: number;
  availableBytes: number;
  sessions: { sessionId: string; rssBytes: number; processCount: number }[];
};

/** What the app knows about one open session. */
export type SessionFacts = {
  id: string;
  title: string;
  busy: boolean;
  /** A permission prompt or a question is waiting on the user. */
  needsInput: boolean;
  /** The conversation on screen. */
  foreground: boolean;
  /** When its warm child's turn settled; undefined while running or parked. */
  idleSince?: number;
};

export type RowState = "idle" | "running" | "waiting" | "onScreen" | "helper";

export type MemoryRow = {
  sessionId: string;
  title: string;
  rssBytes: number;
  processCount: number;
  state: RowState;
  idleMs?: number;
  parkable: boolean;
};

export type Suggestion = { rows: MemoryRow[]; freedBytes: number };

/** A session idle less than this is still being read; never suggested. */
export const MANUAL_MIN_IDLE_MS = 60_000;
/** Pressure must last this long before auto-park acts, and between rounds. */
export const AUTO_PARK_AFTER_MS = 60_000;
/**
 * Auto-park's idle thresholds. The stock idle timer (HARNESS_IDLE_PARK_MS,
 * 3 min) already parks every idle child, so only shorter waits can matter;
 * 0 means right after the turn ends.
 */
export const IDLE_MINUTE_CHOICES = [0, 1, 2] as const;
export type IdleMinutes = (typeof IDLE_MINUTE_CHOICES)[number];
export const IDLE_MINUTES_DEFAULT: IdleMinutes = 1;
/** Added to idle time when ranking, so RAM still counts for a just-idle child. */
const SCORE_IDLE_FLOOR_MS = 60_000;
/** Share of RAM that should be available once parking is done. */
const TARGET_AVAILABLE: Record<Exclude<MemoryPressure, "normal">, number> = {
  warn: 0.15,
  critical: 0.25,
};

export function parsePressure(value: unknown): MemoryPressure {
  return value === "warn" || value === "critical" ? value : "normal";
}

export function parseReport(value: unknown): MemoryReport | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  return {
    pressure: parsePressure(raw.pressure),
    totalBytes: Number(raw.totalBytes) || 0,
    availableBytes: Number(raw.availableBytes) || 0,
    sessions: sessions.flatMap((row) => {
      const entry = row as Record<string, unknown>;
      return typeof entry?.sessionId === "string"
        ? [
            {
              sessionId: entry.sessionId,
              rssBytes: Number(entry.rssBytes) || 0,
              processCount: Number(entry.processCount) || 0,
            },
          ]
        : [];
    }),
  };
}

function stateOf(facts: SessionFacts | undefined): RowState {
  if (!facts) {
    return "helper";
  }
  if (facts.busy) {
    return "running";
  }
  if (facts.needsInput) {
    return "waiting";
  }
  if (facts.foreground) {
    return "onScreen";
  }
  // A live child the registry doesn't count as idle is starting or working.
  return facts.idleSince === undefined ? "running" : "idle";
}

/** One row per live agent process tree, largest first. */
export function buildRows(
  report: MemoryReport,
  facts: ReadonlyMap<string, SessionFacts>,
  now: number,
): MemoryRow[] {
  return report.sessions
    .map((entry) => {
      const session = facts.get(entry.sessionId);
      const state = stateOf(session);
      const idleMs =
        session?.idleSince === undefined
          ? undefined
          : Math.max(0, now - session.idleSince);
      return {
        sessionId: entry.sessionId,
        title: session?.title ?? "Background helper",
        rssBytes: entry.rssBytes,
        processCount: entry.processCount,
        state,
        idleMs,
        parkable: state === "idle",
      };
    })
    .sort((a, b) => b.rssBytes - a.rssBytes);
}

/**
 * Big and long idle first: RAM held times how long it sat unused (plus a
 * minute, so a big session that just went idle still outranks a small one
 * idle a little longer; every idle session is under 3 min anyway).
 */
export function parkScore(row: MemoryRow): number {
  return row.parkable
    ? row.rssBytes * ((row.idleMs ?? 0) + SCORE_IDLE_FLOOR_MS)
    : 0;
}

export function totalSessionBytes(rows: readonly MemoryRow[]): number {
  return rows.reduce((sum, row) => sum + row.rssBytes, 0);
}

/**
 * Under pressure, the best idle sessions to park until the estimated RAM
 * freed brings availability back to the target. Normal pressure: none.
 */
export function suggestParks(
  rows: readonly MemoryRow[],
  report: Pick<MemoryReport, "pressure" | "totalBytes" | "availableBytes">,
  minIdleMs = MANUAL_MIN_IDLE_MS,
): Suggestion {
  if (report.pressure === "normal") {
    return { rows: [], freedBytes: 0 };
  }
  const needed = Math.max(
    0,
    TARGET_AVAILABLE[report.pressure] * report.totalBytes -
      report.availableBytes,
  );
  const candidates = rows
    .filter((row) => row.parkable && (row.idleMs ?? 0) >= minIdleMs)
    .sort((a, b) => parkScore(b) - parkScore(a));
  const picked: MemoryRow[] = [];
  let freedBytes = 0;
  for (const row of candidates) {
    // The kernel says memory is tight even when the estimate disagrees, so
    // at least one goes.
    if (picked.length > 0 && freedBytes >= needed) {
      break;
    }
    picked.push(row);
    freedBytes += row.rssBytes;
  }
  return { rows: picked, freedBytes };
}

export type AutoParkState = { tightSince?: number };

/**
 * One auto-park tick. Off unless the owner turned it on; acts only after
 * pressure has lasted AUTO_PARK_AFTER_MS, then waits that long again.
 */
export function autoParkStep(
  state: AutoParkState,
  input: {
    enabled: boolean;
    report: MemoryReport;
    rows: readonly MemoryRow[];
    idleThresholdMs: number;
    now: number;
  },
): { state: AutoParkState; park: MemoryRow[] } {
  if (!input.enabled || input.report.pressure === "normal") {
    return { state: {}, park: [] };
  }
  const tightSince = state.tightSince ?? input.now;
  if (input.now - tightSince < AUTO_PARK_AFTER_MS) {
    return { state: { tightSince }, park: [] };
  }
  // The owner's threshold stands as set, even 0 (right after the turn).
  const { rows } = suggestParks(
    input.rows,
    input.report,
    Math.max(0, input.idleThresholdMs),
  );
  return { state: { tightSince: input.now }, park: rows };
}

export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return mb < 1 ? "<1 MB" : `${Math.round(mb)} MB`;
}

export function formatIdle(ms: number | undefined): string {
  if (ms === undefined) {
    return "";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "idle <1 min";
  }
  if (minutes < 60) {
    return `idle ${minutes} min`;
  }
  return `idle ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function stateLabel(row: MemoryRow): string {
  switch (row.state) {
    case "idle":
      return formatIdle(row.idleMs);
    case "running":
      return "Working";
    case "waiting":
      return "Waiting for you";
    case "onScreen":
      return "On screen";
    case "helper":
      return "Used by MonoCode";
  }
}
