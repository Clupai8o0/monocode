import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  cachedNotificationPermission,
  isWindowFocused,
  loadNotificationsEnabled,
  notificationText,
  pendingInputNotifications,
  type InputNotificationEvent,
} from "../../features/notifications/model/notifications";
import { allowsProjectNotification } from "../../features/notifications/model/notificationPreferences";
import { knownNotificationProject } from "../../features/notifications/model/notificationProjects";
import type { Session } from "../../features/sessions/model/session";
import {
  loadSoundsEnabled,
  playCue,
} from "../../features/settings/model/sounds";

/**
 * Fork feature: an approval or question left unanswered for 5 minutes alerts
 * once more ("still needs you": banner, sound, a Dock bounce), like the
 * terminal sessions' alerts.py does. While you are looking at that session it
 * waits, and fires as soon as you look away.
 */

/** Same as alerts.py's default `delay`. */
export const NEEDS_AGAIN_MS = 300_000;
const TICK_MS = 15_000;
/** Off under the test runner, so upstream App tests see no extra timers. */
const FORK_NEEDS_AGAIN = import.meta.env.MODE !== "test";

/**
 * Tracks when each pending request was first seen and returns the ones
 * waiting `delay` or longer that have not alerted again yet. Drops requests
 * that are no longer pending.
 */
export function dueAgain(
  pending: Iterable<string>,
  firstSeen: Map<string, number>,
  alerted: Set<string>,
  now: number,
  delay = NEEDS_AGAIN_MS,
): string[] {
  const live = new Set(pending);
  for (const key of [...firstSeen.keys()]) {
    if (!live.has(key)) {
      firstSeen.delete(key);
      alerted.delete(key);
    }
  }
  const due: string[] = [];
  for (const key of live) {
    const seen = firstSeen.get(key);
    if (seen === undefined) {
      firstSeen.set(key, now);
    } else if (!alerted.has(key) && now - seen >= delay) {
      due.push(key);
    }
  }
  return due;
}

async function alertAgain(session: Session, event: InputNotificationEvent) {
  const project = knownNotificationProject(session.cwd);
  if (!project) {
    return;
  }
  const subject = {
    projectId: project.id,
    category: "agentInput" as const,
    occurredAt: Date.now(),
  };
  if (!allowsProjectNotification(subject)) {
    return;
  }
  const permission = cachedNotificationPermission();
  let sent = false;
  if (
    loadNotificationsEnabled() &&
    (permission === "granted" || permission === "prompt")
  ) {
    const text = notificationText(session, event);
    try {
      await invoke("show_notification", {
        sessionId: session.id,
        title: text.title,
        subtitle: `Still needs you · ${text.subtitle}`,
        body: text.body,
        sound: loadSoundsEnabled(),
      });
      sent = true;
    } catch {
      // Falls back to the in-app sound below.
    }
  }
  if (!sent) {
    playCue("inputRequested", subject);
  }
  if (!isWindowFocused()) {
    void getCurrentWindow()
      .requestUserAttention(UserAttentionType.Informational)
      .catch(() => {});
  }
}

export function useNeedsAgain(
  sessions: Session[],
  activeSessionId: string | undefined,
) {
  const pending = useMemo(
    () => pendingInputNotifications(sessions),
    [sessions],
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const firstSeen = useRef(new Map<string, number>());
  const alerted = useRef(new Set<string>());
  const waiting = pending.size > 0;

  useEffect(() => {
    if (!FORK_NEEDS_AGAIN || !waiting) {
      firstSeen.current.clear();
      alerted.current.clear();
      return;
    }
    const tick = () => {
      const now = Date.now();
      const current = pendingRef.current;
      const sessionsDone = new Set<string>();
      for (const key of dueAgain(
        current.keys(),
        firstSeen.current,
        alerted.current,
        now,
      )) {
        const item = current.get(key);
        if (!item) {
          continue;
        }
        const looking =
          isWindowFocused() && item.session.id === activeRef.current;
        if (looking) {
          continue;
        }
        alerted.current.add(key);
        // One alert per session per tick, as the first alert does.
        if (sessionsDone.has(item.session.id)) {
          continue;
        }
        sessionsDone.add(item.session.id);
        void alertAgain(item.session, item.event);
      }
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [waiting]);
}
