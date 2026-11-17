import { useEffect, useRef } from "react";
import type { Session } from "../../features/sessions/model/session";
import {
  earlyCompactDue,
  noteEarlyCompactTried,
  noteTurnEnded,
} from "./idleCompact";

const CHECK_MS = 60_000;

/**
 * Fork: records when each Claude turn ends (the cache's last refresh) and, in
 * "Before the cache expires" mode, compacts big idle threads shortly before
 * their cache runs out, while reading the history is still cheap.
 */
export function useIdleCompact(
  sessions: readonly Session[],
  options: {
    sessionsRef: { current: readonly Session[] };
    compact: (sessionId: string) => boolean;
    /** Monos, habit runs, workers, moved or remote sessions: never compacted by the app. */
    skip: (session: Session) => boolean;
  },
) {
  const busy = useRef(new Map<string, boolean>());
  useEffect(() => {
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const was = busy.current.get(session.id);
      if (was && !session.busy && session.harness === "claude") {
        noteTurnEnded(session.id);
      }
      busy.current.set(session.id, !!session.busy);
    }
    for (const id of [...busy.current.keys()]) {
      if (!seen.has(id)) busy.current.delete(id);
    }
  }, [sessions]);

  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const check = () => {
      const { sessionsRef, compact, skip } = latest.current;
      const now = Date.now();
      for (const session of sessionsRef.current) {
        if (!earlyCompactDue(session, now) || skip(session)) continue;
        noteEarlyCompactTried(session.id);
        compact(session.id);
      }
    };
    const timer = window.setInterval(check, CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
