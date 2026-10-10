import { createContext, useContext, type ReactNode } from "react";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import { sameProjectPath } from "../../features/projects/model/recents";
import { Check } from "../../shared/ui/icons";

/**
 * Fork feature: on each project row, show whether its agents need you or are
 * done. Working is already shown upstream (animated mascot, shimmering name);
 * this adds the other two states so a glance at the rail says which streams of
 * work are finished. "Done" clears once you open the chat, as upstream's
 * unseen-finished tracking does.
 */

export type ProjectAgentStatus = {
  working: number;
  waiting: number;
  done: number;
};

export function projectAgentStatus(
  agents: readonly Pick<LiveAgent, "cwd" | "done" | "needsApproval">[],
  path: string,
): ProjectAgentStatus {
  const status = { working: 0, waiting: 0, done: 0 };
  for (const agent of agents) {
    if (!agent.cwd || !sameProjectPath(agent.cwd, path)) continue;
    if (agent.needsApproval) status.waiting++;
    else if (agent.done) status.done++;
    else status.working++;
  }
  return status;
}

const AgentsContext = createContext<readonly LiveAgent[]>([]);

export function ProjectAgentStatusProvider({
  agents,
  children,
}: {
  agents: readonly LiveAgent[];
  children: ReactNode;
}) {
  return <AgentsContext.Provider value={agents}>{children}</AgentsContext.Provider>;
}

/** Amber pulse when an agent is waiting on you; a green tick when all are done. */
export function ProjectAgentBadge({ path }: { path: string }) {
  const agents = useContext(AgentsContext);
  const status = projectAgentStatus(agents, path);
  if (status.waiting > 0) {
    const label =
      status.waiting === 1 ? "Agent needs you" : `${status.waiting} agents need you`;
    return (
      <span
        role="img"
        data-fork-agent-status="waiting"
        aria-label={label}
        title={label}
        className="relative grid size-4 shrink-0 place-items-center"
      >
        <span className="absolute size-2 animate-ping rounded-full bg-amber-400/60 motion-reduce:animate-none" />
        <span className="relative size-1.5 rounded-full bg-amber-400" />
      </span>
    );
  }
  // While something is still working, upstream's animation already says so.
  if (status.done > 0 && status.working === 0) {
    const label = status.done === 1 ? "Agent done" : `${status.done} agents done`;
    return (
      <span
        role="img"
        data-fork-agent-status="done"
        aria-label={label}
        title={label}
        className="grid size-4 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-emerald-300"
      >
        <Check className="size-2.5" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  return null;
}
