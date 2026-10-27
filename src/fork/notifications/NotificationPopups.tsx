import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "../../shared/ui/icons";
import { LAYER } from "../../shared/lib/layers";
import { allowsProjectNotificationIndicator } from "../../features/notifications/model/notificationPreferences";
import {
  notificationHistorySnapshot,
  openHistoryNotification,
  subscribeNotificationHistory,
  subscribeNotificationPopups,
} from "./notificationStore";
import type { HistoryNotification } from "./notificationHistory";

/**
 * Fork: each new event pops up once, top right, for a few seconds, then lives
 * on in the bell. Only events whose session was not on screen; muted projects
 * stay quiet; hovering keeps a pop-up open.
 */
export const POPUP_MS = { finished: 6000, question: 12000, approval: 12000 };
const MAX = 3;

const LABEL = {
  finished: "Finished",
  question: "Question",
  approval: "Approval",
};

export function NotificationPopups({ topOffset = 12 }: { topOffset?: number })
{
  const [rows, setRows] = useState<HistoryNotification[]>([]);
  const history = useSyncExternalStore(
    subscribeNotificationHistory,
    notificationHistorySnapshot,
    notificationHistorySnapshot,
  );
  useEffect(
    () =>
      subscribeNotificationPopups((row) => {
        const quiet = !allowsProjectNotificationIndicator({
          projectId: row.projectId,
          category: row.kind === "finished" ? "agentFinished" : "agentInput",
        });
        if (quiet) {
          return;
        }
        setRows((current) =>
          [row, ...current.filter((entry) => entry.id !== row.id)].slice(0, MAX),
        );
      }),
    [],
  );
  // Read from the bell, or in another window: it goes here too.
  useEffect(() => {
    const read = new Set(
      history.filter((row) => row.readAt).map((row) => row.id),
    );
    setRows((current) =>
      current.some((row) => read.has(row.id))
        ? current.filter((row) => !read.has(row.id))
        : current,
    );
  }, [history]);
  const dismiss = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
  }, []);
  if (!rows.length) {
    return null;
  }
  return createPortal(
    <div
      aria-live="polite"
      data-fork-notification-popups=""
      style={{ zIndex: LAYER.toast, top: topOffset }}
      className="pointer-events-none fixed right-3 flex w-[min(340px,calc(100vw-24px))] flex-col gap-2"
    >
      {rows.map((row) => (
        <Popup key={row.id} row={row} onDone={dismiss} />
      ))}
    </div>,
    document.body,
  );
}

function Popup({
  row,
  onDone,
}: {
  row: HistoryNotification;
  onDone: (id: string) => void;
})
{
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (paused) {
      return;
    }
    const timer = window.setTimeout(() => onDone(row.id), POPUP_MS[row.kind]);
    return () => window.clearTimeout(timer);
  }, [paused, row.id, row.kind, onDone]);
  return (
    <article
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto relative overflow-hidden rounded-xl bg-background-base/95 shadow-xl ring-1 ring-content/10 backdrop-blur-xl"
    >
      <button
        type="button"
        data-fork-notification-popup=""
        title={`Open ${row.title}`}
        onClick={async () => {
          try {
            await openHistoryNotification(row);
            onDone(row.id);
          } catch {
            setFailed(true);
          }
        }}
        className="flex w-full flex-col gap-1 px-3.5 py-3 pr-8 text-left hover:bg-content/5"
      >
        <span className="flex items-center gap-1.5 text-[10px]">
          <span
            className={
              row.kind === "finished"
                ? "text-emerald-600 dark:text-emerald-300"
                : "text-amber-600 dark:text-amber-300"
            }
          >
            {LABEL[row.kind]}
          </span>
          <span className="min-w-0 truncate text-content/40">{row.project}</span>
        </span>
        <span className="truncate text-[13px] font-medium text-content/90">
          {row.title}
        </span>
        <span className="line-clamp-2 break-words text-[11px] leading-relaxed text-content/55">
          {failed ? "Couldn’t open the session. Try the bell." : row.body}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Hide ${row.title}`}
        title="Hide (stays in the bell)"
        onClick={() => onDone(row.id)}
        className="absolute right-1.5 top-1.5 rounded p-1 text-content/35 hover:bg-content/10 hover:text-content"
      >
        <X className="size-3" aria-hidden />
      </button>
    </article>
  );
}
