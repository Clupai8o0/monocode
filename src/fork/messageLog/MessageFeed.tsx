import { useEffect, useMemo, useState } from "react";
import { CurrentProjectIcon } from "../../features/projects/ui/CurrentProjectIcon";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { CircleDot, CircleHelp, Internet, Share } from "../../shared/ui/icons";
import { knownLocalProjectPaths } from "../externalSessions/externalSessionsStore";
import { PREVIEW_MAX } from "./messageLogProtocol";
import type { FeedRow, Party, RowRoute, RowStatus } from "./messageLogView";
import { partyText, ROUTE_TITLE, shortStatus, STATUS_LABEL, toneOf, type Tone } from "./messagesFilter";
import { partyProject, projectsByName } from "./partyProject";

/**
 * Fork: the Messages window's Feed. A row per message, newest first: who sent
 * it to whom (each with its project's icon), its subject, and a few words on
 * what went wrong when something did. A click opens the whole message, what
 * happened to it, how it travelled (machine tags already show when it
 * crossed machines), and the relay's trail.
 */

const TONE_TEXT: Record<Tone, string> = {
  problem: "text-red-700 dark:text-red-300",
  held: "text-amber-800 dark:text-amber-200",
  waiting: "text-content/55",
  delivered: "text-emerald-700 dark:text-emerald-300/85",
};

const TONE_DOT: Record<Tone, string> = {
  problem: "bg-red-500 dark:bg-red-400",
  held: "bg-amber-500 dark:bg-amber-400",
  waiting: "bg-content/35",
  delivered: "bg-emerald-500/80 dark:bg-emerald-400/80",
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

type Projects = { known: readonly string[]; byName: Map<string, string> };

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
  // Read again when the rows change, so a project opened since shows up.
  const projects = useMemo<Projects>(() => {
    const known = knownLocalProjectPaths();
    return { known, byName: projectsByName(known) };
  }, [rows]);
  return (
    <ol className="flex flex-col gap-0.5" aria-label="Messages, newest first">
      {rows.map((row) => (
        <FeedItem
          key={row.id}
          row={row}
          open={open === row.id}
          formatTime={formatTime}
          onToggle={() => setOpen(open === row.id ? null : row.id)}
          actions={actions}
          projects={projects}
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
  projects,
}: {
  row: FeedRow;
  open: boolean;
  formatTime: (at: number) => string;
  onToggle: () => void;
  actions: FeedActions;
  projects: Projects;
}) {
  const tone = toneOf(row);
  const RouteIcon = ROUTE_ICON[row.route];
  const openable = [row.from, row.to].filter(
    (party, i, all): party is Party & { openId: string } =>
      Boolean(party.openId) && all.findIndex((p) => p.openId === party.openId) === i,
  );
  const subject = row.summary || row.preview.split("\n").find((line) => line.trim()) || row.preview;
  const showStatus = tone !== "delivered";
  return (
    <li
      data-feed-row={row.id}
      data-status={row.status}
      className={`rounded-lg ${open ? "bg-content/[0.05]" : ""}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-lg px-3 py-2 text-left ${
          open ? "" : "hover:bg-content/[0.05]"
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <PartyName party={row.from} withPlace={row.crossMachine} projects={projects} />
            <span className="shrink-0 text-content/30" aria-hidden>→</span>
            <span className="sr-only">to</span>
            <PartyName party={row.to} withPlace={row.crossMachine} projects={projects} />
          </span>
          <span
            className={`text-[13px] font-medium text-content ${
              open ? "whitespace-pre-wrap break-words" : "truncate"
            }`}
          >
            {subject}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span className="text-[11.5px] tabular-nums text-content/45">{formatTime(row.at)}</span>
          {showStatus ? (
            <span
              className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium ${TONE_TEXT[tone]}`}
              data-tone={tone}
              title={row.statusText}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
              {STATUS_LABEL[row.status]}
              {open ? null : (
                <span className="font-normal opacity-80">· {shortStatus(row)}</span>
              )}
            </span>
          ) : (
            <span className="sr-only" data-tone={tone}>
              {STATUS_LABEL[row.status]}
            </span>
          )}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 px-3 pb-3 text-[12px]">
          {row.preview.trim() !== subject.trim() ? (
            <p className="whitespace-pre-wrap break-words leading-[1.5] text-content/75">{row.preview}</p>
          ) : null}
          <p className={tone === "problem" ? "text-red-700 dark:text-red-300" : "text-content/65"}>{row.statusText}</p>
          <p className="inline-flex items-center gap-1 text-[11.5px] text-content/50">
            <RouteIcon className="size-3" strokeWidth={1.75} aria-hidden />
            {ROUTE_TITLE[row.route]}
          </p>
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
  // Only the start of a long message is kept, so say what these act on.
  const cut = [...row.preview].length >= PREVIEW_MAX;
  return (
    <>
      {cut ? (
        <p className="text-[11px] text-content/50" data-preview-cut="">
          Only the first {PREVIEW_MAX} characters were kept, so Copy and Send again use those.
        </p>
      ) : null}
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
    </>
  );
}

function PartyName({
  party,
  withPlace,
  projects,
}: {
  party: Party;
  withPlace: boolean;
  projects: Projects;
}) {
  const known = !party.key.startsWith("unknown:");
  const cwd = partyProject(party, projects.known, projects.byName);
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5" title={partyText(party, true)}>
      {cwd ? (
        <span aria-hidden data-party-project={cwd} className="grid size-4 shrink-0 place-items-center overflow-hidden rounded">
          <CurrentProjectIcon cwd={cwd} className="size-4" mascotClassName="size-3" />
        </span>
      ) : (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded bg-content/[0.07]">
          <HarnessIcon harness="claude" className="size-2.5" />
        </span>
      )}
      <span className={`truncate font-medium ${known ? "text-content/80" : "italic text-content/50"}`}>{party.label}</span>
      {withPlace && party.place ? (
        <span className="shrink-0 rounded bg-content/[0.07] px-1 text-[10.5px] text-content/55">{party.place.label}</span>
      ) : null}
    </span>
  );
}
