import { useEffect, useSyncExternalStore } from "react";
import {
  knownRemoteMachine,
  remoteRequest,
  useRemoteMachines,
} from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import { parseRemotePath } from "../../features/connections/model/remoteProjects";
import { IS_MAC } from "../../platform/tauri/platform";

/**
 * Fork feature: say which computer work is on, so a project, session or file
 * on the Linux laptop never looks like one on this Mac.
 *
 * - A remote machine reads "<name> · Linux" (or macOS, Windows), from the
 *   platform its host reports, and "<name> · remote" until that is known.
 * - This computer reads "This Mac" ("This computer" off macOS). Surfaces show
 *   it only while at least one remote machine is connected, as the contrast.
 *
 * Each machine's platform comes from its host's `environment.describe` and
 * is kept in localStorage, so labels are right at launch before it answers.
 * Off under the test runner, so upstream tests see no labels and no requests.
 */
export const FORK_MACHINE_LABELS = import.meta.env.MODE !== "test";

export type MachinePlatform = "darwin" | "linux" | "win32";

export type MachineInfo = {
  platform?: MachinePlatform;
  /** The host's OS name, e.g. "Fedora Linux 44". */
  osName?: string;
  /** The host's own hostname, which may differ from the name typed here. */
  hostname?: string;
  /** The host queues files and links for this Mac to show (`shows.*`). */
  shows?: boolean;
  /** When `environment.describe` last answered, ms since the epoch. */
  checkedAt: number;
};

/** Where a path lives, for labels. */
export type Where =
  | {
      remote: false;
      /** "This Mac" or "This computer". */
      label: string;
      /** False while no remote machine is connected: nothing to tell apart. */
      show: boolean;
    }
  | {
      remote: true;
      /** "Vivobook · Linux". */
      label: string;
      /** The name typed for the machine, or "Another machine". */
      name: string;
      /** Missing when the machine is not connected on this computer. */
      machine?: RemoteMachine;
      info?: MachineInfo;
    };

const KEY = "monocode.fork.machineInfo.v1";
/** How old a machine's info may get while a label using it is on screen. */
const STALE_MS = 10 * 60_000;

// ---- pure helpers ----

export function isMachinePlatform(value: unknown): value is MachinePlatform {
  return value === "darwin" || value === "linux" || value === "win32";
}

/** "Linux", "macOS" or "Windows"; undefined when unknown. */
export function osLabel(platform: unknown): string | undefined {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return undefined;
  }
}

/** "Vivobook · Linux", or "Vivobook · remote" while the OS is unknown. */
export function machineLabel(name: string | undefined, platform?: unknown): string {
  return `${name?.trim() || "Remote machine"} · ${osLabel(platform) ?? "remote"}`;
}

/** This computer's own label. */
export function localMachineLabel(isMac = IS_MAC): string {
  return isMac ? "This Mac" : "This computer";
}

/**
 * The settings line under a machine: "Linux · Fedora Linux 44", and
 * "host: <hostname>" after it when that differs from the typed name.
 */
export function machineDetail(
  info: MachineInfo | undefined,
  name?: string,
): string | undefined {
  if (!info) {
    return undefined;
  }
  const os = osLabel(info.platform);
  const parts = [
    os && info.osName && info.osName !== os ? `${os} · ${info.osName}` : (info.osName ?? os),
  ];
  const typed = name?.trim().toLowerCase();
  if (info.hostname && info.hostname.toLowerCase() !== typed) {
    parts.push(`host: ${info.hostname}`);
  }
  const text = parts.filter(Boolean).join(" · ");
  return text || undefined;
}

/** A host's `environment.describe` answer, reduced to what labels need. */
export function describeToInfo(value: unknown, now: number): MachineInfo {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (field: unknown, max: number) =>
    typeof field === "string" && field.trim() ? field.trim().slice(0, max) : undefined;
  return {
    platform: isMachinePlatform(record.platform) ? record.platform : undefined,
    osName: text(record.osName, 80),
    hostname: text(record.name, 80),
    shows:
      Array.isArray(record.capabilities) && record.capabilities.includes("shows"),
    checkedAt: now,
  };
}

/** Where a path lives, from the connected machines and their cached info. */
export function whereOf(
  path: string | undefined,
  machines: readonly RemoteMachine[],
  infoFor: (machineId: string) => MachineInfo | undefined = machineInfo,
  isMac = IS_MAC,
): Where {
  const remote = path ? parseRemotePath(path) : undefined;
  if (!remote) {
    return { remote: false, label: localMachineLabel(isMac), show: machines.length > 0 };
  }
  const machine = machines.find((entry) => entry.environmentId === remote.environmentId);
  const info = machine ? infoFor(machine.id) : undefined;
  const name = machine?.name.trim() || "Another machine";
  return { remote: true, label: machineLabel(name, info?.platform), name, machine, info };
}

// ---- per-machine info, shared by every window ----

let infos: Record<string, MachineInfo> | undefined;
const asking = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let storageBound = false;

function bump() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function parseStored(value: unknown): MachineInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const checkedAt = typeof record.checkedAt === "number" ? record.checkedAt : 0;
  return {
    ...describeToInfo({ ...record, name: record.hostname }, checkedAt),
    shows: record.shows === true,
  };
}

function load(): Record<string, MachineInfo> {
  if (!infos) {
    infos = {};
    try {
      const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [id, stored] of Object.entries(value)) {
          const info = parseStored(stored);
          if (info) {
            infos[id] = info;
          }
        }
      }
    } catch {
      // A blocked or broken store starts empty; labels read "remote" until
      // the machine answers.
    }
  }
  return infos;
}

function save(all: Record<string, MachineInfo>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Kept in memory for this window only.
  }
}

/** A machine's cached info, without asking it. */
export function machineInfo(machineId: string | undefined): MachineInfo | undefined {
  return machineId ? load()[machineId] : undefined;
}

/** Stores a machine's `environment.describe` answer. */
export function rememberMachineInfo(
  machineId: string,
  describe: unknown,
  now = Date.now(),
): MachineInfo {
  const all = load();
  const before = all[machineId];
  const info = describeToInfo(describe, now);
  infos = { ...all, [machineId]: info };
  save(infos);
  const changed =
    !before ||
    before.platform !== info.platform ||
    before.osName !== info.osName ||
    before.hostname !== info.hostname ||
    before.shows !== info.shows;
  if (changed) {
    bump();
  }
  return info;
}

/** Asks a machine for its info, once at a time; failures keep the old info. */
export async function refreshMachineInfo(machineId: string): Promise<void> {
  if (asking.has(machineId)) {
    return;
  }
  asking.add(machineId);
  try {
    rememberMachineInfo(
      machineId,
      await remoteRequest<unknown>(machineId, "environment.describe", {}),
    );
  } catch {
    // Offline or refusing: the cached info, if any, still stands.
  } finally {
    asking.delete(machineId);
  }
}

/** For code outside React: a `remote://` path's machine, from the caches. */
export function knownMachineFor(
  path: string,
): { machineId: string; name: string; platform?: MachinePlatform; label: string } | undefined {
  const remote = parseRemotePath(path);
  const machine = remote ? knownRemoteMachine(remote.environmentId) : undefined;
  if (!machine) {
    return undefined;
  }
  const platform = machineInfo(machine.id)?.platform;
  return {
    machineId: machine.id,
    name: machine.name,
    platform,
    label: machineLabel(machine.name, platform),
  };
}

function onStorage(event: StorageEvent) {
  if (event.key === KEY) {
    infos = undefined;
    bump();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageBound && typeof window !== "undefined") {
    // Another window stored newer info.
    window.addEventListener("storage", onStorage);
    storageBound = true;
  }
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

/** A machine's info, asked for when missing or older than ten minutes. */
export function useMachineInfo(machineId: string | undefined): MachineInfo | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => {
    if (!FORK_MACHINE_LABELS || !machineId) {
      return;
    }
    const info = machineInfo(machineId);
    if (!info || Date.now() - info.checkedAt > STALE_MS) {
      void refreshMachineInfo(machineId);
    }
  }, [machineId]);
  return machineInfo(machineId);
}

/** Where a path lives: its machine's label for a `remote://` path, this
 * computer's otherwise. Local labels carry `show: false` until a machine is
 * connected. */
export function useWhere(path: string | undefined): Where {
  const { machines } = useRemoteMachines(FORK_MACHINE_LABELS);
  const remote = path ? parseRemotePath(path) : undefined;
  const machine = remote
    ? machines.find((entry) => entry.environmentId === remote.environmentId)
    : undefined;
  const info = useMachineInfo(machine?.id);
  return whereOf(path, machines, () => info);
}
