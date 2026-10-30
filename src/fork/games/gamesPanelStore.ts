import type { AgentActivity } from "../backgroundAgents/runningAgents";

/** Fork: whether the games panel shows, and what it keeps between launches. */

const BEST_KEY = "monocode.fork.games.best";
const LAST_KEY = "monocode.fork.games.last";
export const DEFAULT_GAME = "blocks";

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  if (next === open) {
    return;
  }
  open = next;
  for (const listener of listeners) {
    listener();
  }
}

export const gamesPanel = {
  isOpen: () => open,
  toggle: () => setOpen(!open),
  hide: () => setOpen(false),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export type BestScores = Record<string, number>;

export function loadBest(): BestScores {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as BestScores) : {};
  } catch {
    return {};
  }
}

export function saveBest(best: BestScores) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // Scores are a nicety; a full or blocked store just forgets them.
  }
}

export function loadLastGame(known: readonly string[]) {
  try {
    const last = localStorage.getItem(LAST_KEY);
    return last && known.includes(last) ? last : DEFAULT_GAME;
  } catch {
    return DEFAULT_GAME;
  }
}

export function saveLastGame(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // As above.
  }
}

/** "2 agents working · 1 needs you", or "" when nothing is going on. */
export function activityLabel({ working, waiting }: AgentActivity) {
  const parts: string[] = [];
  if (working) {
    parts.push(`${working} ${working === 1 ? "agent" : "agents"} working`);
  }
  if (waiting) {
    parts.push(`${waiting} ${waiting === 1 ? "needs" : "need"} you`);
  }
  return parts.join(" · ");
}

/**
 * The notice worth stopping a game for, going from one reading to the next.
 * Someone waiting outranks everything finishing.
 */
export function activityNotice(
  before: AgentActivity,
  after: AgentActivity,
): string | null {
  if (after.waiting > before.waiting) {
    return "An agent needs you";
  }
  if (before.working > 0 && after.working === 0 && after.waiting === 0) {
    return "Agents finished";
  }
  return null;
}
