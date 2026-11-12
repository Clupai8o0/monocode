import {
  listSessionsByProject,
  type SessionSummary,
} from "../../features/sessions/data/sessionStore";

/**
 * Fork feature: the session list of every project, kept between looks. It lets
 * the title bar button show how many sessions are ready to close, and lets the
 * cleanup panel open already filled.
 */

/** A scan runs git once per project, so background ones stay this far apart. */
export const SCAN_GAP_MS = 60_000;

let byProject = new Map<string, readonly SessionSummary[]>();
let version = 0;
/** Counts removals and restores, so a read that began before one is not kept. */
let changes = 0;
/** The project list each removed session was on, for putting it back. */
const removedFrom = new Map<string, string>();
/** The newest read begun for each project, so a slower older one can't win. */
const latestRead = new Map<string, number>();
let readTurn = 0;
const listeners = new Set<() => void>();

let scanning = false;
let lastScanAt = Number.NEGATIVE_INFINITY;
let queued: { paths: readonly string[]; now: boolean } | null = null;
let waitTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeCleanupRows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cleanupRowsVersion(): number {
  return version;
}

/** The rows last read for these projects; none for one not read yet. */
export function cachedCleanupRows(paths: readonly string[]): SessionSummary[] {
  return paths.flatMap((path) => byProject.get(path) ?? []);
}

/** Reads one project and keeps the result. A failed read keeps the old rows. */
export async function readCleanupProject(
  path: string,
): Promise<readonly SessionSummary[]> {
  let startedAt: number;
  let turn: number;
  let rows: readonly SessionSummary[];
  // A read that began before a session was removed or restored would undo that
  // change, for the cache and for whoever is waiting on it, so read again.
  do {
    startedAt = changes;
    readTurn += 1;
    turn = readTurn;
    latestRead.set(path, turn);
    rows = await listSessionsByProject(path);
  } while (startedAt !== changes);
  // A newer read of this project began meanwhile, and its answer wins.
  if (latestRead.get(path) === turn) {
    byProject.set(path, rows);
    emit();
  }
  return rows;
}

/** Drops sessions just removed, so the count falls before the next read. */
export function forgetCleanupRows(sessionIds: readonly string[]) {
  if (sessionIds.length === 0) {
    return;
  }
  changes += 1;
  const gone = new Set(sessionIds);
  for (const [path, rows] of byProject) {
    for (const row of rows) {
      if (gone.has(row.id)) {
        removedFrom.set(row.id, path);
      }
    }
    byProject.set(
      path,
      rows.filter((row) => !gone.has(row.id)),
    );
  }
  emit();
}

/**
 * These rows, in place of any with the same id: a read since the archive holds
 * the session as archived, and would keep it off every list.
 */
export function withRestoredRows(
  rows: readonly SessionSummary[],
  restored: readonly SessionSummary[],
): SessionSummary[] {
  const byId = new Map(restored.map((row) => [row.id, row]));
  const known = new Set(rows.map((row) => row.id));
  return [
    ...restored.filter((row) => !known.has(row.id)),
    ...rows.map((row) => byId.get(row.id) ?? row),
  ];
}

/** Puts back sessions just restored, under the projects they came from. */
export function restoreCleanupRows(restored: readonly SessionSummary[]) {
  if (restored.length === 0) {
    return;
  }
  changes += 1;
  for (const row of restored) {
    const path = removedFrom.get(row.id) ?? row.cwd;
    removedFrom.delete(row.id);
    const rows = byProject.get(path);
    if (rows) {
      byProject.set(path, withRestoredRows(rows, [row]));
    }
  }
  emit();
}

async function scan(paths: readonly string[]) {
  scanning = true;
  try {
    // One project at a time: each read runs git and holds the session store.
    for (const path of paths) {
      try {
        await readCleanupProject(path);
      } catch {
        // Keeps the rows it had; the panel reports projects it cannot read.
      }
    }
  } finally {
    scanning = false;
    lastScanAt = Date.now();
  }
  const next = queued;
  if (next) {
    queued = null;
    requestCleanupScan(next.paths, { now: next.now });
  }
}

/**
 * Asks for a fresh read of these projects. Asks close together share one read,
 * so a burst of sessions finishing costs one scan. `now` skips the wait, for a
 * look the user just asked for.
 */
export function requestCleanupScan(
  paths: readonly string[],
  { now = false }: { now?: boolean } = {},
) {
  if (scanning) {
    // An ask for now stays one, even when a slower ask comes in behind it.
    queued = { paths, now: now || (queued?.now ?? false) };
    return;
  }
  if (waitTimer) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
  const wait = now ? 0 : lastScanAt + SCAN_GAP_MS - Date.now();
  if (wait <= 0) {
    void scan(paths);
    return;
  }
  waitTimer = setTimeout(() => {
    waitTimer = null;
    void scan(paths);
  }, wait);
}

/** Tests only: forget everything between cases. */
export function resetCleanupRows() {
  if (waitTimer) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
  byProject = new Map();
  removedFrom.clear();
  scanning = false;
  lastScanAt = Number.NEGATIVE_INFINITY;
  queued = null;
  emit();
}
