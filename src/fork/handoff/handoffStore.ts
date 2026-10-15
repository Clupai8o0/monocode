import { readTextFile, statFiles } from "../../platform/tauri/fs";
import { handoffPath, summarizeHandoff } from "./handoffModel";

/** Off under the test runner, so upstream tests see no extra reads. */
export const FORK_HANDOFF = import.meta.env.MODE !== "test";

/** Re-check every handoff file this often while the window is visible. */
const POLL_MS = 60_000;
/** stat_files takes at most 64 paths per call. */
const STAT_BATCH = 64;
const DISMISSED_KEY = "monocode.fork.handoffDismissed";

export type Handoff = {
  path: string;
  mtimeMs: number;
  heading: string;
  line: string;
};

/** Per handoff path: its mtime (null = no file) and summary once read. */
const mtimes = new Map<string, number | null>();
const summaries = new Map<string, Handoff>();
const watched = new Map<string, number>();
const dismissedHere = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;
let again = false;

function emit() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeHandoffs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function handoffsVersion(): number {
  return version;
}

function dismissedMap(): Record<string, number> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(DISMISSED_KEY) ?? "{}",
    ) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

/** Hides this version of the handoff; a newer save shows it again. */
export function dismissHandoff(handoff: Handoff) {
  const map = dismissedMap();
  delete map[handoff.path];
  map[handoff.path] = handoff.mtimeMs;
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - 200))) {
    delete map[key];
  }
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(map));
  } catch {
    // Blocked storage: dismissed for this run only.
  }
  dismissedHere.set(handoff.path, handoff.mtimeMs);
  emit();
}

function isDismissed(handoff: Handoff): boolean {
  return (
    dismissedHere.get(handoff.path) === handoff.mtimeMs ||
    dismissedMap()[handoff.path] === handoff.mtimeMs
  );
}

/** The project's handoff when there is one the user has not dismissed. */
export function handoffFor(cwd: string): Handoff | null {
  const path = handoffPath(cwd);
  if (!path || !mtimes.get(path)) {
    return null;
  }
  const handoff = summaries.get(path);
  return handoff && !isDismissed(handoff) ? handoff : null;
}

async function check() {
  if (checking) {
    again = true;
    return;
  }
  checking = true;
  try {
    do {
      again = false;
      const paths = [...watched.keys()];
      let changed = false;
      for (let i = 0; i < paths.length; i += STAT_BATCH) {
        let stats: { path: string; mtimeMs: number | null }[];
        try {
          stats = await statFiles(paths.slice(i, i + STAT_BATCH));
        } catch {
          continue;
        }
        for (const { path, mtimeMs } of stats) {
          if (mtimes.get(path) === mtimeMs) {
            continue;
          }
          mtimes.set(path, mtimeMs);
          changed = true;
          if (!mtimeMs) {
            summaries.delete(path);
            continue;
          }
          try {
            const text = await readTextFile(path);
            summaries.set(path, { path, mtimeMs, ...summarizeHandoff(text) });
          } catch {
            summaries.set(path, {
              path,
              mtimeMs,
              heading: "Handoff",
              line: "",
            });
          }
        }
      }
      if (changed) {
        emit();
      }
    } while (again);
  } finally {
    checking = false;
  }
}

function visible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function onWake() {
  if (visible()) {
    void check();
  }
}

/** Ref-counted: watches the project's handoff while a card or tag shows it. */
export function watchHandoff(cwd: string): () => void {
  const path = handoffPath(cwd);
  if (!FORK_HANDOFF || !path) {
    return () => {};
  }
  watched.set(path, (watched.get(path) ?? 0) + 1);
  if (!timer) {
    timer = setInterval(onWake, POLL_MS);
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
  }
  if (!mtimes.has(path)) {
    void check();
  }
  return () => {
    const n = (watched.get(path) ?? 1) - 1;
    if (n > 0) {
      watched.set(path, n);
      return;
    }
    watched.delete(path);
    if (watched.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    }
  };
}

// --- Launcher ----------------------------------------------------------------

let launcher: ((cwd: string) => void) | null = null;

/** App registers how to open a new session with the prompt in its composer. */
export function setHandoffLauncher(fn: ((cwd: string) => void) | null) {
  launcher = fn;
}

export function continueFromHandoff(cwd: string): boolean {
  if (!launcher) {
    return false;
  }
  launcher(cwd);
  return true;
}
