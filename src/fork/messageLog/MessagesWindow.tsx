import { useState, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, X } from "../../shared/ui/icons";
import { Modal } from "../../shared/ui/Modal";
import { formatPeerTime } from "../peerMessages/peerMessage";
import { MessageFeed, type FeedActions } from "./MessageFeed";
import { MessageMap } from "./MessageMap";
import type { MessagesWindowRequest } from "./messageLogStore";
import type { MessageLogView, WindowChoice } from "./messageLogView";
import {
  countsLine,
  filterRows,
  partyByKey,
  sourceLines,
  WINDOW_WORDS,
  type FeedFilter,
} from "./messagesFilter";

/**
 * Fork: the Messages window. Every message Claude sessions sent each other on
 * this Mac and the paired hosts, as a Feed (newest first) and a Map (who
 * talked to whom), with the ones that never arrived called out. It only
 * draws the view; messageLogStore.ts keeps it fresh.
 */

export type MessagesWindowProps = {
  view: MessageLogView;
  onClose: () => void;
  onWindowChange: (choice: WindowChoice) => void;
  onOpenSession: (openId: string) => void;
  onCopy: FeedActions["onCopy"];
  onSendAgain: FeedActions["onSendAgain"];
  onDismiss: FeedActions["onDismiss"];
  onRestore: FeedActions["onRestore"];
  onOpenHomeLab: () => void;
  initial?: MessagesWindowRequest;
  /** Clock time for rows; tests pass a fixed one. */
  formatTime?: (at: number) => string;
};

type Tab = "feed" | "map";

const WINDOWS: { value: WindowChoice; label: string; title: string }[] = [
  { value: "1h", label: "1h", title: "The last hour" },
  { value: "24h", label: "24h", title: "The last 24 hours" },
  { value: "7d", label: "7d", title: "The last 7 days" },
];

export function MessagesWindow({
  view,
  onClose,
  onWindowChange,
  onOpenSession,
  onCopy,
  onSendAgain,
  onDismiss,
  onRestore,
  onOpenHomeLab,
  initial,
  formatTime = formatPeerTime,
}: MessagesWindowProps) {
  const [tab, setTab] = useState<Tab>("feed");
  const [filter, setFilter] = useState<FeedFilter>({
    problemsOnly: initial?.problemsOnly ?? false,
    placeId: null,
    partyKey: initial?.partyKey ?? null,
  });
  const rows = filterRows(view.rows, filter);
  const filtered = filter.problemsOnly || filter.placeId !== null || filter.partyKey !== null;
  const party = filter.partyKey ? partyByKey(view, filter.partyKey) : undefined;
  const places = view.sources.map((source) => source.place);
  const lines = sourceLines(view, formatTime);
  return (
    <Modal title="Messages" size="lg" onClose={onClose} className="h-[min(680px,calc(100dvh-64px))]">
      <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-2 text-[12px]">
        <div className="flex flex-wrap items-center gap-2">
          <Choice
            label="Time window"
            options={WINDOWS}
            value={view.window}
            onChange={onWindowChange}
          />
          <button
            type="button"
            aria-pressed={filter.problemsOnly}
            onClick={() => setFilter({ ...filter, problemsOnly: !filter.problemsOnly })}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              filter.problemsOnly
                ? "bg-red-500/12 text-red-700 dark:bg-red-400/15 dark:text-red-300"
                : "bg-content/5 text-content/65 hover:text-content"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${view.counts.problems ? "bg-red-500 dark:bg-red-400" : "bg-content/25"}`}
              aria-hidden
            />
            Problems only
          </button>
          {places.length > 1 ? (
            <Choice
              label="Machine"
              options={[
                { value: "", label: "All", title: "Every machine" },
                ...places.map((place) => ({
                  value: place.id,
                  label: place.label,
                  title: place.os ? `${place.label} · ${place.os}` : place.label,
                })),
              ]}
              value={filter.placeId ?? ""}
              onChange={(id) => setFilter({ ...filter, placeId: id || null })}
            />
          ) : null}
        </div>

        {view.warning ? (
          <div
            role="status"
            className="flex items-center gap-3 rounded-lg bg-amber-400/12 px-3 py-2.5 text-amber-900 dark:bg-amber-400/10 dark:text-amber-100"
          >
            <CircleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-300" strokeWidth={1.75} aria-hidden />
            <p className="min-w-0 flex-1 leading-snug">{view.warning}</p>
            <button
              type="button"
              onClick={onOpenHomeLab}
              className="shrink-0 rounded-md bg-amber-500/15 px-2.5 py-1 font-medium hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:bg-amber-300/15 dark:hover:bg-amber-300/25"
            >
              Open Home lab
            </button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div role="tablist" aria-label="Messages view" className="flex gap-4">
            {(["feed", "map"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded ${
                  tab === value ? "font-semibold text-content" : "text-content/45 hover:text-content/80"
                }`}
              >
                {value === "feed" ? "Feed" : "Map"}
              </button>
            ))}
          </div>
          <p className="text-content/50 tabular-nums" data-counts="">
            {countsLine(view, rows.length, filtered)} in {WINDOW_WORDS[view.window]}
          </p>
          {party ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent/15 py-0.5 pl-2.5 pr-1 text-[11.5px] text-content">
              Only {party.label}
              <button
                type="button"
                aria-label={`Show every session, not only ${party.label}`}
                onClick={() => setFilter({ ...filter, partyKey: null })}
                className="grid size-4 place-items-center rounded-full text-content/55 hover:bg-content/10 hover:text-content"
              >
                <X className="size-2.5" strokeWidth={2} />
              </button>
            </span>
          ) : null}
        </div>

        {lines.length ? (
          <ul className="flex flex-col gap-0.5 text-content/55">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <div className="-mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5">
          {tab === "map" ? (
            <MessageMap
              graph={view.graph}
              problemsOnly={filter.problemsOnly}
              placeId={filter.placeId}
              partyKey={filter.partyKey}
              onPick={(key) => {
                setFilter({ ...filter, partyKey: key });
                setTab("feed");
              }}
            />
          ) : view.loading && view.rows.length === 0 ? (
            <Quiet>
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              Reading messages…
            </Quiet>
          ) : rows.length === 0 ? (
            filtered && view.rows.length ? (
              <Quiet>
                Nothing matches these filters.
                <button
                  type="button"
                  onClick={() => setFilter({ problemsOnly: false, placeId: null, partyKey: null })}
                  className="rounded px-1 font-medium text-accent hover:underline"
                >
                  Show everything
                </button>
              </Quiet>
            ) : (
              <Quiet>No messages between sessions in {WINDOW_WORDS[view.window]}.</Quiet>
            )
          ) : (
            <MessageFeed
              rows={rows}
              formatTime={formatTime}
              actions={{ onOpenSession, onCopy, onSendAgain, onDismiss, onRestore }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="flex items-center justify-center gap-2 py-12 text-content/50">{children}</p>;
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-7 items-center gap-0.5 rounded-md bg-content/5 p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value || "all"}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            onClick={() => {
              if (!selected) {
                onChange(option.value);
              }
            }}
            className={`h-full rounded px-2.5 transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              selected ? "bg-content/10 font-semibold text-content" : "text-content/60 hover:text-content"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
