import { useHandoff } from "../handoff/HandoffCard";
import { handoffAge } from "../handoff/handoffModel";
import { useProjectAgentStatus } from "./ProjectAgentStatus";

/**
 * Fork: the new (inset) layout swaps the project rail for small spaces at the
 * foot of the sidebar, too small for the rail's badges. Each space gets corner
 * marks instead: the amber count of agents waiting on you, or a green dot when
 * all are done (top right), and an accent dot when the project has a handoff
 * (bottom right). Needs a `ProjectAgentStatusProvider` above it.
 */
export function ProjectSpaceMarks({ path }: { path: string }) {
  const status = useProjectAgentStatus(path);
  const handoff = useHandoff(path);
  const allDone = status.done > 0 && status.working === 0;
  return (
    <>
      {status.waiting > 0 ? (
        <span
          data-fork-space-status="waiting"
          title={
            status.waiting === 1
              ? "Agent needs you"
              : `${status.waiting} agents need you`
          }
          className="absolute -right-0.5 -top-1 z-10 grid h-3 min-w-3 place-items-center rounded-full bg-amber-400 px-0.5 text-[8px] font-bold tabular-nums leading-none text-black"
        >
          {status.waiting}
        </span>
      ) : allDone ? (
        <span
          data-fork-space-status="done"
          title={
            status.done === 1 ? "Agent done" : `${status.done} agents done`
          }
          className="absolute right-1 top-0.5 z-10 size-1.5 rounded-full bg-emerald-400"
        />
      ) : null}
      {handoff ? (
        <span
          data-fork-space-handoff=""
          title={`Handoff ${handoffAge(handoff.mtimeMs, Date.now())}${
            handoff.heading ? `: ${handoff.heading}` : ""
          }`}
          className="absolute bottom-0.5 right-1 size-1.5 rounded-full bg-accent"
        />
      ) : null}
    </>
  );
}

/** Words for a space's accessible name, matching its marks. */
export function useProjectSpaceMarksLabel(path: string): string {
  const status = useProjectAgentStatus(path);
  const handoff = useHandoff(path);
  const parts: string[] = [];
  if (status.waiting > 0) {
    parts.push(
      status.waiting === 1
        ? "agent needs you"
        : `${status.waiting} agents need you`,
    );
  } else if (status.done > 0 && status.working === 0) {
    parts.push(status.done === 1 ? "agent done" : `${status.done} agents done`);
  }
  if (handoff) {
    parts.push("has a handoff");
  }
  return parts.join(", ");
}
