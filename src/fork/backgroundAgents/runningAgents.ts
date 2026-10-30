import { useSyncExternalStore } from "react";
import {
  hasPendingApproval,
  type Block,
  type Session,
} from "../../features/sessions/model/session";
import {
  isSubagentBlock,
  toolCallState,
} from "../../features/sessions/model/transcriptActivity";

/**
 * Fork feature: what a session has running beside its own reply. Subagents it
 * spawned and commands it left running in the background, as Claude Code's
 * task tray shows them. Read from the current turn only, and only while the
 * session is busy: a row a cancelled turn left "pending" is not running.
 */

export type RunningWork = {
  agents: Block[];
  commands: Block[];
};

const NONE: RunningWork = { agents: [], commands: [] };

export function runningWork(
  session: Pick<Session, "busy" | "blocks" | "queuedMessages">,
): RunningWork {
  if (!session.busy) {
    return NONE;
  }
  const queued = new Set(
    session.queuedMessages?.map((message) => message.blockId) ?? [],
  );
  const agents: Block[] = [];
  const commands: Block[] = [];
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    // A message steered or queued into the running turn does not start a new
    // one: the work spawned before it is still running.
    if (
      block.role === "user" &&
      !block.draft &&
      !block.sentAt &&
      !queued.has(block.id)
    ) {
      break;
    }
    if (toolCallState(block) !== "pending") {
      continue;
    }
    if (isSubagentBlock(block)) {
      agents.unshift(block);
    } else if (block.tool?.background) {
      commands.unshift(block);
    }
  }
  return agents.length || commands.length ? { agents, commands } : NONE;
}

export function runningCount(work: RunningWork): number {
  return work.agents.length + work.commands.length;
}

/** "2 agents, 1 command running" */
export function runningLabel(work: RunningWork): string {
  const parts: string[] = [];
  const a = work.agents.length;
  const c = work.commands.length;
  if (a) {
    parts.push(`${a} ${a === 1 ? "agent" : "agents"}`);
  }
  if (c) {
    parts.push(`${c} ${c === 1 ? "command" : "commands"}`);
  }
  return parts.length ? `${parts.join(", ")} running` : "";
}

// --- Store: counts per session, for the sidebar ------------------------------

let counts = new Map<string, RunningWork>();
let version = 0;
const listeners = new Set<() => void>();

function sameWork(a: RunningWork | undefined, b: RunningWork): boolean {
  return (
    !!a &&
    a.agents.length === b.agents.length &&
    a.commands.length === b.commands.length
  );
}

/** App calls this as sessions change; listeners only hear real changes. */
export function publishRunningWork(
  sessions: readonly Pick<
    Session,
    | "id"
    | "busy"
    | "blocks"
    | "queuedMessages"
    | "pendingQuestion"
    | "worktreeRemoved"
  >[],
): void {
  publishAgentActivity(sessions);
  const next = new Map<string, RunningWork>();
  for (const session of sessions) {
    const work = runningWork(session);
    if (runningCount(work)) {
      next.set(session.id, work);
    }
  }
  let changed = next.size !== counts.size;
  if (!changed) {
    for (const [id, work] of next) {
      if (!sameWork(counts.get(id), work)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) {
    return;
  }
  counts = next;
  version += 1;
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

function snapshot(): number {
  return version;
}

export function useRunningWork(sessionId: string): RunningWork {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return counts.get(sessionId) ?? NONE;
}

// --- Store: how many agents are at it, for the games panel -------------------

export type AgentActivity = {
  /** Sessions busy on their own. */
  working: number;
  /** Sessions stopped on an approval or a question. */
  waiting: number;
};

let activity: AgentActivity = { working: 0, waiting: 0 };
const activityListeners = new Set<() => void>();

export function agentActivity(
  sessions: readonly Pick<
    Session,
    "busy" | "blocks" | "pendingQuestion" | "worktreeRemoved"
  >[],
): AgentActivity {
  let working = 0;
  let waiting = 0;
  for (const session of sessions) {
    if (session.worktreeRemoved) {
      continue;
    }
    if (hasPendingApproval(session.blocks) || session.pendingQuestion != null) {
      waiting += 1;
    } else if (session.busy) {
      working += 1;
    }
  }
  return { working, waiting };
}

function publishAgentActivity(
  sessions: Parameters<typeof agentActivity>[0],
): void {
  const next = agentActivity(sessions);
  if (next.working === activity.working && next.waiting === activity.waiting) {
    return;
  }
  activity = next;
  for (const listener of activityListeners) {
    listener();
  }
}

function subscribeActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

function activitySnapshot(): AgentActivity {
  return activity;
}

export function useAgentActivity(): AgentActivity {
  return useSyncExternalStore(
    subscribeActivity,
    activitySnapshot,
    activitySnapshot,
  );
}
