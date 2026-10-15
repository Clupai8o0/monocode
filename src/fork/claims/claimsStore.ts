import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { REMOTE_PATH_PREFIX } from "../../shared/lib/remotePaths";
import { parseClaims, type ClaimsSnapshot } from "./claimsModel";

/**
 * One poll of `claims.py list --json` per project folder that has a tag on
 * screen (Explorer root or file tab), shared by every tag. It polls only while
 * the window is visible, and is off under the test runner so upstream tests
 * see no extra invoke.
 */
export const FORK_CLAIMS = import.meta.env.MODE !== "test";

const POLL_MS = 15_000;

/** Folder -> its latest snapshot (null: not a repo, or claims.py missing). */
const snapshots = new Map<string, ClaimsSnapshot | null>();
/** Folder -> how many mounted tags asked for it. */
const roots = new Map<string, number>();
/** Folder -> the JSON last seen, so an unchanged poll doesn't re-render. */
const lastJson = new Map<string, string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | null = null;
/** claims.py isn't on this Mac: stop asking. */
let missing = false;

function bump() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function refresh(root: string) {
  if (missing || inFlight.has(root)) {
    return;
  }
  inFlight.add(root);
  invoke<unknown>("fork_claims_list", { dir: root })
    .then((value) => {
      if (!roots.has(root)) {
        return;
      }
      if (value === null) {
        // claims.py is gone: drop every tag and stop asking.
        missing = true;
        stopTimer();
        snapshots.clear();
        lastJson.clear();
        bump();
        return;
      }
      const json = JSON.stringify(value);
      const changed = lastJson.get(root) !== json;
      const snapshot = changed
        ? parseClaims(value)
        : (snapshots.get(root) ?? null);
      lastJson.set(root, json);
      snapshots.set(root, snapshot);
      // Re-render while anything is claimed, so the hover's "5m ago" stays true.
      if (changed || (snapshot?.claims.length ?? 0) > 0) {
        bump();
      }
    })
    .catch(() => {
      // A failed poll drops this folder's tags rather than show stale ones.
      if (roots.has(root) && snapshots.get(root)) {
        snapshots.set(root, null);
        lastJson.delete(root);
        bump();
      }
    })
    .finally(() => inFlight.delete(root));
}

function refreshAll() {
  if (typeof document !== "undefined" && document.hidden) {
    return;
  }
  for (const root of roots.keys()) {
    refresh(root);
  }
}

function onVisible() {
  if (!document.hidden) {
    refreshAll();
  }
}

function startTimer() {
  if (timer || missing) {
    return;
  }
  timer = setInterval(refreshAll, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }
}

function addRoot(root: string) {
  const count = roots.get(root) ?? 0;
  roots.set(root, count + 1);
  if (count === 0) {
    refresh(root);
  }
  startTimer();
}

function removeRoot(root: string) {
  const count = (roots.get(root) ?? 1) - 1;
  if (count > 0) {
    roots.set(root, count);
    return;
  }
  roots.delete(root);
  snapshots.delete(root);
  lastJson.delete(root);
  if (roots.size === 0) {
    stopTimer();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

function watchable(root: string | undefined): root is string {
  return (
    FORK_CLAIMS &&
    !!root &&
    root.startsWith("/") &&
    !root.startsWith(REMOTE_PATH_PREFIX)
  );
}

/**
 * The claims snapshot for the project folder `root`, kept fresh while the
 * caller is mounted. Null until the first poll lands, or outside a repo.
 */
export function useClaims(root: string | undefined): ClaimsSnapshot | null {
  const ok = watchable(root);
  useEffect(() => {
    if (!ok) {
      return;
    }
    addRoot(root);
    return () => removeRoot(root);
  }, [ok, root]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return ok ? (snapshots.get(root) ?? null) : null;
}
