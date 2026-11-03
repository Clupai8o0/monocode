import type { Session } from "../../features/sessions/model/session";

/** Fork: keep turn timing available without loading a game's rules or saves. */
export type LiveTurn = {
  sessionId: string;
  title: string;
  startedAt: number;
  knownStart: boolean;
};

type Listener = (live: LiveTurn[], finished: Set<string>, now: number) => void;
let live: LiveTurn[] = [];
let seen = false;
const listeners = new Set<Listener>();

export function liveTurns()
{
  return live;
}

export function subscribeTurns(listener: Listener)
{
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetLiveTurns()
{
  live = [];
  seen = false;
}

export function publishTurns(
  sessions: readonly (Pick<Session, "id" | "title" | "busy"> &
    Partial<Pick<Session, "ephemeral" | "inboxAsk" | "sidebarHidden">>)[],
  now: number = Date.now(),
)
{
  const before = new Map(live.map((turn) => [turn.sessionId, turn]));
  const next: LiveTurn[] = [];
  const finished = new Set<string>();
  for (const session of sessions) {
    if (session.ephemeral || session.inboxAsk || session.sidebarHidden) {
      continue;
    }
    if (!session.busy) {
      finished.add(session.id);
      continue;
    }
    const known = before.get(session.id);
    next.push(known ? { ...known, title: session.title || known.title } : {
      sessionId: session.id,
      title: session.title || "Untitled",
      startedAt: now,
      knownStart: seen,
    });
  }
  seen = true;
  live = next;
  for (const listener of listeners) {
    listener(live, finished, now);
  }
}
