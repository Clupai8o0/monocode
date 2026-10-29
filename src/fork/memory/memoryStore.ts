import { useSyncExternalStore } from "react";
import {
  IDLE_MINUTE_CHOICES,
  IDLE_MINUTES_DEFAULT,
  type IdleMinutes,
} from "./memoryModel";

/**
 * Fork: the Memory manager's two small stores. Settings live in this
 * browser's storage (auto-park is off unless the owner turns it on); the
 * parked list is in memory only, since a restart parks everything anyway.
 */

const AUTO_PARK_KEY = "monocode.fork.memory.autoPark";
const IDLE_MINUTES_KEY = "monocode.fork.memory.idleMinutes";

export type MemorySettings = { autoPark: boolean; idleMinutes: IdleMinutes };

function readSettings(): MemorySettings {
  let autoPark = false;
  let idleMinutes: IdleMinutes = IDLE_MINUTES_DEFAULT;
  try {
    autoPark = localStorage.getItem(AUTO_PARK_KEY) === "1";
    const stored = localStorage.getItem(IDLE_MINUTES_KEY);
    const raw = Number(stored ?? NaN);
    idleMinutes =
      IDLE_MINUTE_CHOICES.find((choice) => choice === raw) ??
      IDLE_MINUTES_DEFAULT;
    if (stored !== null && String(idleMinutes) !== stored) {
      // An older build offered 5-60 min, which the 3 min idle timer made
      // unreachable; those become the default.
      localStorage.setItem(IDLE_MINUTES_KEY, String(idleMinutes));
    }
  } catch {
    // Storage blocked: the defaults stand.
  }
  return { autoPark, idleMinutes };
}

let settings: MemorySettings | null = null;
const settingsListeners = new Set<() => void>();

export function memorySettings(): MemorySettings {
  settings ??= readSettings();
  return settings;
}

function notifySettings(): void {
  for (const listener of settingsListeners) {
    listener();
  }
}

/**
 * Re-read storage, since another window may have changed the settings.
 * Keeps the same object (and skips listeners) when nothing changed.
 */
export function refreshMemorySettings(): MemorySettings {
  const next = readSettings();
  const current = settings;
  if (
    current &&
    current.autoPark === next.autoPark &&
    current.idleMinutes === next.idleMinutes
  ) {
    return current;
  }
  settings = next;
  if (current) {
    notifySettings();
  }
  return next;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key === null ||
      event.key === AUTO_PARK_KEY ||
      event.key === IDLE_MINUTES_KEY
    ) {
      refreshMemorySettings();
    }
  });
}

export function setMemorySettings(next: Partial<MemorySettings>): void {
  settings = { ...memorySettings(), ...next };
  try {
    localStorage.setItem(AUTO_PARK_KEY, settings.autoPark ? "1" : "0");
    localStorage.setItem(IDLE_MINUTES_KEY, String(settings.idleMinutes));
  } catch {
    // private mode / quota
  }
  notifySettings();
}

export function useMemorySettings(): MemorySettings {
  return useSyncExternalStore(
    (listener) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    memorySettings,
    memorySettings,
  );
}

export type ParkedSession = {
  sessionId: string;
  title: string;
  freedBytes: number;
  parkedAt: number;
};

let parked: ReadonlyMap<string, ParkedSession> = new Map();
const parkedListeners = new Set<() => void>();

function setParked(next: ReadonlyMap<string, ParkedSession>): void {
  parked = next;
  for (const listener of parkedListeners) {
    listener();
  }
}

export function parkedSessions(): ReadonlyMap<string, ParkedSession> {
  return parked;
}

export function markParked(entry: ParkedSession): void {
  const next = new Map(parked);
  next.set(entry.sessionId, entry);
  setParked(next);
}

/** Drop sessions that are live again (respawned) or no longer open. */
export function pruneParked(
  live: ReadonlySet<string>,
  open: ReadonlySet<string>,
): void {
  const stale = [...parked.keys()].filter(
    (id) => live.has(id) || !open.has(id),
  );
  if (stale.length === 0) {
    return;
  }
  const next = new Map(parked);
  for (const id of stale) {
    next.delete(id);
  }
  setParked(next);
}

export function useParkedSessions(): ReadonlyMap<string, ParkedSession> {
  return useSyncExternalStore(
    (listener) => {
      parkedListeners.add(listener);
      return () => parkedListeners.delete(listener);
    },
    parkedSessions,
    parkedSessions,
  );
}

/** Test seam. */
export function resetMemoryStores(): void {
  settings = null;
  parked = new Map();
}
