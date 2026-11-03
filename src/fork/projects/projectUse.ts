import { useEffect, useRef, useSyncExternalStore } from "react";
import { pathKey } from "../../shared/lib/paths";

const KEY = "monocode.fork.projectUse";
const MAX = 50;

/** Each project's `pathKey`, and when a run last started or ended there. */
export type ProjectUse = Readonly<Record<string, number>>;

const NO_USE: ProjectUse = {};
const listeners = new Set<() => void>();
let cached: { raw: string | null; use: ProjectUse } = {
  raw: null,
  use: NO_USE,
};

function parse(raw: string | null): ProjectUse {
  if (!raw) {
    return NO_USE;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NO_USE;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, at]) => typeof at === "number" && Number.isFinite(at),
      ),
    );
  } catch {
    return NO_USE;
  }
}

/** Stays the same object until the stored value changes. */
export function loadProjectUse(): ProjectUse {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage is unavailable, so nothing was recorded.
  }
  if (raw !== cached.raw) {
    cached = { raw, use: parse(raw) };
  }
  return cached.use;
}

export function markProjectsUsed(
  paths: readonly string[],
  now: number = Date.now(),
): void {
  if (!paths.length) {
    return;
  }
  const next: Record<string, number> = { ...loadProjectUse() };
  for (const path of paths) {
    next[pathKey(path)] = now;
  }
  const newest = Object.entries(next)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Private mode or quota: the order falls back to when projects were opened.
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useProjectUse(): ProjectUse {
  return useSyncExternalStore(subscribe, loadProjectUse, loadProjectUse);
}

/**
 * A run starting or ending counts as using its project, even one that was
 * never opened in this window. Kept apart from the recents list, whose changes
 * restart inbox polling and re-render every session pane.
 */
export function useProjectUseTracking(busyPaths: readonly string[]): void {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const busy = new Map(busyPaths.map((path) => [pathKey(path), path]));
    const changed = [
      ...[...busy].filter(([key]) => !previous.current.has(key)),
      ...[...previous.current].filter(([key]) => !busy.has(key)),
    ].map(([, path]) => path);
    previous.current = busy;
    markProjectsUsed(changed);
  }, [busyPaths]);
}
