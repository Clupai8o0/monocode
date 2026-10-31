import { useState } from "react";
import { ExternalSessionViewer } from "../externalSessions/ExternalSessionViewer";
import type { ExternalSession } from "../externalSessions/externalSessionsModel";
import { ChevronRight, X } from "../../shared/ui/icons";
import { leftBehindText, movedTitle, type MovedRecord } from "./sessionMoveModel";
import { labKey, labMoveAvailability, moveHost, moveLabToMac, useMovedRecord, useMoveView } from "./sessionMoveStore";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** On a sidebar row: this tab has ended, the session runs elsewhere. */
export function MovedTag({ sessionId }: { sessionId: string }) {
  const record = useMovedRecord(sessionId);
  if (!record) return null;
  return (
    <span data-fork-moved-tag="" className="shrink-0 text-[11px] font-normal text-content/45">
      Moved
    </span>
  );
}

/** The line in the session while it moves, or why it did not. */
export function MoveLineView({
  text,
  failure,
  onCancel,
  onDismiss,
  onRetry,
}: {
  text?: string;
  failure?: string;
  onCancel?: () => void;
  onDismiss?: () => void;
  /** A move that stayed stopped: undo it again now. */
  onRetry?: () => void;
}) {
  if (!text && !failure) return null;
  return (
    <div
      data-fork-move-line=""
      role="status"
      className="mx-auto flex w-full max-w-[720px] min-w-0 items-center gap-2 px-3 py-1 font-sans text-[12px]"
    >
      {text ? (
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      ) : null}
      <span className={`min-w-0 flex-1 truncate ${text ? "text-content/70" : "text-content/80"}`} title={text ?? failure}>
        {text ?? `Did not move. ${failure}`}
      </span>
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className={`shrink-0 rounded-md px-1.5 py-0.5 font-medium text-content/70 hover:bg-content/8 hover:text-content ${PRESS}`}
        >
          Cancel
        </button>
      ) : null}
      {!text && onRetry ? (
        <button
          type="button"
          data-fork-move-retry=""
          onClick={onRetry}
          className={`shrink-0 rounded-md px-1.5 py-0.5 font-medium text-content/70 hover:bg-content/8 hover:text-content ${PRESS}`}
        >
          Try again
        </button>
      ) : null}
      {!text && onDismiss && !onRetry ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className={`shrink-0 rounded-md p-0.5 text-content/50 hover:bg-content/8 hover:text-content ${PRESS}`}
        >
          <X className="size-3" strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function MoveLine({ sessionId }: { sessionId: string }) {
  const { view, failure, clearFailure, retry } = useMoveView(sessionId);
  return (
    <MoveLineView
      text={view?.text}
      failure={failure}
      onCancel={view?.cancel}
      onDismiss={clearFailure}
      onRetry={retry}
    />
  );
}

/** What a moved tab shows where its composer was. */
export function MovedCardView({ record, onOpen }: { record: MovedRecord; onOpen: () => void }) {
  const left = leftBehindText(record);
  return (
    <div className="mx-auto w-full max-w-[720px] px-3 pb-3 font-sans">
      <div
        data-fork-moved-card=""
        className="flex min-w-0 items-center gap-3 rounded-xl bg-content/6 px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-content">{movedTitle(record)}</p>
          <p className="truncate text-[11px] text-content/55" title={record.branch}>
            It carries on there, on {record.branch}. This copy is read-only.
          </p>
          {left ? (
            <p className="mt-0.5 truncate text-[11px] text-content/55" title={left}>
              {left}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onOpen}
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/25 ${PRESS}`}
        >
          Open live session
          <ChevronRight className="size-3.5" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function liveRow(record: MovedRecord): ExternalSession | null {
  if (record.live.kind !== "host") return null;
  return {
    id: record.providerSessionId,
    projectId: "",
    source: record.live.source,
    name: record.live.name,
    cwd: record.live.cwd,
    branch: record.branch,
    state: "running",
    hasTranscript: true,
  };
}

export function MovedCard({ sessionId }: { sessionId: string }) {
  const record = useMovedRecord(sessionId);
  const [viewing, setViewing] = useState(false);
  if (!record) return null;
  const row = liveRow(record);
  return (
    <>
      <MovedCardView
        record={record}
        onOpen={() => {
          if (record.live.kind === "tab") {
            moveHost()?.openSession(record.live.sessionId);
          } else {
            setViewing(true);
          }
        }}
      />
      {viewing && row && record.live.kind === "host" ? (
        <ExternalSessionViewer
          target={{ kind: "remote", machineId: record.live.machineId, projectId: "" }}
          session={row}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </>
  );
}

/** In a lab session's viewer: the item a tab has in its menu. */
export function MoveToMacButton({
  session,
  machineId,
}: {
  session: ExternalSession;
  machineId: string;
}) {
  const { view, failure, clearFailure, retry } = useMoveView(labKey(session.id));
  const availability = labMoveAvailability(session);
  if (!availability.show && !view && !failure) return null;
  return (
    <>
      {view || failure ? (
        <MoveLineView
          text={view?.text}
          failure={failure}
          onCancel={view?.cancel}
          onDismiss={clearFailure}
          onRetry={retry}
        />
      ) : null}
      {availability.show && !view ? (
        <button
          type="button"
          data-fork-move-to-mac=""
          disabled={Boolean(availability.disabled)}
          title={availability.disabled}
          onClick={() => moveLabToMac(session, machineId)}
          className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent/25 disabled:opacity-40"
        >
          Move to this Mac
        </button>
      ) : null}
    </>
  );
}
