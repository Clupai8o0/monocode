import { useRef, useState, useSyncExternalStore } from "react";
import { emit } from "@tauri-apps/api/event";
import { NOTIFICATION_CLICK_EVENT } from "../../features/notifications/model/notifications";
import { Mail } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { formatPeerTime } from "./peerMessage";
import {
  inboxRows,
  peerStatsVersion,
  subscribePeerStats,
  type InboxRow,
} from "./peerStats";

/** Off under the test runner, so upstream footer tests see no extra button. */
export const FORK_MESSAGES = import.meta.env.MODE !== "test";

/**
 * Fork: footer button "Messages · N" (N unread). Opens every message other
 * sessions sent into MonoCode's sessions, newest first, with a filter per
 * project; a row opens the session it went to. Hidden until there is one.
 */
export function MessagesButton() {
  return FORK_MESSAGES ? <Messages /> : null;
}

function Messages() {
  useSyncExternalStore(subscribePeerStats, peerStatsVersion, peerStatsVersion);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const rows = inboxRows();
  if (rows.length === 0) {
    return null;
  }
  const unread = rows.filter((r) => r.unread);
  const urgent = unread.some((r) => r.urgent);
  const label = unread.length ? `Messages · ${unread.length}` : "Messages";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-messages=""
        className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
          open
            ? "text-accent"
            : unread.length
              ? "text-content/70 hover:text-content"
              : "text-content/40 hover:text-content"
        }`}
        aria-expanded={open}
        title={
          unread.length
            ? `${unread.length} unread message${unread.length === 1 ? "" : "s"} from other sessions`
            : "Messages from other sessions"
        }
        onClick={() => setOpen(!open)}
      >
        <Mail className="size-3.5" strokeWidth={1.75} aria-hidden />
        <span className="tabular-nums">{label}</span>
        {urgent ? (
          <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          gap={6}
          width={380}
          ignore="[data-fork-messages]"
          onDismiss={() => setOpen(false)}
        >
          <MessagesPanel rows={rows} onOpen={() => setOpen(false)} />
        </Popover>
      ) : null}
    </>
  );
}

function MessagesPanel({
  rows,
  onOpen,
}: {
  rows: InboxRow[];
  onOpen: () => void;
}) {
  const [project, setProject] = useState<string | null>(null);
  const projects = [...new Set(rows.map((r) => r.project))].sort();
  const shown = project ? rows.filter((r) => r.project === project) : rows;
  return (
    <div className="flex max-h-[420px] flex-col gap-1 p-2 text-[12px]">
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="font-semibold text-content">Messages</span>
        <span className="text-content/45">{rows.length} in</span>
      </div>
      {projects.length > 1 ? (
        <div
          className="flex flex-wrap gap-1 px-1 pb-1"
          role="group"
          aria-label="Filter by project"
        >
          {[null, ...projects].map((p) => (
            <button
              key={p ?? "all"}
              type="button"
              aria-pressed={project === p}
              onClick={() => setProject(p)}
              className={`rounded px-1.5 py-px text-[11px] ${
                project === p
                  ? "bg-selection text-content"
                  : "text-content/55 hover:bg-content/10 hover:text-content"
              }`}
            >
              {p ?? "All"}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {shown.map((row, i) => (
          <button
            key={`${row.sessionId}-${row.at ?? i}-${i}`}
            type="button"
            data-fork-message-row=""
            title={`Open ${row.title}`}
            onClick={() => {
              void emit(NOTIFICATION_CLICK_EVENT, row.sessionId);
              onOpen();
            }}
            className="flex flex-col gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-content/5"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {row.unread ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-accent"
                  aria-label="Unread"
                />
              ) : null}
              <span className="shrink-0 font-semibold text-content">
                {row.name}
              </span>
              <span className="min-w-0 truncate text-content/45">
                → {row.title}
              </span>
              {row.urgent ? (
                <span className="shrink-0 rounded bg-amber-400/15 px-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  Urgent
                </span>
              ) : null}
              {row.at ? (
                <span className="ml-auto shrink-0 tabular-nums text-content/40">
                  {formatPeerTime(row.at)}
                </span>
              ) : null}
            </span>
            <span className="line-clamp-2 whitespace-pre-wrap break-words text-content/75">
              {row.body}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
