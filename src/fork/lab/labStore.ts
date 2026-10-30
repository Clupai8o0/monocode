import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { remoteRequest } from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import {
  errorText,
  hasCapability,
  hasLabCapability,
  hasTimeZoneCapability,
  localMachineName,
  parseLocalRelay,
  type LocalRelayStatus,
  type LocalRemoteControl,
} from "./labModel";
import { LAB_HEALTH_CAPABILITY, type LabParams, type LabStatus, type RemoteControlScope } from "./labProtocol";
import {
  LAB_CHANGED,
  LAB_SYNCED,
  applyLocalRemoteControl,
  labRequest,
  notifyLabChanged,
  readLocalRemoteControl,
} from "./labWatcher";

/**
 * Fork: Home lab, the shared store. One copy for the footer chip and the
 * Home lab settings: which connected machines are lab hosts (asked once, and
 * again when the machine list changes), each host's lab.status, this Mac's
 * Remote Control and relay, and what is busy or failed. Busy state lives here,
 * not in a component, so a slow change still shows after a popover closes and
 * opens again. Polls every minute while anything is subscribed.
 */

const MACHINES_CHANGED = "monocode:remote-machines";
export const LAB_POLL_MS = 60_000;
/** uresourced and remote desktop changes wait on systemd and a probe. */
export const SLOW_MS = 60_000;
/** Opens Settings at the Home lab section; App listens for it. */
export const OPEN_LAB_SETTINGS = "monocode:fork-open-lab-settings";

export type LabHost = {
  machine: RemoteMachine;
  /** Its describe lists lab.tz.v1. */
  timeZone: boolean;
  /** Its describe lists lab.health.v1. */
  health: boolean;
  /** The last lab.status it answered; kept while it is offline. */
  status?: LabStatus;
  /** Its last lab.status failed. */
  offline: boolean;
  /** A lab.status is on its way. */
  loading: boolean;
};

export type LabState = {
  /** The machine list has been read once. */
  machinesLoaded: boolean;
  /** Connected machines, lab hosts or not. */
  machineCount: number;
  /** No lab host has answered yet and some machine is still being asked. */
  discovering: boolean;
  hosts: LabHost[];
  local?: LocalRemoteControl;
  localError: string;
  relay?: LocalRelayStatus;
  relayError: string;
  /** By action key: "scope", or "<machineId>:<action>". */
  busy: Record<string, true>;
  /** By action key, in plain words. "<machineId>:load" is the last lab.status failure. */
  errors: Record<string, string>;
};

export type HostAction = "relay" | "ures" | "probe" | "rdp" | "tz" | "scope";

export function actionKey(machineId: string, action: HostAction | "load"): string {
  return `${machineId}:${action}`;
}

/** Something is changing on this host, the scope included. */
export function hostBusy(state: LabState, machineId: string): boolean {
  return !!state.busy.scope || Object.keys(state.busy).some((key) => key.startsWith(`${machineId}:`));
}

/** This host's failures, the scope's own first. */
export function hostErrors(state: LabState, machineId: string): string[] {
  const keys = ["scope", ...Object.keys(state.errors).filter((key) => key.startsWith(`${machineId}:`))];
  return [...new Set(keys.map((key) => state.errors[key]).filter(Boolean))];
}

// ---- state ----

type Known = { lab: boolean; timeZone: boolean; health: boolean };

let machines: RemoteMachine[] = [];
let machinesLoaded = false;
const known = new Map<string, Known>();
/** When each machine last said what it offers. Asked again after
 * DESCRIBE_MS, so a host updated while the app runs shows what it gained. */
const describedAt = new Map<string, number>();
const DESCRIBE_MS = 5 * 60_000;
const asking = new Set<string>();
/** Machines whose describe failed and that were never answered. */
const failed = new Set<string>();
const statuses = new Map<string, LabStatus>();
const offline = new Set<string>();
/** lab.status reads on their way, per host. */
const loading = new Map<string, number>();
/** Request counters per host: a lab.status that started before the latest
 * applied answer, or before a change answered, is dropped. */
const counter = new Map<string, number>();
const floor = new Map<string, number>();
let local: LocalRemoteControl | undefined;
let localError = "";
let relay: LocalRelayStatus | undefined;
let relayError = "";
let busy: Record<string, true> = {};
let errors: Record<string, string> = {};

function build(): LabState {
  const hosts = machines.flatMap((machine): LabHost[] => {
    const entry = known.get(machine.id);
    if (!entry?.lab) {
      return [];
    }
    return [
      {
        machine,
        timeZone: entry.timeZone,
        health: entry.health,
        status: statuses.get(machine.id),
        offline: offline.has(machine.id),
        loading: (loading.get(machine.id) ?? 0) > 0,
      },
    ];
  });
  return {
    machinesLoaded,
    machineCount: machines.length,
    discovering: hosts.length === 0 && machines.some(
        (machine) => asking.has(machine.id) || (!known.has(machine.id) && !failed.has(machine.id)),
      ),
    hosts,
    local,
    localError,
    relay,
    relayError,
    busy,
    errors,
  };
}

let current: LabState = build();
const listeners = new Set<() => void>();

function publish(): void {
  current = build();
  for (const listener of listeners) {
    listener();
  }
}

export function getLabState(): LabState {
  return current;
}

function setBusy(key: string, on: boolean): void {
  if (on) {
    busy = { ...busy, [key]: true };
  } else {
    const rest = { ...busy };
    delete rest[key];
    busy = rest;
  }
}

function setError(key: string, message: string): void {
  if (message) {
    errors = { ...errors, [key]: message };
  } else if (key in errors) {
    const rest = { ...errors };
    delete rest[key];
    errors = rest;
  }
}

/** A new change on a host clears that host's old failures, as one panel did. */
function clearHostErrors(machineId: string): void {
  errors = Object.fromEntries(Object.entries(errors).filter(([key]) => !key.startsWith(`${machineId}:`)));
}

// ---- reads ----

async function readMachines(): Promise<void> {
  try {
    const value = await invoke<RemoteMachine[]>("remote_machines");
    machines = Array.isArray(value) ? value : [];
  } catch {
    // Keep the last list; a passing failure should not hide the hosts.
  }
  machinesLoaded = true;
  const ids = new Set(machines.map((machine) => machine.id));
  for (const id of [...known.keys()]) {
    if (!ids.has(id)) {
      known.delete(id);
      describedAt.delete(id);
      failed.delete(id);
      statuses.delete(id);
      offline.delete(id);
    }
  }
}

/** Asks one machine what it offers. A failure keeps what was known, and a
 * machine never answered is asked again on the next refresh. */
async function describe(machine: RemoteMachine): Promise<void> {
  asking.add(machine.id);
  publish();
  try {
    const answer = await remoteRequest<unknown>(machine.id, "environment.describe", {});
    known.set(machine.id, {
      lab: hasLabCapability(answer),
      timeZone: hasTimeZoneCapability(answer),
      health: hasCapability(answer, LAB_HEALTH_CAPABILITY),
    });
    describedAt.set(machine.id, Date.now());
    failed.delete(machine.id);
  } catch {
    // Asked again on the next refresh.
    failed.add(machine.id);
  } finally {
    asking.delete(machine.id);
    publish();
  }
}

function nextCount(machineId: string): number {
  const value = (counter.get(machineId) ?? 0) + 1;
  counter.set(machineId, value);
  return value;
}

/** lab.status for one host; marks it offline when it fails. */
async function loadStatus(machineId: string): Promise<void> {
  const count = nextCount(machineId);
  loading.set(machineId, (loading.get(machineId) ?? 0) + 1);
  publish();
  try {
    const status = await labRequest(machineId, "lab.status", {});
    if (count > (floor.get(machineId) ?? 0)) {
      floor.set(machineId, count);
      statuses.set(machineId, status);
      offline.delete(machineId);
      setError(actionKey(machineId, "load"), "");
    }
  } catch (reason) {
    if (count > (floor.get(machineId) ?? 0)) {
      floor.set(machineId, count);
      offline.add(machineId);
      setError(actionKey(machineId, "load"), errorText(reason));
    }
  } finally {
    loading.set(machineId, Math.max(0, (loading.get(machineId) ?? 0) - 1));
    publish();
  }
}

async function loadLocal(): Promise<void> {
  try {
    local = await readLocalRemoteControl();
    localError = "";
  } catch (reason) {
    localError = errorText(reason, "Reading Remote Control here");
  }
  publish();
}

async function loadRelay(): Promise<void> {
  try {
    relay = parseLocalRelay(await invoke<unknown>("fork_relay_status"));
    relayError = "";
  } catch (reason) {
    relayError = errorText(reason, "This Mac's relay status");
  }
  publish();
}

async function refreshMachine(machine: RemoteMachine, rediscover: boolean): Promise<void> {
  const stale = Date.now() - (describedAt.get(machine.id) ?? 0) >= DESCRIBE_MS;
  if (rediscover || !known.has(machine.id) || stale) {
    await describe(machine);
  }
  if (known.get(machine.id)?.lab) {
    await loadStatus(machine.id);
  }
}

let inFlight: Promise<void> | null = null;
let again: { rediscover: boolean } | null = null;

/** Reads every lab host's status and this Mac's side. `rediscover` reads the
 * machine list and asks every machine again what it offers. A call made
 * while one runs runs once more after it. */
export function refreshLab(options: { rediscover?: boolean } = {}): Promise<void> {
  const rediscover = options.rediscover ?? false;
  if (inFlight) {
    again = { rediscover: rediscover || (again?.rediscover ?? false) };
    return inFlight;
  }
  inFlight = (async () => {
    let round: { rediscover: boolean } | null = { rediscover };
    while (round) {
      again = null;
      if (round.rediscover || !machinesLoaded) {
        await readMachines();
        publish();
      }
      const fresh = round.rediscover;
      await Promise.all([loadLocal(), loadRelay(), ...machines.map((machine) => refreshMachine(machine, fresh))]);
      round = again;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// ---- changes ----

/** Runs a lab method on one host under an action key, keeps its answer, and
 * returns it; a failure is kept under the key, in words, and gives undefined. */
export async function runHostAction<M extends keyof LabParams>(
  machineId: string,
  action: HostAction,
  method: M,
  params: LabParams[M],
  timeoutMs?: number,
): Promise<LabStatus | undefined> {
  const key = actionKey(machineId, action);
  if (busy[key]) {
    return undefined;
  }
  clearHostErrors(machineId);
  setBusy(key, true);
  publish();
  nextCount(machineId);
  try {
    const status = await labRequest(machineId, method, params, timeoutMs);
    // A change's answer is the newest there is: any status asked before now is stale.
    floor.set(machineId, counter.get(machineId) ?? 0);
    statuses.set(machineId, status);
    offline.delete(machineId);
    return status;
  } catch (reason) {
    setError(key, errorText(reason));
    return undefined;
  } finally {
    setBusy(key, false);
    publish();
  }
}

/** Remote Control scope: this Mac first, then every reachable lab host, then
 * the watcher is told. A host that keeps a newer choice says so. */
export async function setScope(scope: RemoteControlScope): Promise<void> {
  if (busy.scope) {
    return;
  }
  const hosts = current.hosts.filter((host) => !host.offline);
  const updatedAt = Math.max(
    Date.now(),
    ...hosts.map((host) => (host.status?.remoteControl.desired.updatedAt ?? 0) + 1),
    (local?.updatedAt ?? 0) + 1,
  );
  const choice = { scope, updatedAt, by: localMachineName(local) };
  setBusy("scope", true);
  setError("scope", "");
  publish();
  let localFailure = "";
  try {
    local = await applyLocalRemoteControl(choice);
    localError = "";
  } catch (reason) {
    localFailure = errorText(reason, "Changing it on this Mac");
  }
  const answers = await Promise.all(
    hosts.map((host) =>
      runHostAction(host.machine.id, "scope", "lab.remoteControl.set", { scope, updatedAt: choice.updatedAt }),
    ),
  );
  const kept = answers.some((next) => next && next.remoteControl.desired.scope !== scope) ? "A newer choice was kept." : "";
  setError("scope", [localFailure, kept].filter(Boolean).join(" "));
  setBusy("scope", false);
  publish();
  notifyLabChanged();
}

export function setRelay(machineId: string, enabled: boolean): Promise<void> {
  return runHostAction(machineId, "relay", "lab.relay.set", { enabled }).then(() => loadRelay());
}

export function setUresourced(machineId: string, action: LabParams["lab.uresourced.set"]["action"]): Promise<unknown> {
  return runHostAction(machineId, "ures", "lab.uresourced.set", { action }, SLOW_MS);
}

export function setRemoteDesktop(machineId: string, enabled: boolean): Promise<unknown> {
  return runHostAction(machineId, "rdp", "lab.remoteDesktop.set", { enabled }, SLOW_MS);
}

/** A fresh 2 s look at uresourced on the bus. */
export function probeLab(machineId: string): Promise<unknown> {
  return runHostAction(machineId, "probe", "lab.status", { probe: true }, SLOW_MS);
}

/** Reads one host again, and this Mac's side. */
/** Settings' Refresh: also asks the host again what it offers, alongside
 * its status, so a slow answer to one can't hold up the other. */
export function reloadHost(machineId: string): Promise<unknown> {
  const machine = machines.find((entry) => entry.id === machineId);
  return Promise.all([machine ? describe(machine) : null, loadStatus(machineId), loadLocal(), loadRelay()]);
}

export function openLabSettings(): void {
  window.dispatchEvent(new Event(OPEN_LAB_SETTINGS));
}

// ---- subscription ----

let timer: ReturnType<typeof setInterval> | null = null;
const onLabChanged = () => void refreshLab();
const onMachinesChanged = () => void refreshLab({ rediscover: true });

export function subscribeLab(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    void refreshLab();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshLab();
      }
    }, LAB_POLL_MS);
    window.addEventListener(LAB_CHANGED, onLabChanged);
    window.addEventListener(LAB_SYNCED, onLabChanged);
    window.addEventListener(MACHINES_CHANGED, onMachinesChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      window.removeEventListener(LAB_CHANGED, onLabChanged);
      window.removeEventListener(LAB_SYNCED, onLabChanged);
      window.removeEventListener(MACHINES_CHANGED, onMachinesChanged);
    }
  };
}

export function useLab(): LabState {
  return useSyncExternalStore(subscribeLab, getLabState, getLabState);
}

/** Forgets everything; for tests. */
export function resetLabStore(): void {
  machines = [];
  machinesLoaded = false;
  known.clear();
  describedAt.clear();
  asking.clear();
  failed.clear();
  statuses.clear();
  offline.clear();
  loading.clear();
  counter.clear();
  floor.clear();
  local = undefined;
  localError = "";
  relay = undefined;
  relayError = "";
  busy = {};
  errors = {};
  inFlight = null;
  again = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
    window.removeEventListener(LAB_CHANGED, onLabChanged);
    window.removeEventListener(MACHINES_CHANGED, onMachinesChanged);
  }
  listeners.clear();
  current = build();
}
