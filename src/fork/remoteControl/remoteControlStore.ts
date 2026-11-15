import { useSyncExternalStore } from "react";

/**
 * Fork: which sessions the user turned Remote Control on for, and where each
 * one stands. The wish is kept in this browser's storage, so a session that
 * restarts (after a close to free memory, or an app restart) turns it back on
 * when its Claude starts again. The live state is in memory only.
 */

const WANTED_KEY = "monocode.fork.remoteControl.sessions";
/** Sessions the user turned it off for, which beats Claude's startup setting. */
const REFUSED_KEY = "monocode.fork.remoteControl.offSessions";

export type RemoteControlState =
  /** Off, or never asked. */
  | { status: "off" }
  /** Wanted, but this session's Claude isn't running; it starts with it. */
  | { status: "waiting" }
  | { status: "starting" }
  /** Turning off; still reachable until Claude confirms. */
  | { status: "stopping"; url?: string }
  /** `error`: a request to turn it off failed. */
  | { status: "on"; url?: string; error?: string }
  | { status: "failed"; error: string };

const OFF: RemoteControlState = { status: "off" };
const WAITING: RemoteControlState = { status: "waiting" };

let wanted: Set<string> | null = null;
let refused: Set<string> | null = null;
const states = new Map<string, RemoteControlState>();
const listeners = new Set<() => void>();

function readIds(key: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(
      Array.isArray(raw)
        ? raw.filter((id): id is string => typeof id === "string" && !!id)
        : [],
    );
  } catch {
    return new Set();
  }
}

function wantedSet(): Set<string> {
  wanted ??= readIds(WANTED_KEY);
  return wanted;
}

function refusedSet(): Set<string> {
  refused ??= readIds(REFUSED_KEY);
  return refused;
}

function writeIds(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Storage blocked: the choice lasts until the app quits.
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** True when the user turned Remote Control on for this session. */
export function remoteControlWanted(sessionId: string): boolean {
  return wantedSet().has(sessionId);
}

/**
 * The user's choice for this session: true on, false off, undefined when
 * they never chose, so Claude's `remoteControlAtStartup` setting decides.
 */
export function remoteControlChoice(sessionId: string): boolean | undefined {
  if (wantedSet().has(sessionId)) {
    return true;
  }
  return refusedSet().has(sessionId) ? false : undefined;
}

/** Remember that this session should run with Remote Control on, or off. */
export function setRemoteControlWanted(sessionId: string, on: boolean): void {
  if (remoteControlChoice(sessionId) === on) {
    return;
  }
  const add = on ? wantedSet() : refusedSet();
  const drop = on ? refusedSet() : wantedSet();
  add.add(sessionId);
  drop.delete(sessionId);
  writeIds(WANTED_KEY, wantedSet());
  writeIds(REFUSED_KEY, refusedSet());
  notify();
}

export function remoteControlState(sessionId: string): RemoteControlState {
  return (
    states.get(sessionId) ?? (remoteControlWanted(sessionId) ? WAITING : OFF)
  );
}

export function setRemoteControlState(
  sessionId: string,
  state: RemoteControlState,
): void {
  if (state.status === "off") {
    states.delete(sessionId);
  } else {
    states.set(sessionId, state);
  }
  notify();
}

/** Its Claude stopped: Remote Control ended with it. */
export function remoteControlEnded(sessionId: string): void {
  if (!states.has(sessionId)) {
    return;
  }
  states.delete(sessionId);
  notify();
}

/** True while the phone can reach this session, or is about to. */
export function remoteControlActive(sessionId: string): boolean {
  const status = remoteControlState(sessionId).status;
  return status === "on" || status === "starting" || status === "stopping";
}

/** The phone link of a session with Remote Control on, if Claude gave one. */
export function remoteControlUrl(sessionId: string): string | undefined {
  const state = remoteControlState(sessionId);
  return state.status === "on" || state.status === "stopping"
    ? state.url
    : undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRemoteControl(sessionId: string): RemoteControlState {
  return useSyncExternalStore(subscribe, () => remoteControlState(sessionId));
}

/** Test seam. */
export function __resetRemoteControlStore(): void {
  wanted = null;
  refused = null;
  states.clear();
  notify();
}
