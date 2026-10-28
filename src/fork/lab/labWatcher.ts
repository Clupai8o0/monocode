import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { remoteRequest } from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import { IS_LINUX, IS_WIN } from "../../platform/tauri/platform";
import {
  buildReport,
  decideSync,
  errorKind,
  hasLabCapability,
  localMachineName,
  parseLocalRemoteControl,
  type LocalRemoteControl,
} from "./labModel";
import type { LabParams, LabStatus, RemoteControlChoice } from "./labProtocol";

/**
 * Fork: Home lab, the watcher. Mounted once in App. Every minute, and when
 * Home lab settings or the machine list change, it settles the Remote Control
 * scope between this Mac and each lab host (newest choice wins), then tells
 * each host what this Mac now has. Quiet on errors: each kind is logged once.
 * Runs in the main window only, and not under the test runner.
 */
export const FORK_LAB_WATCHER = import.meta.env.MODE !== "test";

const PASS_MS = 60_000;
/** Fired by the Home lab settings after a change, so the watcher syncs now. */
export const LAB_CHANGED = "monocode:fork-lab-changed";
const MACHINES_CHANGED = "monocode:remote-machines";

export function notifyLabChanged(): void {
  window.dispatchEvent(new Event(LAB_CHANGED));
}

export type LabPlatform = LabParams["lab.report"]["platform"];

export function localPlatform(): LabPlatform {
  return IS_LINUX ? "linux" : IS_WIN ? "win32" : "darwin";
}

// ---- native and host calls, shared with the settings ----

export async function readLocalRemoteControl(): Promise<LocalRemoteControl> {
  const parsed = parseLocalRemoteControl(await invoke<unknown>("fork_lab_rc_status"));
  if (!parsed) {
    throw new Error("This Mac's Remote Control status came back unreadable.");
  }
  return parsed;
}

export async function applyLocalRemoteControl(choice: RemoteControlChoice): Promise<LocalRemoteControl> {
  const parsed = parseLocalRemoteControl(
    await invoke<unknown>("fork_lab_rc_apply", {
      scope: choice.scope,
      updatedAt: Math.max(0, Math.floor(choice.updatedAt)),
      by: (choice.by || "unknown").slice(0, 80),
    }),
  );
  if (!parsed) {
    throw new Error("This Mac's Remote Control status came back unreadable.");
  }
  return parsed;
}

export function labRequest<M extends keyof LabParams>(
  machineId: string,
  method: M,
  params: LabParams[M],
  timeoutMs?: number,
): Promise<LabStatus> {
  return remoteRequest<LabStatus>(machineId, method, params, timeoutMs);
}

// ---- one pass ----

export type LabDeps = {
  machines: () => Promise<RemoteMachine[]>;
  describe: (machineId: string) => Promise<unknown>;
  request: <M extends keyof LabParams>(machineId: string, method: M, params: LabParams[M]) => Promise<LabStatus>;
  readLocal: () => Promise<LocalRemoteControl>;
  applyLocal: (choice: RemoteControlChoice) => Promise<LocalRemoteControl>;
  platform: LabPlatform;
  /** Called on each failure; the default logs each kind once. */
  fail: (step: string, reason: unknown) => void;
};

export type PassResult = {
  /** Machine ids that answered lab.status. */
  hosts: string[];
  pushed: string[];
  pulled: string[];
  reported: string[];
  local?: LocalRemoteControl;
};

/** Settles the scope with every lab host, one after another, so a choice
 * pulled from one host is pushed to the next in the same pass. */
export async function runLabPass(deps: LabDeps): Promise<PassResult> {
  const result: PassResult = { hosts: [], pushed: [], pulled: [], reported: [] };
  let machines: RemoteMachine[];
  try {
    machines = await deps.machines();
  } catch (reason) {
    deps.fail("machines", reason);
    return result;
  }
  let local: LocalRemoteControl | undefined;
  for (const machine of machines) {
    let lab = false;
    try {
      lab = hasLabCapability(await deps.describe(machine.id));
    } catch (reason) {
      deps.fail("describe", reason);
    }
    if (!lab) {
      continue;
    }
    if (!local) {
      try {
        local = await deps.readLocal();
      } catch (reason) {
        deps.fail("local", reason);
        return result;
      }
    }
    let status: LabStatus;
    try {
      status = await deps.request(machine.id, "lab.status", {});
    } catch (reason) {
      deps.fail("status", reason);
      continue;
    }
    result.hosts.push(machine.id);
    const decision = decideSync(local, status.remoteControl.desired);
    try {
      if (decision.kind === "push") {
        await deps.request(machine.id, "lab.remoteControl.set", decision.params);
        result.pushed.push(machine.id);
      } else if (decision.kind === "pull") {
        local = await deps.applyLocal(decision.choice);
        result.pulled.push(machine.id);
      }
    } catch (reason) {
      deps.fail(decision.kind, reason);
    }
    try {
      await deps.request(
        machine.id,
        "lab.report",
        buildReport(localMachineName(local), deps.platform, local),
      );
      result.reported.push(machine.id);
    } catch (reason) {
      deps.fail("report", reason);
    }
  }
  result.local = local;
  return result;
}

const logged = new Set<string>();

function failOnce(step: string, reason: unknown): void {
  const kind = errorKind(step, reason);
  if (logged.has(kind)) {
    return;
  }
  logged.add(kind);
  console.warn(`[home lab] ${step} failed:`, reason);
}

export const liveDeps: LabDeps = {
  machines: async () => {
    const value = await invoke<RemoteMachine[]>("remote_machines");
    return Array.isArray(value) ? value : [];
  },
  describe: (machineId) => remoteRequest<unknown>(machineId, "environment.describe", {}),
  request: (machineId, method, params) => labRequest(machineId, method, params),
  readLocal: readLocalRemoteControl,
  applyLocal: applyLocalRemoteControl,
  platform: localPlatform(),
  fail: failOnce,
};

/** Runs passes until stopped; a change asked for mid-pass runs one more. */
export function startLabWatcher(deps: LabDeps = liveDeps, everyMs = PASS_MS): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  const pass = async () => {
    if (stopped) {
      return;
    }
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await runLabPass(deps);
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };
  const onChange = () => void pass();
  const timer = setInterval(onChange, everyMs);
  window.addEventListener(LAB_CHANGED, onChange);
  window.addEventListener(MACHINES_CHANGED, onChange);
  void pass();
  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener(LAB_CHANGED, onChange);
    window.removeEventListener(MACHINES_CHANGED, onChange);
  };
}

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

/** Mounted once in App; renders nothing. */
export function LabWatcher(): null
{
  useEffect(() => {
    if (!FORK_LAB_WATCHER || !isMainWindow()) {
      return;
    }
    return startLabWatcher();
  }, []);
  return null;
}
