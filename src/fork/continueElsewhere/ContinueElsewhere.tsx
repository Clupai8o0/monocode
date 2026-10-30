import { useState } from "react";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import {
  HARNESS_TITLE,
  type HarnessId,
} from "../../features/sessions/model/session";
import { ChevronRight, Replace, X } from "../../shared/ui/icons";
import {
  continuedOrigin,
  continueHost,
  continueLabel,
  continueTarget,
  type ContinuedOrigin,
} from "./continueElsewhere";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** Fork: on the usage-limit bar, the way out when this provider is spent. */
export function ContinueElsewhereButton({
  sessionId,
  harness,
}: {
  sessionId: string;
  harness: HarnessId;
}) {
  const label = continueLabel(harness);
  const target = continueTarget(harness);
  if (!label || !target) return null;
  return (
    <button
      type="button"
      data-fork-continue-elsewhere
      onClick={() => continueHost()?.continueSession(sessionId)}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-content/10 px-2 font-sans text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
    >
      <HarnessIcon harness={target} className="size-3.5 shrink-0" />
      {label}
    </button>
  );
}

/** The card's look, separate so the fixture can show it. */
export function ContinuedFromView({
  origin,
  onOpen,
  onDismiss,
}: {
  origin: ContinuedOrigin;
  onOpen?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-3 pt-2.5">
      <div
        data-fork-continued-from
        className="pointer-events-auto flex w-full max-w-[720px] min-w-0 items-center gap-3 modal-surface rounded-xl bg-background-base px-3 py-2 font-sans shadow-[0_8px_24px_-12px_rgb(0_0_0/0.55)]"
      >
        <span className="flex shrink-0 items-center gap-1">
          <HarnessIcon harness={origin.from} className="size-4" />
          <ChevronRight className="size-3 text-content/35" strokeWidth={2} aria-hidden />
          <HarnessIcon harness={origin.to} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-content" title={origin.title}>
            {origin.title}
          </p>
          <p className="truncate text-[11px] text-content/50">
            Continued from {HARNESS_TITLE[origin.from]}
            {origin.files > 0
              ? `, with ${origin.files} changed ${origin.files === 1 ? "file" : "files"}`
              : ""}
          </p>
        </div>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content ${PRESS}`}
          >
            <Replace className="size-3.5" strokeWidth={1.75} aria-hidden />
            Open original
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className={`grid size-6 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/8 hover:text-content ${PRESS}`}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Fork: at the top of a session handed over from another. */
export function ContinuedFromCard({ sessionId }: { sessionId: string }) {
  const [origin] = useState(() => continuedOrigin(sessionId));
  const [dismissed, setDismissed] = useState(false);
  if (!origin || dismissed) return null;
  return (
    <ContinuedFromView
      origin={origin}
      onOpen={() => continueHost()?.openSession(origin.sessionId)}
      onDismiss={() => setDismissed(true)}
    />
  );
}
