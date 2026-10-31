import { useEffect, useSyncExternalStore } from "react";

/**
 * Fork: what the footer's Machines chip knows. Lab, Stacks and Memory stay
 * separate components: each publishes its signal here and draws its own panel
 * into the popover's tab while that tab shows.
 */

export type MachineTab = "lab" | "stacks" | "memory";
export type MachineTone = "amber" | "red";

export type MachineSignal = {
  tone: MachineTone | null;
  /** Why the tone is on, in the words that component already uses. */
  why: string;
  /** Short state for the chip's calm hover text, such as "Stacks · 2 up". */
  detail: string;
};

export const MACHINE_TABS: readonly { id: MachineTab; label: string }[] = [
  { id: "lab", label: "Lab" },
  { id: "stacks", label: "Stacks" },
  { id: "memory", label: "Memory" },
];

const LAST_KEY = "monocode.fork.machines.tab";
const QUIET: MachineSignal = { tone: null, why: "", detail: "" };

export type MachineSignals = Readonly<Record<MachineTab, MachineSignal>>;

const NONE: MachineSignals = { lab: QUIET, stacks: QUIET, memory: QUIET };

/** Red beats amber; on a tie the first tab wins. */
export function alertTab(signals: MachineSignals): MachineTab | null {
  const toned = MACHINE_TABS.filter(({ id }) => signals[id].tone);
  const red = toned.find(({ id }) => signals[id].tone === "red");
  return (red ?? toned[0])?.id ?? null;
}

export function worstTone(signals: MachineSignals): MachineTone | null {
  const tab = alertTab(signals);
  return tab ? signals[tab].tone : null;
}

/** Why it's lit, worst first; when all is well, how things stand. */
export function machinesHover(signals: MachineSignals): string {
  const order = [...MACHINE_TABS].sort(
    (a, b) => rank(signals[b.id].tone) - rank(signals[a.id].tone),
  );
  const whys = order.flatMap(({ id }) => (signals[id].tone && signals[id].why ? [signals[id].why] : []));
  if (whys.length) {
    return whys.join(" ");
  }
  const details = MACHINE_TABS.flatMap(({ id }) => (signals[id].detail ? [signals[id].detail] : []));
  return details.length ? details.join(", ") : "Machines";
}

function rank(tone: MachineTone | null): number {
  return tone === "red" ? 2 : tone === "amber" ? 1 : 0;
}

function loadLastTab(): MachineTab {
  try {
    const last = localStorage.getItem(LAST_KEY);
    return MACHINE_TABS.find(({ id }) => id === last)?.id ?? "lab";
  } catch {
    return "lab";
  }
}

let signals = NONE;
let open = false;
let host: HTMLElement | null = null;
let tab: MachineTab | null = null;
let lastTab: MachineTab | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishMachineSignal(id: MachineTab, next: MachineSignal): void {
  signals = { ...signals, [id]: next };
  notify();
}

/** Keeps a component's signal in the store for as long as it's mounted. */
export function useMachineSignal(id: MachineTab, next: MachineSignal): void {
  const { tone, why, detail } = next;
  useEffect(() => {
    publishMachineSignal(id, { tone, why, detail });
    return () => publishMachineSignal(id, QUIET);
  }, [id, tone, why, detail]);
}

export function useMachineSignals(): MachineSignals {
  return useSyncExternalStore(subscribe, () => signals);
}

/** An alert opens on the tab that caused it, otherwise on the last one used. */
export function openMachines(): void {
  lastTab ??= loadLastTab();
  tab = alertTab(signals) ?? lastTab;
  open = true;
  notify();
}

export function closeMachines(): void {
  open = false;
  notify();
}

/** The person chose this tab, so it's the one to come back to. */
export function pickMachineTab(next: MachineTab): void {
  tab = next;
  lastTab = next;
  try {
    localStorage.setItem(LAST_KEY, next);
  } catch {
    // Only a convenience; a full or blocked store just forgets it.
  }
  notify();
}

export function setMachinesHost(next: HTMLElement | null): void {
  host = next;
  notify();
}

export function useMachinesOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

export function currentMachineTab(): MachineTab | null {
  return open ? tab : null;
}

export function useMachineTab(): MachineTab | null {
  return useSyncExternalStore(subscribe, currentMachineTab);
}

/** Where a component draws its panel: set only while its tab is showing. */
export function useMachineHost(id: MachineTab): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => (open && tab === id ? host : null));
}

/** Forgets everything; for tests. */
export function resetMachines(): void {
  signals = NONE;
  open = false;
  host = null;
  tab = null;
  lastTab = null;
}
