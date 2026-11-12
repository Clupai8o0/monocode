/**
 * Fork: Project home inside an empty chat. A new chat on a project shows that
 * project's home (roadmap, what needs you, recent chats) around its composer,
 * so the home is the default first screen. App registers the data and actions
 * the home needs here; the empty chat reads them.
 */
import { useSyncExternalStore } from "react";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import type { Session } from "../../features/sessions/model/session";

export type HomeInlineData = {
  sessions: Session[];
  summaries: readonly SessionSummary[];
  unseenIds: ReadonlySet<string>;
  onOpenChat: (sessionId: string) => void;
  onOpenProjectHome: (cwd: string) => void;
  onOpenAllProjects: () => void;
  onOpenFile: (path: string) => void;
};

let data: HomeInlineData | null = null;
let latest: HomeInlineData | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
/**
 * Sessions change on every streamed token; the home only needs to keep up
 * at about this pace.
 */
const THROTTLE_MS = 1000;

function publish() {
  timer = undefined;
  if (latest === data) {
    return;
  }
  data = latest;
  for (const listener of listeners) {
    listener();
  }
}

/** App sets this each time it changes; null turns the inline home off. */
export function setHomeInlineData(next: HomeInlineData | null) {
  latest = next;
  // Turning it on or off shows at once; changes after that are throttled.
  if (next === null || data === null) {
    clearTimeout(timer);
    publish();
    return;
  }
  timer ??= setTimeout(publish, THROTTLE_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What the empty chats show now. */
export function homeInlineData(): HomeInlineData | null {
  return data;
}

export function useHomeInlineData(): HomeInlineData | null {
  return useSyncExternalStore(subscribe, homeInlineData, homeInlineData);
}
