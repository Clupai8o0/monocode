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
  const rows = await listSessionsByProject(path);
  byProject.set(path, rows);
  emit();
  return rows;
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
  scanning = false;
  lastScanAt = Number.NEGATIVE_INFINITY;
  queued = null;
  emit();
}
