import { useContext, useEffect, useState } from "react";
import { subscribeReviewChanged } from "../../features/sessions/model/checkpoint";
import { ToolDetailSession } from "../../features/sessions/ui/useToolDetail";
import { formatInteger } from "../../shared/lib/numbers";
import {
  cachedTurnChanges,
  loadTurnChanges,
  rememberTurnChanges,
  type TurnChanges,
} from "./turnDiff";
import { TurnDiffDialog } from "./TurnDiffDialog";

/** The chip's look, shared with the browser fixture. */
export function TurnChipButton({
  changes,
  onOpen,
}: {
  changes: TurnChanges;
  onOpen: () => void;
}) {
  const count = changes.files.length;
  return (
    <button
      type="button"
      data-fork-turn-chip
      onClick={onOpen}
      aria-label={`Show this turn's changes: ${count} ${count === 1 ? "file" : "files"}, ${changes.additions} added, ${changes.deletions} removed`}
      className="mt-1.5 inline-flex h-6 w-fit items-center gap-1.5 rounded-md bg-content/[0.06] px-2 font-sans text-[12px] text-content/65 transition-[background-color,color,transform] duration-150 hover:bg-content/10 hover:text-content active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <span>
        {count} {count === 1 ? "file" : "files"}
      </span>
      <span className="font-medium tabular-nums text-diff-add-fg">
        +{formatInteger(changes.additions)}
      </span>
      <span className="font-medium tabular-nums text-diff-del-fg">
        -{formatInteger(changes.deletions)}
      </span>
    </button>
  );
}

/** Fork: "3 files +42 -7" under a turn. Clicking opens that turn's diff. */
export function TurnChangeChip({
  turnId,
  busy,
}: {
  turnId: string;
  busy: boolean;
}) {
  // Unset in remote sessions, whose checkpoints live on the other machine.
  const sessionId = useContext(ToolDetailSession);
  const [changes, setChanges] = useState(() => cachedTurnChanges(turnId));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!sessionId || cachedTurnChanges(turnId)) return;
    let live = true;
    const read = () => {
      loadTurnChanges(sessionId, turnId)
        .then((next) => {
          rememberTurnChanges(turnId, next);
          if (live) setChanges(next);
        })
        // Not finished recording yet; the review event below tries again.
        .catch(() => undefined);
    };
    read();
    const unsubscribe = subscribeReviewChanged((changed) => {
      if (!changed || changed === sessionId) read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId, turnId]);

  if (!sessionId || !changes || changes.files.length === 0) return null;
  return (
    <>
      <TurnChipButton changes={changes} onOpen={() => setOpen(true)} />
      {open ? (
        <TurnDiffDialog
          sessionId={sessionId}
          turnId={turnId}
          changes={changes}
          busy={busy}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
