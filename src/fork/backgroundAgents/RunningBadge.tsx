import { Bot } from "../../shared/ui/icons";
import { runningCount, runningLabel, useRunningWork } from "./runningAgents";

/** Fork: a session card's count of subagents and background commands running. */
export function RunningBadge({ sessionId }: { sessionId: string }) {
  const work = useRunningWork(sessionId);
  const count = runningCount(work);
  if (!count) {
    return null;
  }
  const label = runningLabel(work);
  return (
    <span
      data-fork-running-badge
      title={label}
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded bg-accent/12 px-1 py-px text-[10px] font-semibold tabular-nums leading-4 text-accent"
    >
      <Bot className="size-2.5" strokeWidth={2} aria-hidden="true" />
      {count}
    </span>
  );
}
