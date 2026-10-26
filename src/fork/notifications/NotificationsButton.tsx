import { useRef, useState, useSyncExternalStore } from "react";
import { Bell, Check, CheckCheck } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import {
  allowsProjectNotificationIndicator,
  notificationPreferencesSnapshot,
  subscribeNotificationPreferences,
} from "../../features/notifications/model/notificationPreferences";
import {
  markNotificationsRead,
  notificationHistorySnapshot,
  openHistoryNotification,
  subscribeNotificationHistory,
} from "./notificationStore";
import type { HistoryNotification } from "./notificationHistory";

function indicates(row: HistoryNotification): boolean {
  return allowsProjectNotificationIndicator({
    projectId: row.projectId,
    category: row.kind === "finished" ? "agentFinished" : "agentInput",
  });
}

const LABEL = {
  finished: "Finished",
  question: "Question",
  approval: "Approval",
};

/** Local event history; opening it neither asks OS permission nor marks rows read. */
export function NotificationsButton() {
  const rows = useSyncExternalStore(
    subscribeNotificationHistory,
    notificationHistorySnapshot,
    notificationHistorySnapshot,
  );
  useSyncExternalStore(
    subscribeNotificationPreferences,
    notificationPreferencesSnapshot,
    notificationPreferencesSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "decisions" | "finished">("all");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const unread = rows.filter((row) => !row.readAt && indicates(row));
  const hasDecision = unread.some((row) => row.kind !== "finished");
  const shown = rows.filter(
    (row) =>
      filter === "all" ||
      (filter === "finished"
        ? row.kind === "finished"
        : row.kind !== "finished"),
  );
  const label = unread.length
    ? `Notifications, ${unread.length} unread`
    : "Notifications";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-tauri-drag-region="false"
        data-fork-notifications=""
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setError("");
          setOpen(!open);
        }}
        className={`relative grid size-7 shrink-0 place-items-center rounded-md hover:bg-content/10 ${open ? "text-content" : "text-content/45 hover:text-content"}`}
      >
        <Bell className="size-3.5" strokeWidth={1.75} aria-hidden />
        {unread.length ? (
          <span
            aria-hidden
            className={`absolute -right-0.5 -top-0.5 min-w-3.5 rounded px-0.5 text-center text-[9px] font-semibold leading-3.5 tabular-nums ${hasDecision ? "bg-amber-400 text-amber-950" : "bg-accent text-background-base"}`}
          >
            {unread.length > 99 ? "99+" : unread.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="bottom"
          align="start"
          gap={6}
          width={368}
          ignore="[data-fork-notifications]"
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex max-h-[460px] flex-col p-2 text-xs">
            <header className="flex items-center gap-2 px-1 pb-2 pt-1">
              <span className="font-semibold text-content">Notifications</span>
              <span className="text-[11px] text-content/40">
                {unread.length} unread
              </span>
              {rows.some((row) => !row.readAt) ? (
                <button
                  type="button"
                  onClick={() =>
                    markNotificationsRead(rows.map((row) => row.id))
                  }
                  className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-content/55 hover:bg-content/10 hover:text-content"
                  title="Mark all notifications read"
                >
                  <CheckCheck className="size-3" aria-hidden />
                  Mark all read
                </button>
              ) : null}
            </header>
            <div
              className="mb-2 flex gap-1 px-1"
              role="group"
              aria-label="Filter notifications"
            >
              {(["all", "decisions", "finished"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`rounded px-2 py-1 text-[11px] ${filter === value ? "bg-content/10 text-content" : "text-content/45 hover:bg-content/5 hover:text-content"}`}
                >
                  {value === "all"
                    ? "All"
                    : value === "decisions"
                      ? "Decisions"
                      : "Finished"}
                </button>
              ))}
            </div>
            {error ? (
              <p
                className="px-2 pb-2 text-[11px] text-amber-600 dark:text-amber-300"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <div className="min-h-0 overflow-y-auto">
              {shown.length ? (
                shown.map((row) => {
                  const muted = !indicates(row);
                  return (
                    <div
                      key={row.id}
                      className="group flex items-start rounded-md hover:bg-content/5"
                    >
                      <button
                        type="button"
                        disabled={opening !== null}
                        data-fork-notification-row=""
                        onClick={async () => {
                          setOpening(row.id);
                          setError("");
                          try {
                            await openHistoryNotification(row);
                            setOpen(false);
                          } catch {
                            setError("Couldn’t open the session. Try again.");
                          } finally {
                            setOpening(null);
                          }
                        }}
                        title={`Open ${row.title}`}
                        className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-2 py-2.5 text-left disabled:opacity-60"
                      >
                        <span className="flex w-full items-center gap-1.5 text-[10px]">
                          {!row.readAt && !muted ? (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-accent"
                              aria-label="Unread"
                            />
                          ) : null}
                          <span
                            className={
                              row.kind === "finished"
                                ? "text-emerald-600 dark:text-emerald-300"
                                : "text-amber-600 dark:text-amber-300"
                            }
                          >
                            {LABEL[row.kind]}
                          </span>
                          <span className="min-w-0 truncate text-content/40">
                            {row.project}
                            {muted ? " · Muted" : ""}
                          </span>
                          <time
                            className="ml-auto shrink-0 tabular-nums text-content/35"
                            dateTime={new Date(row.occurredAt).toISOString()}
                            title={new Date(row.occurredAt).toLocaleString()}
                          >
                            {new Date(row.occurredAt).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        </span>
                        <span className="w-full truncate font-medium text-content/85">
                          {row.title}
                        </span>
                        <span className="line-clamp-2 break-words text-[11px] leading-relaxed text-content/50">
                          {row.body}
                        </span>
                      </button>
                      {!row.readAt ? (
                        <button
                          type="button"
                          aria-label={`Mark ${row.title} read`}
                          title="Mark read"
                          onClick={() => markNotificationsRead([row.id])}
                          className="mr-1 mt-2 rounded p-1 text-content/30 hover:bg-content/10 hover:text-content"
                        >
                          <Check className="size-3" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-content/45">
                  {rows.length
                    ? "No notifications in this view."
                    : "Task completions, questions, and approval requests will appear here."}
                </p>
              )}
            </div>
            {rows.length ? (
              <p className="mt-2 border-t border-content/5 px-1 pt-2 text-[10px] text-content/30">
                Recent activity · decisions remain in their session
              </p>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
