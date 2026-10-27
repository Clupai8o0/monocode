import { useState } from "react";
import { Bot, ChevronRight, Terminal } from "../../shared/ui/icons";
import { Shimmer } from "../../shared/ui/Shimmer";
import type { Session } from "../../features/sessions/model/session";
import { SubagentRow } from "../../features/sessions/ui/AgentTranscript";
import { runningCount, runningLabel, runningWork } from "./runningAgents";

/**
 * Fork: a line above the composer while the session has subagents or
 * background commands running, like Claude Code's task tray. Opening it
 * lists each one; an agent's row opens onto its live trail.
 */
export function BackgroundAgentsBar({
  session,
  cwd,
  onOpenFile,
  onOpenDiff,
}: {
  session: Pick<Session, "busy" | "blocks" | "queuedMessages">;
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const work = runningWork(session);
  if (!runningCount(work)) {
    return null;
  }
  const label = runningLabel(work);
  return (
    <div data-fork-background-agents className="mb-1.5 flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Hide ${label}` : `Show ${label}`}
        onClick={() => setOpen(!open)}
        className={`group flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left font-sans text-[12px] text-content/60 transition-colors duration-200 hover:bg-content/8 hover:text-content ${
          open ? "bg-content/8 text-content" : ""
        }`}
      >
        <Bot
          className="size-3.5 shrink-0"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <Shimmer className="min-w-0 truncate" duration={1.6}>
          {label}
        </Shimmer>
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="mt-1 flex max-h-[40vh] min-w-0 flex-col gap-0.5 overflow-y-auto rounded-lg bg-content/[0.04] px-3 py-2">
          {work.agents.map((block) => (
            <SubagentRow
              key={block.id}
              block={block}
              cwd={cwd}
              live
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
          {work.commands.map((block) => {
            const title = block.tool?.title || block.text || "Command";
            return (
              <div
                key={block.id}
                title={title}
                className="flex min-w-0 items-center gap-2 py-1"
              >
                <Terminal
                  className="size-3.5 shrink-0 text-content/45"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-content/70">
                  {title}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
