import { useEffect, useState } from "react";
import { CircleDot, CircleHelp, Internet, Share } from "../../shared/ui/icons";
import type { FeedRow, Party, RowRoute, RowStatus } from "./messageLogView";
import { partyText, ROUTE_LABEL, ROUTE_TITLE, STATUS_LABEL, toneOf, type Tone } from "./messagesFilter";

/**
 * Fork: the Messages window's Feed. A row per message, newest first; a click
 * opens the whole message, what happened to it, and the relay's trail.
 */

const TONE: Record<Tone, string> = {
  problem: "bg-red-500/12 text-red-700 dark:bg-red-400/15 dark:text-red-300",
  held: "bg-amber-400/18 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200",
  waiting: "bg-content/8 text-content/60",
  delivered: "text-emerald-700 dark:text-emerald-300/85",
};

/** What a row can have done to it, beside opening its sessions. */
export type FeedActions = {
  onOpenSession: (openId: string) => void;
  /** Copies the message's text; rejects when the clipboard refused. */
  onCopy: (text: string) => Promise<void>;
  /** Opens "Send to all" with the text, so it can go to a session that is running. */
  onSendAgain: (text: string) => void;
  onDismiss: (rowId: string) => void;
  onRestore: (rowId: string) => void;
};

const LOST: ReadonlySet<RowStatus> = new Set(["failed", "dropped", "expired"]);

const ACTION =
  "rounded-md bg-content/[0.07] px-2 py-1 text-[11.5px] font-medium text-content/80 hover:bg-content/12 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

const ROUTE_ICON: Record<RowRoute, typeof Internet> = {
  local: CircleDot,
  relay: Internet,
  bridge: Share,
  unknown: CircleHelp,
};

export function MessageFeed({
  rows,
  formatTime,
  actions,
}: {
  rows: FeedRow[];
  formatTime: (at: number) => string;
  actions: FeedActions;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="flex flex-col gap-1" aria-label="Messages, newest first">
      {rows.map((row) => (
        <FeedItem
          key={row.id}
          row={row}
          open={open === row.id}
          formatTime={formatTime}
          onToggle={() => setOpen(open === row.id ? null : row.id)}
          actions={actions}
        />
      ))}
    </ol>
  );
}

function FeedItem({
  row,
  open,
  formatTime,
  onToggle,
  actions,
}: {
  row: FeedRow;
  open: boolean;
  formatTime: (at: number) => string;
  onToggle: () => void;
  actions: FeedActions;
}) {
  const tone = toneOf(row);
  const RouteIcon = ROUTE_ICON[row.route];
  const openable = [row.from, row.to].filter(
    (party, i, all): party is Party & { openId: string } =>
      Boolean(party.openId) && all.findIndex((p) => p.openId === party.openId) === i,
  );
  return (
    <li
      data-feed-row={row.id}
      data-status={row.status}
      className={`rounded-lg ${
        open ? "bg-content/[0.05]" : tone === "problem" ? "bg-red-500/[0.04] dark:bg-red-400/[0.05]" : ""
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`grid w-full grid-cols-[3.25rem_minmax(0,1fr)_auto] gap-x-3 rounded-lg px-2.5 py-2 text-left ${
          open ? "" : "hover:bg-content/[0.05]"
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        <span className="pt-px text-[11.5px] tabular-nums text-content/45">{formatTime(row.at)}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
            <PartyName party={row.from} withPlace={row.crossMachine} />
            <span className="shrink-0 text-content/35" aria-hidden>→</span>
            <span className="sr-only">to</span>
            <PartyName party={row.to} withPlace={row.crossMachine} />
          </span>
          {row.summary ? (
            <span className="truncate text-[12.5px] font-semibold text-content">{row.summary}</span>
          ) : null}
          <span
            className={`whitespace-pre-wrap break-words text-[12px] leading-[1.45] text-content/70 ${
              open ? "" : "line-clamp-2"
            }`}
          >
            {row.preview}
          </span>
          {tone === "problem" && !open ? (
            <span className="line-clamp-2 break-words text-[11.5px] leading-[1.4] text-red-700 dark:text-red-300">
              {row.statusText}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`inline-flex items-center rounded-full px-2 py-px text-[11px] font-medium ${TONE[tone]}`}
            data-tone={tone}
          >
            {STATUS_LABEL[row.status]}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-content/45" title={ROUTE_TITLE[row.route]}>
            <RouteIcon className="size-3" strokeWidth={1.75} aria-hidden />
            {ROUTE_LABEL[row.route]}
          </span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 pb-3 pl-[calc(3.25rem+1.375rem)] pr-3 text-[12px]">
          <p className={tone === "problem" ? "text-red-700 dark:text-red-300" : "text-content/75"}>{row.statusText}</p>
          {row.trail.length ? (
            <ol className="flex flex-col gap-0.5 rounded-md bg-content/[0.04] px-2.5 py-2 text-[11.5px] tabular-nums text-content/60">
              <li className="pb-0.5 text-[11px] font-medium text-content/45">Relay trail</li>
              {row.trail.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          ) : null}
          <RowActions row={row} openable={openable} actions={actions} />
        </div>
      ) : null}
    </li>
  );
}

function RowActions({
  row,
  openable,
  actions,
}: {
  row: FeedRow;
  openable: (Party & { openId: string })[];
  actions: FeedActions;
}) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(null), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  const lost = LOST.has(row.status);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-row-actions="">
      {lost ? (
        <button
          type="button"
          title="Pick a running session to send this text to"
          onClick={() => actions.onSendAgain(row.preview)}
          className={ACTION}
        >
          Send again…
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          actions.onCopy(row.preview).then(
            () => setCopied("yes"),
            () => setCopied("failed"),
          );
        }}
        className={ACTION}
      >
        {copied === "yes" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy text"}
      </button>
      {openable.map((party) => (
        <button
          key={party.openId}
          type="button"
          onClick={() => actions.onOpenSession(party.openId)}
          className={ACTION}
        >
          Open {party.label}
        </button>
      ))}
      {row.problem ? (
        <button
          type="button"
          title="Stop counting this as a problem; it stays in the list"
          onClick={() => actions.onDismiss(row.id)}
          className={ACTION}
        >
          Dismiss
        </button>
      ) : row.dismissed ? (
        <button
          type="button"
          title="Count this as a problem again"
          onClick={() => actions.onRestore(row.id)}
          className={ACTION}
        >
          Restore
        </button>
      ) : null}
    </div>
  );
}

function PartyName({ party, withPlace }: { party: Party; withPlace: boolean }) {
  const known = !party.key.startsWith("unknown:");
  return (
    <span className="flex min-w-0 shrink items-baseline gap-1" title={partyText(party, true)}>
      <span className={`truncate font-medium ${known ? "text-content" : "italic text-content/55"}`}>{party.label}</span>
      {withPlace && party.place ? (
        <span className="shrink-0 rounded bg-content/[0.07] px-1 text-[10.5px] text-content/55">{party.place.label}</span>
      ) : null}
    </span>
  );
}
