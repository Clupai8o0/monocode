/**
 * Fork feature: who can move, the steps' words, and what is kept after a move.
 * No React and no app state: callers pass in what they read.
 */
import { isClientPath, SESSION_MOVE_CAPABILITY } from "./sessionMoveProtocol";

/** Off under the test runner, so upstream tests see no new menu item. */
export const FORK_SESSION_MOVE = import.meta.env.MODE !== "test";

/** Where a session is, or where it goes. */
export type MoveMachine =
  | { kind: "mac" }
  | { kind: "host"; machineId: string; name: string };

export function machineTitle(machine: MoveMachine): string {
  return machine.kind === "mac" ? "this Mac" : machine.name;
}

export type MoveFacts = {
  harness: string;
  /** Folder it works in; a `remote://` one is a tab on a host. */
  cwd: string;
  isMono: boolean;
  isOrchestration: boolean;
  worktreeRemoved?: boolean;
  /** No conversation yet: nothing to carry. */
  hasConversation: boolean;
  needsInput: boolean;
  moved: boolean;
  moving: boolean;
  target: {
    online: boolean;
    /** False until its describe has been read. */
    known: boolean;
    capabilities: readonly string[];
    name: string;
  };
};

export type MoveAvailability =
  | { show: false }
  | { show: true; disabled?: string };

const LOCAL_HARNESSES = new Set(["claude"]);

/** Hidden when it can never move; disabled, with why, when it could later. */
export function moveAvailability(facts: MoveFacts): MoveAvailability {
  if (
    facts.cwd.startsWith("remote://") ||
    !LOCAL_HARNESSES.has(facts.harness) ||
    facts.isMono ||
    facts.isOrchestration ||
    facts.worktreeRemoved ||
    facts.moved ||
    isClientPath(facts.cwd)
  ) {
    return { show: false };
  }
  if (facts.moving) {
    return { show: true, disabled: "Already moving" };
  }
  if (!facts.hasConversation) {
    return { show: true, disabled: "Nothing to move yet" };
  }
  if (!facts.target.online) {
    return { show: true, disabled: `${facts.target.name} is offline` };
  }
  if (facts.target.known && !facts.target.capabilities.includes(SESSION_MOVE_CAPABILITY)) {
    return { show: true, disabled: `Update ${facts.target.name} to move sessions` };
  }
  if (facts.needsInput) {
    return { show: true, disabled: "It is waiting for your answer" };
  }
  return { show: true };
}

export type MoveStep =
  | "check"
  | "wait"
  | "stop"
  | "code"
  | "conversation"
  | "start"
  | "confirm"
  | "finish";

export const CANCELLABLE: ReadonlySet<MoveStep> = new Set(["check", "wait"]);

export function stepText(step: MoveStep, target: string, detail?: { queued?: boolean; percent?: number }): string {
  switch (step) {
    case "check":
      return `Checking ${target}`;
    case "wait":
      return "Moves when this turn ends";
    case "stop":
      return "Stopping the session here";
    case "code": {
      const percent = detail?.percent;
      return percent === undefined
        ? `Carrying the code to ${target}`
        : `Carrying the code and conversation to ${target}, ${percent}%`;
    }
    case "conversation":
      return `Carrying the conversation to ${target}`;
    case "start":
      return `Starting it on ${target}`;
    case "confirm":
      return detail?.queued
        ? `${target} is full, so it is waiting in line`
        : `Waiting for it to come up on ${target}`;
    case "finish":
      return "Finishing";
  }
}

/** What a tab keeps after moving. */
export type MovedRecord = {
  /** The MonoCode session whose tab this is. */
  sessionId: string;
  providerSessionId: string;
  toName: string;
  at: number;
  /** The live session: a machine's lab session, or a tab on this Mac. */
  live:
    | { kind: "host"; machineId: string; name: string; cwd: string; source: string }
    | { kind: "tab"; sessionId: string };
  cwd: string;
  branch: string;
  /** Ignored files that stayed behind, names only. */
  leftBehind: string[];
  leftBehindMore: number;
};

const MOVED_KEY = "monocode.fork.movedSessions";
const MAX_MOVED = 500;

export type MovedMap = Record<string, MovedRecord>;

export function parseMoved(text: string | null): MovedMap {
  try {
    const parsed = JSON.parse(text ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: MovedMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, MovedRecord>)) {
      if (value && typeof value.providerSessionId === "string" && value.live) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Adds a record, and points older cards for this conversation at where it is now. */
export function withMoved(map: MovedMap, record: MovedRecord): MovedMap {
  const entries = Object.entries(map)
    .filter(([id]) => id !== record.sessionId)
    .map(([id, value]): [string, MovedRecord] =>
      value.providerSessionId === record.providerSessionId
        ? [id, { ...value, live: record.live, toName: record.toName, at: record.at }]
        : [id, value],
    );
  entries.push([record.sessionId, record]);
  return Object.fromEntries(entries.slice(-MAX_MOVED));
}

/** The record's time as "10:42". */
export function movedTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function movedTitle(record: Pick<MovedRecord, "toName" | "at">): string {
  return `Moved to ${record.toName} at ${movedTime(record.at)}`;
}

export function leftBehindText(record: Pick<MovedRecord, "leftBehind" | "leftBehindMore">): string | null {
  if (record.leftBehind.length === 0) return null;
  const more = record.leftBehindMore > 0 ? `, and ${record.leftBehindMore} more` : "";
  return `Left behind: ${record.leftBehind.join(", ")}${more}`;
}

export const MOVED_STORAGE_KEY = MOVED_KEY;
