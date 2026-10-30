import { useRef, useState, useSyncExternalStore } from "react";
import { emit } from "@tauri-apps/api/event";
import { NOTIFICATION_CLICK_EVENT } from "../../features/notifications/model/notifications";
import { Mail } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { openLabSettings } from "../lab/labStore";
import { MessagesWindow } from "../messageLog/MessagesWindow";
import {
  closeMessagesWindow,
  openMessagesWindow,
  setMessageLogWindow,
  useMessageLog,
  useMessagesWindowRequest,
  type MessagesWindowRequest,
} from "../messageLog/messageLogStore";
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
 * project; a row opens the session it went to. A red count shows messages
 * between sessions that went wrong in the last hour; a row in the popover
 * explains it and opens the Messages window (src/fork/messageLog) on them.
 */
export function MessagesButton() {
  return FORK_MESSAGES ? (
    <>
      <Messages />
      <MessagesWindowHost />
    </>
  ) : null;
}

// A new request (another "Open" while it is open) starts the window afresh.
const requestIds = new WeakMap<MessagesWindowRequest, number>();
let nextRequestId = 0;

function MessagesWindowHost() {
  const request = useMessagesWindowRequest();
  if (!request) {
    return null;
  }
  if (!requestIds.has(request)) {
    requestIds.set(request, ++nextRequestId);
  }
  return <OpenMessagesWindow key={requestIds.get(request)} request={request} />;
}

function OpenMessagesWindow({ request }: { request: MessagesWindowRequest }) {
  const view = useMessageLog(true);
  return (
    <MessagesWindow
      view={view}
      initial={request}
      onClose={closeMessagesWindow}
      onWindowChange={setMessageLogWindow}
      onOpenSession={(openId) => {
        void emit(NOTIFICATION_CLICK_EVENT, openId);
        closeMessagesWindow();
      }}
      onOpenHomeLab={() => {
        closeMessagesWindow();
        openLabSettings();
      }}
    />
  );
}

function Messages() {
  useSyncExternalStore(subscribePeerStats, peerStatsVersion, peerStatsVersion);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const rows = inboxRows();
  const problems = useMessageLog(false).recentProblems;
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
        title={[
          unread.length
            ? `${unread.length} unread message${unread.length === 1 ? "" : "s"} from other sessions`
            : "Messages from other sessions",
          problems
            ? `${problems} message${problems === 1 ? "" : "s"} between sessions went wrong in the last hour`
            : "",
        ]
          .filter(Boolean)
          .join(". ")}
        onClick={() => setOpen(!open)}
      >
        <Mail className="size-3.5" strokeWidth={1.75} aria-hidden />
        <span className="tabular-nums">{label}</span>
        {urgent ? (
          <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />
        ) : null}
        {problems ? (
          <span
            data-fork-messages-problems=""
            className="min-w-3.5 rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-3.5 tabular-nums text-white"
          >
            {problems > 99 ? "99+" : problems}
          </span>
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
          <MessagesPanel rows={rows} problems={problems} onOpen={() => setOpen(false)} />
        </Popover>
      ) : null}
    </>
  );
}

function MessagesPanel({
  rows,
  problems,
  onOpen,
}: {
  rows: InboxRow[];
  problems: number;
  onOpen: () => void;
}) {
  const [project, setProject] = useState<string | null>(null);
  const projects = [...new Set(rows.map((r) => r.project))].sort();
  const shown = project ? rows.filter((r) => r.project === project) : rows;
  return (
    <div className="flex max-h-[420px] flex-col gap-1 p-2 text-[12px]">
      <button
        type="button"
        onClick={() => {
          setMessageLogWindow("24h");
          openMessagesWindow();
          onOpen();
        }}
        className="mb-1 flex items-center justify-between rounded-md bg-content/[0.06] px-2 py-1.5 text-left font-medium text-content hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Open messages view
        <span className="text-[11px] font-normal text-content/45">Every session, every machine</span>
      </button>
      {problems ? (
        <button
          type="button"
          data-fork-messages-problems-row=""
          onClick={() => {
            // The same hour as the count, so the list and the number agree.
            setMessageLogWindow("1h");
            openMessagesWindow({ problemsOnly: true });
            onOpen();
          }}
          className="mb-1 flex items-center gap-2 rounded-md bg-red-500/10 px-2 py-1.5 text-left font-medium text-content hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden />
          {problems} went wrong in the last hour
        </button>
      ) : null}
      <div className="px-1 pb-1 font-semibold text-content">Messages</div>
      {rows.length === 0 ? (
        <p className="px-1 pb-1 text-content/50">
          Nothing new for the sessions open here. The messages view has every message.
        </p>
      ) : null}
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
