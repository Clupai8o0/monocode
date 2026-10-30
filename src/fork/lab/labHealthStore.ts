import { useEffect, useSyncExternalStore } from "react";
import { remoteRequest } from "../../features/connections/model/connections";
import { combineDots, hostDot, type HealthDot } from "./labHealth";
import { errorText } from "./labModel";
import { LAB_HEALTH_METHOD, type LabHealth } from "./labProtocol";
import { getLabState, subscribeLab, type LabHost } from "./labStore";

/**
 * Fork: Home lab health, the store. Polls lab.health on every host that offers
 * it: every 5 s while a popover shows it, every 30 s otherwise. A host that
 * doesn't answer isn't asked again until someone retries or the lab's own check
 * finds it back, and its old numbers stop counting towards the chip's dot.
 */

export const HEALTH_FAST_MS = 5000;
export const HEALTH_SLOW_MS = 30_000;
/** Longer than a passing hiccup, shorter than the desktop's 30 s default. */
const HEALTH_TIMEOUT_MS = 10_000;
/** The lab's check ran after this long, so its word on the host is fresh. */
const RESUME_AFTER_MS = 30_000;

export type HostHealth = {
  health?: LabHealth;
  /** The last call's round trip from this computer. */
  roundTripMs: number | null;
  /** The last call failed; polling has stopped. */
  unreachable: boolean;
  error: string;
  failedAt: number;
};

const EMPTY: HostHealth = { roundTripMs: null, unreachable: false, error: "", failedAt: 0 };

let hosts = new Map<string, HostHealth>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeLab: (() => void) | null = null;
let fastCount = 0;

function publish(): void {
  hosts = new Map(hosts);
  for (const listener of listeners) {
    listener();
  }
}

function healthHosts(): LabHost[] {
  return getLabState().hosts.filter((host) => host.health);
}

async function ask(machineId: string): Promise<void> {
  if (inFlight.has(machineId)) {
    return;
  }
  inFlight.add(machineId);
  const started = performance.now();
  try {
    const health = await remoteRequest<LabHealth>(machineId, LAB_HEALTH_METHOD, {}, HEALTH_TIMEOUT_MS);
    hosts.set(machineId, {
      health,
      roundTripMs: performance.now() - started,
      unreachable: false,
      error: "",
      failedAt: 0,
    });
  } catch (reason) {
    const last = hosts.get(machineId) ?? EMPTY;
    hosts.set(machineId, {
      ...last,
      roundTripMs: null,
      unreachable: true,
      error: errorText(reason),
      failedAt: Date.now(),
    });
  } finally {
    inFlight.delete(machineId);
    publish();
  }
}

function pollAll(): void {
  if (document.visibilityState !== "visible") {
    return;
  }
  for (const host of healthHosts()) {
    if (!hosts.get(host.machine.id)?.unreachable) {
      void ask(host.machine.id);
    }
  }
}

function schedule(): void {
  if (timer) {
    clearTimeout(timer);
  }
  if (listeners.size === 0) {
    timer = null;
    return;
  }
  timer = setTimeout(
    () => {
      pollAll();
      schedule();
    },
    fastCount > 0 ? HEALTH_FAST_MS : HEALTH_SLOW_MS,
  );
}

/** A newly offered host gets asked at once; a lost one that's back resumes. */
function onLab(): void {
  let changed = false;
  const now = Date.now();
  for (const host of healthHosts()) {
    const id = host.machine.id;
    const known = hosts.get(id);
    if (!known) {
      hosts.set(id, EMPTY);
      void ask(id);
    } else if (known.unreachable && !host.offline && now - known.failedAt >= RESUME_AFTER_MS) {
      hosts.set(id, { ...known, unreachable: false, error: "" });
      changed = true;
      void ask(id);
    }
  }
  if (changed) {
    publish();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    unsubscribeLab = subscribeLab(onLab);
    onLab();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeLab?.();
      unsubscribeLab = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

function getSnapshot(): Map<string, HostHealth> {
  return hosts;
}

export function getHostHealth(all: ReadonlyMap<string, HostHealth>, machineId: string): HostHealth {
  return all.get(machineId) ?? EMPTY;
}

/** Try again, from the popover. */
export function retryHealth(machineId: string): void {
  const known = hosts.get(machineId);
  if (known) {
    hosts.set(machineId, { ...known, unreachable: false, error: "" });
    publish();
  }
  void ask(machineId);
}

/** Every host's health. `open`: something on screen shows it, so poll fast. */
export function useLabHealth(open = false): ReadonlyMap<string, HostHealth> {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!open) {
      return;
    }
    fastCount += 1;
    // What it shows should be fresh the moment it opens.
    for (const host of healthHosts()) {
      retryHealth(host.machine.id);
    }
    schedule();
    return () => {
      fastCount -= 1;
      schedule();
    };
  }, [open]);
  return value;
}

/** Pure, for the hook and tests: a host we can't reach says nothing here. */
export function dotFor(
  all: ReadonlyMap<string, HostHealth>,
  names: readonly { id: string; name: string }[],
): HealthDot {
  const several = names.length > 1;
  return combineDots(
    names.flatMap(({ id, name }) => {
      const entry = all.get(id);
      return entry?.health && !entry.unreachable ? [hostDot(entry.health, name, several)] : [];
    }),
  );
}

/** The chip's dot and hover words: amber for slow or strained, red for no response. */
export function useLabHealthDot(open = false): HealthDot {
  const all = useLabHealth(open);
  const names = getLabState().hosts.map((host) => ({ id: host.machine.id, name: host.machine.name }));
  return dotFor(all, names);
}

/** Forgets everything; for tests. */
export function resetLabHealthStore(): void {
  hosts = new Map();
  inFlight.clear();
  listeners.clear();
  fastCount = 0;
  unsubscribeLab?.();
  unsubscribeLab = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
