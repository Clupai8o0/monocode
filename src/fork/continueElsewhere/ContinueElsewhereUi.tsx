import { useRef, useState } from "react";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import {
  HARNESS_TITLE,
  type HarnessId,
} from "../../features/sessions/model/session";
import { ChevronDown, ChevronRight, Replace, X } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import {
  continuedOrigin,
  continueHost,
  continueLabelFor,
  handoffTargets,
  type ContinuedOrigin,
} from "./continueElsewhere";
import {
  GROK_BOT_MENU_LABEL,
  grokBotHost,
  useGrokBotStatusVersion,
} from "../grokBot/grokBot";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const BUTTON =
  `inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-content/10 px-2 font-sans text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`;

function resolveTargets(sessionId: string, harness: HarnessId): HarnessId[] {
  const live = continueHost()?.targetsFor?.(sessionId);
  return live && live.length > 0 ? live : handoffTargets(harness);
}

/** Fork: on the usage-limit bar, the way out when this provider is spent. */
export function ContinueElsewhereButton({
  sessionId,
  harness,
  cwd: _cwd,
}: {
  sessionId: string;
  harness: HarnessId;
  /** Kept for call-site compatibility; live targets come from the continue host. */
  cwd?: string;
}) {
  useGrokBotStatusVersion();
  const targets = resolveTargets(sessionId, harness);
  const grokBot = Boolean(grokBotHost()?.canHandOver(sessionId));
  if (targets.length === 0 && !grokBot) return null;
  if (targets.length === 1 && !grokBot) {
    const target = targets[0]!;
    return (
      <button
        type="button"
        data-fork-continue-elsewhere
        onClick={() => continueHost()?.continueSession(sessionId, target)}
        className={BUTTON}
      >
        <HarnessIcon harness={target} className="size-3.5 shrink-0" />
        {continueLabelFor(harness, target)}
      </button>
    );
  }
  return (
    <ContinueElsewhereMenu
      sessionId={sessionId}
      harness={harness}
      targets={targets}
      grokBot={grokBot}
    />
  );
}

function ContinueElsewhereMenu({
  sessionId,
  harness,
  targets,
  grokBot,
}: {
  sessionId: string;
  harness: HarnessId;
  targets: HarnessId[];
  /** Fork: also offer the Grok Bot app, which isn't a session provider. */
  grokBot: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dismiss = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };
  const pick = (target: HarnessId) => {
    dismiss(true);
    continueHost()?.continueSession(sessionId, target);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        data-fork-continue-elsewhere
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={BUTTON}
      >
        Continue elsewhere
        <ChevronDown
          className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      {open ? (
        <Popover
          anchor={button}
          side="top"
          align="end"
          gap={4}
          width={220}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          ignore="[data-fork-continue-elsewhere]"
          role="menu"
          aria-label="Continue elsewhere"
          className="overflow-hidden p-1 font-sans text-content"
        >
          {targets.map((target) => (
            <button
              key={target}
              type="button"
              role="menuitem"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(target)}
              className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-content/80 hover:bg-content/8 hover:text-content ${PRESS}`}
            >
              <HarnessIcon harness={target} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {continueLabelFor(harness, target)}
              </span>
            </button>
          ))}
          {grokBot ? (
            <button
              type="button"
              role="menuitem"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                dismiss(true);
                grokBotHost()?.handOver(sessionId);
              }}
              className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-content/80 hover:bg-content/8 hover:text-content ${PRESS}`}
            >
              <HarnessIcon harness="grok" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{GROK_BOT_MENU_LABEL}</span>
            </button>
          ) : null}
        </Popover>
      ) : null}
    </>
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
      {/* Solid fill. The inset modal glass is a 2% tint, and this bar sits
          on the scrolling transcript, so that tint lets the text behind it
          show through the label. */}
      <div
        data-fork-continued-from
        className="pointer-events-auto flex w-full max-w-[720px] min-w-0 items-center gap-3 rounded-xl border border-content/10 bg-background-base px-3 py-2 font-sans shadow-[0_8px_24px_-12px_rgb(0_0_0/0.55)]"
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
          <p className="truncate text-[11px] text-content/80">
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
            className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-content hover:bg-content/8 ${PRESS}`}
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
