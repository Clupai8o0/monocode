import { useSyncExternalStore } from "react";

/**
 * Fork: lets the Memory chip stand in for the "High usage" chip, without App
 * passing anything between them. ResourcePressureNotice publishes what it
 * samples and how to open its Running work modal; MemoryWatcher says when its
 * chip is on screen, and the old chip steps aside only then.
 */
export type ResourcePressure = {
  active: boolean;
  /** Plain words, such as "High CPU usage". */
  reasons: readonly string[];
};

const NONE: ResourcePressure = { active: false, reasons: [] };

let pressure = NONE;
let chipShown = false;
let openRunningWork: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishResourcePressure(next: ResourcePressure): void {
  if (
    next.active === pressure.active &&
    next.reasons.join() === pressure.reasons.join()
  ) {
    return;
  }
  pressure = next;
  notify();
}

export function useResourcePressure(): ResourcePressure {
  return useSyncExternalStore(subscribe, () => pressure);
}

export function setMemoryChipShown(shown: boolean): void {
  if (shown !== chipShown) {
    chipShown = shown;
    notify();
  }
}

export function useMemoryChipShown(): boolean {
  return useSyncExternalStore(subscribe, () => chipShown);
}

export function setRunningWorkOpener(open: (() => void) | null): void {
  openRunningWork = open;
}

export function reviewRunningWork(): void {
  openRunningWork?.();
}
