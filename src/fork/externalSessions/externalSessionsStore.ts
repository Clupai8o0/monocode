import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "../../features/connections/model/connections";
import type {
  ExternalSession,
  ExternalSessionsTarget,
  ExternalTranscriptPage,
} from "./externalSessionsModel";

export type ExternalSessionsState = {
  sessions: ExternalSession[];
  loading: boolean;
  /** The last read failed; `sessions` keeps the last good list. */
  error?: string;
  /** False when the machine's host predates this feature. */
  supported: boolean;
  refresh: () => void;
};

/**
 * One poller per machine, shared by every project shown: this Mac gets one
 * `fork_external_sessions_list` with every subscribed project, a remote
 * machine one `externalSessions.list` for all of its projects. It polls only
 * while the window is visible, and is off under the test runner so upstream
 * tests start no timers.
 */
export const FORK_EXTERNAL_SESSIONS = import.meta.env.MODE !== "test";

const LOCAL_POLL_MS = 10_000;
const REMOTE_POLL_MS = 20_000;
/** How long to leave a host alone after it says it lacks the methods. */
const UNSUPPORTED_RETRY_MS = 5 * 60_000;
const LOCAL = "local";

// ---- pure helpers ----

/** Session ids MonoCode runs itself, which must not show as "elsewhere". */
export function ownSessionIds(
  sessions: readonly { providerSessionId?: string }[],
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.providerSessionId) {
      ids.add(session.providerSessionId);
    }
  }
  return ids;
}

export function withoutOwnSessions(
  sessions: readonly ExternalSession[],
  own: ReadonlySet<string>,
): ExternalSession[] {
  return sessions.filter((session) => !own.has(session.id));
}

/** Rows by project id. */
export function groupByProject(
  sessions: readonly ExternalSession[],
): Map<string, ExternalSession[]> {
  const groups = new Map<string, ExternalSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.projectId);
    if (group) {
      group.push(session);
    } else {
      groups.set(session.projectId, [session]);
    }
  }
  return groups;
}

/** A host from before this feature: it does not know the method. */
export function isUnsupportedError(error: unknown): boolean {
  const text = String(
    error instanceof Error ? error.message : (error ?? ""),
  ).toLowerCase();
  return /unknown|unsupported|not supported|not found: method|no such method|method not found/.test(
    text,
  ) && !/session not found/.test(text);
}

export function machineKey(target: ExternalSessionsTarget): string {
  return target.kind === "local" ? LOCAL : `remote:${target.machineId}`;
}

// ---- own sessions, published by the app ----

let own = new Set<string>();

/** App calls this as sessions change. */
export function publishOwnSessions(
  sessions: readonly { providerSessionId?: string }[],
): void {
  const next = ownSessionIds(sessions);
  if (next.size === own.size && [...next].every((id) => own.has(id))) {
    return;
  }
  own = next;
  bump();
}

// ---- shared pollers ----

type Machine = {
  key: string;
  machineId?: string;
  /** Local project id -> folder, with a count of hooks asking. */
  projects: Map<string, { cwd?: string; count: number }>;
  rows: ExternalSession[];
  loaded: boolean;
  loading: boolean;
  error?: string;
  supported: boolean;
  unsupportedUntil: number;
  inFlight: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

const machines = new Map<string, Machine>();
const listeners = new Set<() => void>();
let version = 0;
let visibilityBound = false;

function bump() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function refreshMachine(machine: Machine) {
  if (machine.inFlight || machine.projects.size === 0) {
    return;
  }
  if (machine.machineId && Date.now() < machine.unsupportedUntil) {
    return;
  }
  machine.inFlight = true;
  if (!machine.loaded) {
    machine.loading = true;
    bump();
  }
  const request = machine.machineId
    ? remoteRequest<{ sessions?: ExternalSession[] }>(
        machine.machineId,
        "externalSessions.list",
        {},
      )
    : invoke<{ sessions?: ExternalSession[] }>("fork_external_sessions_list", {
        projects: [...machine.projects].map(([projectId, { cwd }]) => ({
          projectId,
          cwd,
        })),
      });
  request
    .then((result) => {
      machine.rows = Array.isArray(result?.sessions) ? result.sessions : [];
      machine.supported = true;
      machine.error = undefined;
    })
    .catch((error: unknown) => {
      if (machine.machineId && isUnsupportedError(error)) {
        machine.supported = false;
        machine.rows = [];
        machine.error = undefined;
        machine.unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_MS;
      } else {
        machine.error = String(
          error instanceof Error ? error.message : error,
        );
      }
    })
    .finally(() => {
      machine.inFlight = false;
      machine.loaded = true;
      machine.loading = false;
      bump();
    });
}

function onVisible() {
  if (!hidden()) {
    for (const machine of machines.values()) {
      refreshMachine(machine);
    }
  }
}

function startTimer(machine: Machine) {
  if (machine.timer) {
    return;
  }
  const every = machine.machineId ? REMOTE_POLL_MS : LOCAL_POLL_MS;
  machine.timer = setInterval(() => {
    if (!hidden()) {
      refreshMachine(machine);
    }
  }, every);
  if (!visibilityBound && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
    visibilityBound = true;
  }
}

function stopTimer(machine: Machine) {
  if (machine.timer) {
    clearInterval(machine.timer);
    machine.timer = null;
  }
  if (machines.size === 0 && visibilityBound) {
    document.removeEventListener("visibilitychange", onVisible);
    visibilityBound = false;
  }
}

function addTarget(target: ExternalSessionsTarget) {
  const key = machineKey(target);
  let machine = machines.get(key);
  if (!machine) {
    machine = {
      key,
      machineId: target.kind === "remote" ? target.machineId : undefined,
      projects: new Map(),
      rows: [],
      loaded: false,
      loading: false,
      supported: true,
      unsupportedUntil: 0,
      inFlight: false,
      timer: null,
    };
    machines.set(key, machine);
  }
  const entry = machine.projects.get(target.projectId);
  if (entry) {
    entry.count += 1;
  } else {
    machine.projects.set(target.projectId, {
      cwd: target.kind === "local" ? target.cwd : undefined,
      count: 1,
    });
    // A new local project needs its own rows now; a remote list has them all.
    if (target.kind === "local" || !machine.loaded) {
      refreshMachine(machine);
    }
  }
  startTimer(machine);
}

function removeTarget(target: ExternalSessionsTarget) {
  const machine = machines.get(machineKey(target));
  const entry = machine?.projects.get(target.projectId);
  if (!machine || !entry) {
    return;
  }
  entry.count -= 1;
  if (entry.count > 0) {
    return;
  }
  machine.projects.delete(target.projectId);
  if (machine.projects.size === 0) {
    machines.delete(machine.key);
    stopTimer(machine);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

function targetKey(target: ExternalSessionsTarget | undefined): string {
  if (!target) {
    return "";
  }
  return target.kind === "local"
    ? `local\0${target.projectId}\0${target.cwd}`
    : `remote\0${target.machineId}\0${target.projectId}`;
}

const EMPTY: ExternalSession[] = [];

/** One project's sessions elsewhere, kept fresh while shown. */
export function useExternalSessions(
  target: ExternalSessionsTarget | undefined,
): ExternalSessionsState {
  const key = targetKey(target);
  const on = FORK_EXTERNAL_SESSIONS && !!target;
  useEffect(() => {
    if (!on || !target) {
      return;
    }
    addTarget(target);
    return () => removeTarget(target);
    // The key stands for the target's fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const machine = on && target ? machines.get(machineKey(target)) : undefined;
  const refresh = () => {
    if (machine) {
      refreshMachine(machine);
    }
  };
  if (!machine || !target) {
    return { sessions: EMPTY, loading: false, supported: on, refresh };
  }
  const rows = withoutOwnSessions(
    groupByProject(machine.rows).get(target.projectId) ?? EMPTY,
    own,
  );
  return {
    sessions: rows,
    loading: machine.loading,
    error: machine.error,
    supported: machine.supported,
    refresh,
  };
}

/** One page of a session's turns; the newest page when `before` is absent. */
export async function readExternalSession(
  target: ExternalSessionsTarget,
  sessionId: string,
  before?: number,
): Promise<ExternalTranscriptPage> {
  if (target.kind === "local") {
    return invoke<ExternalTranscriptPage>("fork_external_sessions_read", {
      projects: [{ projectId: target.projectId, cwd: target.cwd }],
      projectId: target.projectId,
      sessionId,
      before: before ?? null,
      limit: null,
    });
  }
  return remoteRequest<ExternalTranscriptPage>(
    target.machineId,
    "externalSessions.read",
    before === undefined
      ? { projectId: target.projectId, sessionId }
      : { projectId: target.projectId, sessionId, before },
  );
}
