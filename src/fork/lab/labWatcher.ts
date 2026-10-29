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
  isScope,
  localMachineName,
  parseLocalRemoteControl,
  type LocalRemoteControl,
} from "./labModel";
import { LAB_TZ_CAPABILITY, type LabParams, type LabStatus, type RemoteControlChoice } from "./labProtocol";
import { hostZoneToSend, parseAgentTimeZone, type AgentTimeZone } from "./agentTimeZone";

/**
 * Fork: Home lab, the watcher. Mounted once in App. Every minute, and when
 * Home lab settings or the machine list change, it settles the Remote Control
 * scope between this Mac and each lab host (newest choice wins), then tells
 * each host what this Mac now has, and the time zone its agents should start
 * in. Quiet on errors: each kind is logged once.
 * Runs in the main window only, and not under the test runner.
 */
export const FORK_LAB_WATCHER = import.meta.env.MODE !== "test";

const PASS_MS = 60_000;
/** Fired by the Home lab settings after a change, so the watcher syncs now. */
export const LAB_CHANGED = "monocode:fork-lab-changed";
/** Fired after a pass changed a host or this Mac, so the lab store reads them again. */
export const LAB_SYNCED = "monocode:fork-lab-synced";
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

/** The choice this Mac had when it read, for a guarded replace. */
export type ReadChoice = Pick<RemoteControlChoice, "scope" | "updatedAt">;

/** `over`: when mirroring a host's choice, the choice this Mac had when it
 * read; the host's older stamp may replace only that, never a choice saved
 * since. */
export async function applyLocalRemoteControl(
  choice: RemoteControlChoice,
  over?: ReadChoice,
): Promise<LocalRemoteControl> {
  const parsed = parseLocalRemoteControl(
    await invoke<unknown>("fork_lab_rc_apply", {
      scope: choice.scope,
      updatedAt: Math.max(0, Math.floor(choice.updatedAt)),
      by: (choice.by || "unknown").slice(0, 80),
      ...(over ? { over: { scope: over.scope, updatedAt: Math.max(0, Math.floor(over.updatedAt)) } } : {}),
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
  applyLocal: (choice: RemoteControlChoice, over?: ReadChoice) => Promise<LocalRemoteControl>;
  platform: LabPlatform;
  /** The agents' time zone as this Mac keeps it; without it, or when it
   * fails, hosts get the webview's own zone. */
  agentZone?: () => Promise<AgentTimeZone | null>;
  /** Called on each failure; the default logs each kind once. */
  fail: (step: string, reason: unknown) => void;
};

export type PassResult = {
  /** Machine ids that answered lab.status. */
  hosts: string[];
  pushed: string[];
  pulled: string[];
  reported: string[];
  /** Machine ids told a new agent time zone. */
  zoned: string[];
  local?: LocalRemoteControl;
};

function hasCapability(describe: unknown, capability: string): boolean {
  if (!describe || typeof describe !== "object") {
    return false;
  }
  const capabilities = (describe as Record<string, unknown>).capabilities;
  return Array.isArray(capabilities) && capabilities.includes(capability);
}

/** Settles the scope with one host, then reports what this Mac has. */
async function settleRemoteControl(
  deps: LabDeps,
  machineId: string,
  status: LabStatus,
  local: LocalRemoteControl,
  result: PassResult,
): Promise<LocalRemoteControl> {
  const decision = decideSync(local, status.remoteControl.desired);
  try {
    if (decision.kind === "push") {
      const answer = await deps.request(machineId, "lab.remoteControl.set", decision.params);
      const kept = answer?.remoteControl?.desired;
      if (kept && isScope(kept.scope) && typeof kept.updatedAt === "number" && kept.scope !== decision.params.scope) {
        // The host kept a choice its clock calls later. Take it here, with
        // the host's own stamp, or the same push is refused again every pass.
        local = await deps.applyLocal({ scope: kept.scope, updatedAt: kept.updatedAt, by: kept.by }, local);
        result.pulled.push(machineId);
      } else {
        result.pushed.push(machineId);
      }
    } else if (decision.kind === "pull") {
      // Mirror the host's stamp, even when this Mac's own ran ahead of it.
      local = await deps.applyLocal(decision.choice, local);
      result.pulled.push(machineId);
    }
  } catch (reason) {
    deps.fail(decision.kind, reason);
  }
  try {
    await deps.request(machineId, "lab.report", buildReport(localMachineName(local), deps.platform, local));
    result.reported.push(machineId);
  } catch (reason) {
    deps.fail("report", reason);
  }
  return local;
}

/** Settles the scope with every lab host, one after another, so a choice
 * pulled from one host is pushed to the next in the same pass. */
export async function runLabPass(deps: LabDeps): Promise<PassResult> {
  const result: PassResult = { hosts: [], pushed: [], pulled: [], reported: [], zoned: [] };
  let machines: RemoteMachine[];
  try {
    machines = await deps.machines();
  } catch (reason) {
    deps.fail("machines", reason);
    return result;
  }
  let local: LocalRemoteControl | undefined;
  let localFailed = false;
  // Read for each host, so a zone picked mid-pass reaches the hosts after it.
  const zoneToSend = async (): Promise<string> => {
    let value: AgentTimeZone | null = null;
    try {
      value = deps.agentZone ? await deps.agentZone() : null;
    } catch (reason) {
      deps.fail("zone", reason);
    }
    return hostZoneToSend(value);
  };
  for (const machine of machines) {
    let lab = false;
    let tz = false;
    try {
      const describe = await deps.describe(machine.id);
      lab = hasLabCapability(describe);
      tz = hasCapability(describe, LAB_TZ_CAPABILITY);
    } catch (reason) {
      deps.fail("describe", reason);
    }
    if (!lab) {
      continue;
    }
    if (!local && !localFailed) {
      try {
        local = await deps.readLocal();
      } catch (reason) {
        deps.fail("local", reason);
        localFailed = true;
      }
    }
    // Without this Mac's Remote Control there is nothing to settle; a host
    // that takes a zone is still told it.
    if (!local && !tz) {
      continue;
    }
    let status: LabStatus;
    try {
      status = await deps.request(machine.id, "lab.status", {});
    } catch (reason) {
      deps.fail("status", reason);
      continue;
    }
    result.hosts.push(machine.id);
    if (local) {
      local = await settleRemoteControl(deps, machine.id, status, local, result);
    }
    if (tz) {
      try {
        const wanted = await zoneToSend();
        if (status.timeZone?.zone !== wanted) {
          await deps.request(machine.id, "lab.timeZone.set", { zone: wanted });
          result.zoned.push(machine.id);
        }
      } catch (reason) {
        deps.fail("timeZone", reason);
      }
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
  agentZone: async () => parseAgentTimeZone(await invoke<unknown>("fork_agent_tz_get")) ?? null,
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
        const result = await runLabPass(deps);
        if (result.pushed.length || result.pulled.length || result.zoned.length) {
          window.dispatchEvent(new Event(LAB_SYNCED));
        }
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
