import { useSyncExternalStore } from "react";
import type {
  AgentStep,
  Block,
  Session,
} from "../../features/sessions/model/session";
import {
  isFailedStatus,
  isSubagentBlock,
  toolCallState,
} from "../../features/sessions/model/transcriptActivity";

/**
 * Fork feature: what the parallel agents board draws. Runs and steps carry no
 * timestamps, so the board times them itself from when App first publishes
 * them. That lives in memory only: after a reload a session is not busy, so
 * there is no board left to draw.
 */

type BoardSession = Pick<Session, "busy" | "blocks" | "queuedMessages">;

export type BoardTurn = {
  /** Every agent of the current turn, in spawn order, finished ones included. */
  agents: Block[];
  /** Background commands still running. */
  commands: Block[];
};

const NO_TURN: BoardTurn = { agents: [], commands: [] };

/**
 * The blocks of the turn in progress, oldest first. A message steered or queued
 * into the running turn does not start a new one: the work spawned before it is
 * still running.
 */
export function currentTurnBlocks(session: BoardSession): Block[] {
  const queued = new Set(
    session.queuedMessages?.map((message) => message.blockId) ?? [],
  );
  let first = 0;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (
      block.role === "user" &&
      !block.draft &&
      !block.sentAt &&
      !queued.has(block.id)
    ) {
      first = i + 1;
      break;
    }
  }
  return session.blocks.slice(first);
}

export function boardTurn(session: BoardSession): BoardTurn {
  if (!session.busy) {
    return NO_TURN;
  }
  const agents: Block[] = [];
  const commands: Block[] = [];
  for (const block of currentTurnBlocks(session)) {
    if (isSubagentBlock(block)) {
      agents.push(block);
    } else if (block.tool?.background && toolCallState(block) === "pending") {
      commands.push(block);
    }
  }
  return agents.length || commands.length ? { agents, commands } : NO_TURN;
}

/** Two or more agents stay up once done, so a report being read does not go. */
export function boardVisible(turn: BoardTurn): boolean {
  return (
    turn.agents.length >= 2 ||
    turn.commands.length > 0 ||
    turn.agents.some((block) => toolCallState(block) === "pending")
  );
}

export type BoardCounts = { done: number; failed: number; running: number };

export function boardCounts(agents: readonly Block[]): BoardCounts {
  let failed = 0;
  let running = 0;
  for (const block of agents) {
    const state = toolCallState(block);
    if (state === "rejected") {
      failed += 1;
    } else if (state === "pending") {
      running += 1;
    }
  }
  return { done: agents.length - running, failed, running };
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** "3 of 5 agents done", or for one agent the tray's "1 agent running". */
export function boardLabel(turn: BoardTurn): string {
  const commands = turn.commands.length;
  const parts: string[] = [];
  if (turn.agents.length >= 2) {
    const { done } = boardCounts(turn.agents);
    parts.push(`${done} of ${turn.agents.length} agents done`);
    if (commands) {
      parts.push(`${plural(commands, "command")} running`);
    }
    return parts.join(", ");
  }
  const running = boardCounts(turn.agents).running;
  if (running) {
    parts.push(plural(running, "agent"));
  }
  if (commands) {
    parts.push(plural(commands, "command"));
  }
  return parts.length ? `${parts.join(", ")} running` : "";
}

export type Interval = { start: number; end: number | null };

/**
 * Whether any two runs were going at once. Strict, so one ending exactly as the
 * next starts is sequential. A run with no end is still going.
 */
export function runsOverlap(runs: readonly Interval[]): boolean {
  const sorted = [...runs].sort((a, b) => a.start - b.start);
  let latestEnd = Number.NEGATIVE_INFINITY;
  for (const run of sorted) {
    if (run.start < latestEnd) {
      return true;
    }
    latestEnd = Math.max(latestEnd, run.end ?? Number.POSITIVE_INFINITY);
  }
  return false;
}

/** The newest step's text on one line; the caller says what an empty run is. */
export function agentNowText(steps: readonly AgentStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const text = steps[i].text.replace(/\s+/g, " ").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function toolStepCount(steps: readonly AgentStep[]): number {
  return steps.filter((step) => step.kind === "tool").length;
}

/** The left cell's second line. */
export function agentStatusText(block: Block): string {
  const state = toolCallState(block);
  if (state === "rejected") {
    return "Failed";
  }
  const steps = block.agentRun?.steps ?? [];
  if (state === "pending") {
    return agentNowText(steps) || "Starting…";
  }
  const tools = toolStepCount(steps);
  return tools ? `Done · ${plural(tools, "step")}` : "Done";
}

export type Axis = { start: number; end: number };

/** One clock for every lane: the earliest start to the latest end, or now. */
export function boardAxis(runs: readonly Interval[], now: number): Axis {
  if (!runs.length) {
    return { start: now, end: now };
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    start = Math.min(start, run.start);
    end = Math.max(end, run.end ?? now);
  }
  return { start, end };
}

/** Where a moment sits on the axis, 0 to 100. */
export function axisPercent(axis: Axis, at: number): number {
  const span = axis.end - axis.start;
  if (span <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, ((at - axis.start) / span) * 100));
}

export const QUIET_AFTER_MS = 2 * 60_000;

/** How long a running agent has gone without a new step, once that is notable. */
export function quietForMs(timing: RunTiming, now: number): number | null {
  if (timing.end !== null) {
    return null;
  }
  const quiet = now - (timing.lastStepAt ?? timing.start);
  return quiet >= QUIET_AFTER_MS ? quiet : null;
}

/** "No new step for 3m". Quiet, not stuck: a long Bash call is silent too. */
export function quietLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `No new step for ${minutes}m`;
  }
  return `No new step for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function isFailedStep(step: AgentStep): boolean {
  return isFailedStatus(step.status);
}

// --- Store: when each run and step was first seen ----------------------------

export type RunTiming = Interval & {
  lastStepAt: number | null;
  /** Step id to when it was first seen. */
  steps: ReadonlyMap<string, number>;
};

type Entry = RunTiming & {
  steps: Map<string, number>;
  /** The array last read, so a stream of unrelated updates skips the walk. */
  seenSteps?: readonly AgentStep[];
};

const timings = new Map<string, Entry>();
let version = 0;
const listeners = new Set<() => void>();

/** Returns whether anything a lane draws has changed. */
function recordRun(block: Block, now: number, live: Set<string>): boolean {
  live.add(block.id);
  let changed = false;
  let entry = timings.get(block.id);
  if (!entry) {
    entry = { start: now, end: null, lastStepAt: null, steps: new Map() };
    timings.set(block.id, entry);
    changed = true;
  }
  const ended = toolCallState(block) !== "pending";
  if (ended && entry.end === null) {
    entry.end = now;
    changed = true;
  } else if (!ended && entry.end !== null) {
    // A run a retry brought back is running again.
    entry.end = null;
    changed = true;
  }
  const steps = block.agentRun?.steps;
  if (steps && steps !== entry.seenSteps) {
    entry.seenSteps = steps;
    const current = new Set<string>();
    for (const step of steps) {
      current.add(step.id);
      if (!entry.steps.has(step.id)) {
        entry.steps.set(step.id, now);
        entry.lastStepAt = now;
        changed = true;
      }
    }
    // The trail is capped, so the steps that fall off it go from here too.
    for (const id of entry.steps.keys()) {
      if (!current.has(id)) {
        entry.steps.delete(id);
        changed = true;
      }
    }
  }
  return changed;
}

/** Fed from `publishRunningWork`. Listeners only hear real changes. */
export function recordBoardTimings(
  sessions: readonly BoardSession[],
  now: number = Date.now(),
): void {
  const live = new Set<string>();
  let changed = false;
  for (const session of sessions) {
    const turn = boardTurn(session);
    for (const block of turn.agents) {
      changed = recordRun(block, now, live) || changed;
    }
    for (const block of turn.commands) {
      changed = recordRun(block, now, live) || changed;
    }
  }
  // Anything no longer on a live board goes, so this cannot grow without end.
  for (const id of timings.keys()) {
    if (!live.has(id)) {
      timings.delete(id);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function runTiming(blockId: string): RunTiming | undefined {
  return timings.get(blockId);
}

export function trackedRunCount(): number {
  return timings.size;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return version;
}

/**
 * Re-renders on a timing change. Apart from the sidebar's listeners on purpose,
 * or every new step would re-render every badge. Needed at all because App
 * publishes in an effect, after the bar's first render.
 */
export function useBoardTimings(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
