import { useEffect, useSyncExternalStore } from "react";
import { CornerDownRight, X } from "../../shared/ui/icons";
import { HANDOFF_FILE, handoffAge } from "./handoffModel";
import {
  continueFromHandoff,
  dismissHandoff,
  handoffFor,
  handoffsVersion,
  subscribeHandoffs,
  watchHandoff,
} from "./handoffStore";

function useHandoff(cwd: string) {
  useSyncExternalStore(subscribeHandoffs, handoffsVersion, handoffsVersion);
  useEffect(() => watchHandoff(cwd), [cwd]);
  return handoffFor(cwd);
}

/**
 * Fork: a card above the project's sessions when it has a handoff. Continue
 * opens a new session with "read the handoff and continue" in the composer,
 * so the model and mode can still be picked before sending.
 */
export function HandoffCard({ cwd }: { cwd: string }) {
  const handoff = useHandoff(cwd);
  if (!handoff) {
    return null;
  }
  const age = handoffAge(handoff.mtimeMs, Date.now());
  return (
    <div
      data-fork-handoff-card=""
      className="mx-2 mt-2 flex shrink-0 flex-col gap-1 rounded-md border border-stroke bg-content/[0.03] px-2.5 py-2 text-[12px]"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <CornerDownRight
          className="size-3 shrink-0 text-accent"
          strokeWidth={2}
          aria-hidden
        />
        <span className="shrink-0 font-semibold text-content">Handoff</span>
        <span className="min-w-0 truncate text-content/45" title={handoff.path}>
          {age}
        </span>
        <button
          type="button"
          aria-label="Hide this handoff"
          title="Hide until the handoff changes"
          onClick={() => dismissHandoff(handoff)}
          className="ml-auto grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      {handoff.heading ? (
        <p className="line-clamp-2 font-medium leading-snug text-content/85">
          {handoff.heading}
        </p>
      ) : null}
      {handoff.line ? (
        <p className="line-clamp-2 leading-snug text-content/55">
          {handoff.line}
        </p>
      ) : null}
      <button
        type="button"
        data-fork-handoff-continue=""
        title={`New session: read ${HANDOFF_FILE} and continue`}
        onClick={() => {
          // Started: hide it until a session writes a newer handoff.
          if (continueFromHandoff(cwd)) {
            dismissHandoff(handoff);
          }
        }}
        className="mt-0.5 self-start rounded-md bg-accent/15 px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent/25"
      >
        Continue
      </button>
    </div>
  );
}

/** Fork: a small mark on a project's rail row while it has a handoff. */
export function HandoffTag({ path }: { path: string }) {
  const handoff = useHandoff(path);
  if (!handoff) {
    return null;
  }
  const label = `Handoff ${handoffAge(handoff.mtimeMs, Date.now())}${
    handoff.heading ? `: ${handoff.heading}` : ""
  }`;
  return (
    <span
      role="img"
      data-fork-handoff-tag=""
      aria-label={label}
      title={label}
      className="grid size-4 shrink-0 place-items-center text-accent"
    >
      <CornerDownRight className="size-3" strokeWidth={2} aria-hidden />
    </span>
  );
}
