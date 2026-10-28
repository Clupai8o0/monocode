import { useCallback, useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Fork: show on the Mac. Files another machine sent live in the app cache
 * under `shown/`. They are never converted or compiled on this Mac until the
 * user clicks, once per path for this app session.
 */

let root: string | undefined;
let loading = false;
const allowed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** Calls `listener` when the root loads or a path is allowed. */
export function subscribeShown(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

/** Fetches the cache root once; until then any path with `/shown/` counts. */
export function loadShownRoot(): void {
  if (root !== undefined || loading) {
    return;
  }
  loading = true;
  void Promise.resolve()
    .then(() => invoke<string>("fork_shows_cache_root"))
    .then((value) => {
      if (typeof value === "string" && value) {
        setShownRoot(value);
      }
    })
    .catch(() => {
      // An older native side: keep the conservative check.
    })
    .finally(() => {
      loading = false;
    });
}

export function setShownRoot(value: string | undefined): void {
  const next = value?.replace(/\/+$/, "") || undefined;
  if (next !== root) {
    root = next;
    // Gates drawn with the `/shown/` guess check again against the real root.
    bump();
  }
}

export function isShownPath(path: string): boolean {
  if (!root) {
    return path.includes("/shown/");
  }
  return path === root || path.startsWith(`${root}/`);
}

export function allowShownPath(path: string): void {
  if (!allowed.has(path)) {
    allowed.add(path);
    bump();
  }
}

export function isShownAllowed(path: string): boolean {
  return allowed.has(path);
}

/** For a viewer: `blocked` while a shown file waits for the click. */
export function useShownGate(path: string): { shown: boolean; blocked: boolean; allow: () => void } {
  useSyncExternalStore(subscribeShown, getVersion, getVersion);
  useEffect(() => {
    loadShownRoot();
  }, []);
  const shown = isShownPath(path);
  const allow = useCallback(() => {
    allowShownPath(path);
  }, [path]);
  return { shown, blocked: shown && !isShownAllowed(path), allow };
}
