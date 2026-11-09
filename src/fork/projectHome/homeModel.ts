/**
 * Fork feature: Project home. Turns the app's sessions into what the home
 * page shows: a project's chats with their state, the things that wait on
 * the user, and which chats belong to which roadmap phase.
 */
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import type { HarnessId, Session } from "../../features/sessions/model/session";
import { sameProjectPath } from "../../features/projects/model/recents";
import { checklistFromBlocks } from "../checklist/checklist";
import { phaseForTitle, type PlanPhase } from "./planModel";

export type ChatState = "waiting" | "working" | "unseen" | "idle";

export type HomeChat = {
  id: string;
  cwd: string;
  title: string;
  harness: HarnessId;
  updatedAt: number;
  state: ChatState;
  /** What the agent is doing now, while it runs or waits. */
  activity: string | null;
  /** The first line of the newest reply, for chats loaded this run. */
  last: string | null;
  phaseId: string | null;
};

export type NeedsKind = "Question" | "Approval" | "Your step";

export type NeedsItem = {
  key: string;
  sessionId: string;
  cwd: string;
  text: string;
  kind: NeedsKind;
  /** When it started waiting, as far as the app knows. */
  since: number;
  chatTitle: string;
  /** The chat is not running, so a reply wakes it. */
  chatIdle: boolean;
  phaseId: string | null;
};

const STATE_ORDER: Record<ChatState, number> = {
  waiting: 0,
  working: 1,
  unseen: 2,
  idle: 3,
};

/** A checklist step meant for an agent rather than the person. */
const AGENT_WHO = /\b(claude|codex|agent|bot|ai|grok|gemini|cursor|deepseek)\b/i;

function inScope(cwd: string, scope: string | null): boolean {
  return scope === null || sameProjectPath(cwd, scope);
}

function lastReply(session: Session | undefined): string | null {
  if (!session) {
    return null;
  }
  for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
    const block = session.blocks[i];
    if (block.role === "assistant" && block.text.trim()) {
      const line = block.text
        .split("\n")
        .map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
        .find((part) => part.length > 0);
      return line ? line.replace(/\*\*/g, "").slice(0, 220) : null;
    }
  }
  return null;
}

function turnStart(session: Session): number | null {
  for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
    const block = session.blocks[i];
    if (block.role === "user" && block.startedAt) {
      return block.startedAt;
    }
  }
  return null;
}

/** The phase a chat is on: the user's pick first, then its title. */
export function chatPhase(
  id: string,
  title: string,
  phases: readonly PlanPhase[],
  links: Readonly<Record<string, string>>,
): string | null {
  const linked = links[id];
  if (linked !== undefined) {
    // "" means the user took it off every phase.
    return phases.some((phase) => phase.id === linked) ? linked : null;
  }
  return phaseForTitle(title, phases as PlanPhase[])?.id ?? null;
}

/** The project's chats, newest and busiest first. */
export function homeChats(
  cwd: string,
  summaries: readonly SessionSummary[],
  sessions: readonly Session[],
  agents: readonly LiveAgent[],
  phases: readonly PlanPhase[],
  links: Readonly<Record<string, string>>,
): HomeChat[] {
  const live = new Map(sessions.map((session) => [session.id, session]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const rows = new Map<string, HomeChat>();
  const add = (
    id: string,
    chatCwd: string,
    title: string,
    harness: HarnessId,
    updatedAt: number,
  ) => {
    const agent = agentById.get(id);
    const state: ChatState = agent
      ? agent.needsApproval
        ? "waiting"
        : agent.done
          ? "unseen"
          : "working"
      : "idle";
    rows.set(id, {
      id,
      cwd: chatCwd,
      title: title.trim() || "New chat",
      harness,
      updatedAt,
      state,
      activity: agent && !agent.done ? agent.activity : null,
      last: lastReply(live.get(id)),
      phaseId: chatPhase(id, title, phases, links),
    });
  };
  for (const summary of summaries) {
    if (
      summary.archived ||
      summary.sidebarHidden ||
      summary.orchestrationLeadId ||
      !sameProjectPath(summary.cwd, cwd)
    ) {
      continue;
    }
    add(summary.id, summary.cwd, summary.title, summary.harness, summary.updatedAt);
  }
  for (const session of sessions) {
    if (
      rows.has(session.id) ||
      session.ephemeral ||
      session.orchestrationLeadId ||
      session.inboxAsk ||
      !sameProjectPath(session.cwd, cwd) ||
      (session.blocks.length === 0 && !agentById.has(session.id))
    ) {
      continue;
    }
    add(session.id, session.cwd, session.title, session.harness, turnStart(session) ?? 0);
  }
  return [...rows.values()].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updatedAt - a.updatedAt,
  );
}

/**
 * What waits on the user in `scope` (a project, or null for every project):
 * open questions and approvals, then checklist steps the chats gave them.
 * Oldest first.
 */
export function needsItems(
  scope: string | null,
  sessions: readonly Session[],
  agents: readonly LiveAgent[],
  updatedAt: ReadonlyMap<string, number>,
  phaseOf: (session: Session) => string | null,
  now: number = Date.now(),
): NeedsItem[] {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const items: NeedsItem[] = [];
  for (const session of sessions) {
    if (
      session.ephemeral ||
      session.orchestrationLeadId ||
      session.inboxAsk ||
      session.worktreeRemoved ||
      !inScope(session.cwd, scope)
    ) {
      continue;
    }
    const agent = agentById.get(session.id);
    const since = updatedAt.get(session.id) ?? turnStart(session) ?? now;
    const phaseId = phaseOf(session);
    const title = session.title.trim() || "New chat";
    const running = !!agent && !agent.done;
    if (agent?.needsApproval) {
      items.push({
        key: `${session.id}:ask`,
        sessionId: session.id,
        cwd: session.cwd,
        text: agent.activity || "Waiting for you",
        kind: session.pendingQuestion ? "Question" : "Approval",
        since,
        chatTitle: title,
        chatIdle: false,
        phaseId,
      });
    }
    const steps = checklistFromBlocks(session.blocks).items;
    steps.forEach((step, index) => {
      if (step.done || (step.who && AGENT_WHO.test(step.who))) {
        return;
      }
      items.push({
        key: `${session.id}:step:${index}`,
        sessionId: session.id,
        cwd: session.cwd,
        text: step.text,
        kind: "Your step",
        since,
        chatTitle: title,
        chatIdle: !running,
        phaseId,
      });
    });
  }
  return items.sort((a, b) => a.since - b.since);
}

/** A phase gets a full card while anything is happening on it. */
export function phaseIsActive(
  phase: PlanPhase,
  chats: readonly HomeChat[],
  needs: readonly NeedsItem[],
): boolean {
  if (needs.some((item) => item.phaseId === phase.id)) {
    return true;
  }
  if (phase.status === "done") {
    return false;
  }
  return (
    phase.status !== "todo" ||
    chats.some(
      (chat) =>
        chat.phaseId === phase.id &&
        (chat.state === "working" || chat.state === "waiting"),
    )
  );
}

/** "3m", "2h", "4d": how long something has waited. */
export function shortAge(since: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

export const DAY_MS = 86_400_000;
