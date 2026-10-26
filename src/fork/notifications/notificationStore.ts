import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "../../features/sessions/model/session";
import type {
  NotificationEvent,
  NotificationText,
} from "../../features/notifications/model/notifications";
import { OPEN_SESSION_EVENT } from "../workspaces/workspaces";
import {
  HISTORY_PREFIX,
  NotificationHistory,
  historyNotification,
  type HistoryNotification,
} from "./notificationHistory";

const CHANGED = "monocode:notification-history-changed";
const history = new NotificationHistory(() => localStorage);
const listeners = new Set<() => void>();
let snapshot = history.getSnapshot();
let stopSync: (() => void) | undefined;
const changed = () => {
  const next = history.getSnapshot();
  if (next === snapshot) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
};

export const notificationHistorySnapshot = () => snapshot;

export function subscribeNotificationHistory(listener: () => void): () => void {
  changed(); // Catch changes made while no window control was subscribed.
  listeners.add(listener);
  if (listeners.size === 1) {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(HISTORY_PREFIX)) {
        changed();
      }
    };
    window.addEventListener("storage", storage);
    void listen(CHANGED, changed)
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {});
    stopSync = () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("storage", storage);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopSync?.();
      stopSync = undefined;
    }
  };
}

function publish(): void {
  changed();
  void emit(CHANGED).catch(() => {});
}

/** This local history does not depend on OS banner permission or sound settings. */
export function recordSessionNotification(
  session: Session,
  event: NotificationEvent,
  text: NotificationText,
  projectId: string,
  occurredAt: number,
): void {
  try {
    const entry = historyNotification(
      session,
      event,
      text,
      projectId,
      occurredAt,
    );
    if (entry && history.record(entry)) {
      publish();
    }
  } catch {
    /* History must never interrupt the normal banner/sound path. */
  }
}

export function markNotificationsRead(ids: readonly string[]): void {
  history.markRead(ids);
  publish();
}

/** Target this window's history opener: it also loads detached saved sessions.
 * Ownership checks there focus another workspace when that window owns it.
 * A failed event dispatch keeps the row unread; delivery does not confirm navigation. */
export async function openHistoryNotification(
  row: HistoryNotification,
): Promise<void> {
  await emitTo(getCurrentWindow().label, OPEN_SESSION_EVENT, row.sessionId);
  markNotificationsRead([row.id]);
}
