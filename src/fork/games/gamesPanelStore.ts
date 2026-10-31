import type { AgentActivity } from "../backgroundAgents/runningAgents";

/** Fork: whether the games panel shows, and what it keeps between launches. */

const BEST_KEY = "monocode.fork.games.best";
const LAST_KEY = "monocode.fork.games.last";
const SIZE_KEY = "monocode.fork.games.size";
const FULLSCREEN_KEY = "monocode.fork.games.fullscreen";
const DOCK_KEY = "monocode.fork.games.dock";
export const DEFAULT_GAME = "blocks";

let open = false;
// Fork: side by side, the panel takes the window's right side and the app
// keeps the rest, so a chat (Dojo) and a game are both in full view.
let docked = false;
const listeners = new Set<() => void>();

function set(nextOpen: boolean, nextDocked: boolean) {
  // Hidden is never docked: the app gets its whole width back.
  const dockedNow = nextOpen && nextDocked;
  if (nextOpen === open && dockedNow === docked) {
    return;
  }
  open = nextOpen;
  docked = dockedNow;
  for (const listener of listeners) {
    listener();
  }
}

export const gamesPanel = {
  isOpen: () => open,
  isDocked: () => docked,
  toggle: () => set(!open, docked),
  hide: () => set(false, false),
  /** Docking also shows the panel; undocking leaves it floating. */
  dock: (on: boolean) => set(on || open, on),
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

export type PanelSize = { width: number; height: number };
export type PanelKind = "grid" | "table";
export type PanelSizes = Record<PanelKind, PanelSize>;

/** Fork: grid games and tables keep their own size. */
export const DEFAULT_SIZES: PanelSizes = {
  grid: { width: 600, height: 548 },
  table: { width: 720, height: 560 },
};

function isSize(value: unknown): value is PanelSize {
  if (!value || typeof value !== "object") {
    return false;
  }
  const size = value as PanelSize;
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

export function loadSizes(): PanelSizes {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_SIZES;
    }
    const saved = parsed as Partial<PanelSizes>;
    return {
      grid: isSize(saved.grid) ? saved.grid : DEFAULT_SIZES.grid,
      table: isSize(saved.table) ? saved.table : DEFAULT_SIZES.table,
    };
  } catch {
    return DEFAULT_SIZES;
  }
}

export function saveSizes(sizes: PanelSizes) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(sizes));
  } catch {
    // As above.
  }
}

export function loadFullscreen() {
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveFullscreen(on: boolean) {
  try {
    localStorage.setItem(FULLSCREEN_KEY, on ? "1" : "0");
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

/** Fork: how wide the panel is side by side, or null for the default. */
export function loadDockWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(DOCK_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveDockWidth(width: number) {
  try {
    localStorage.setItem(DOCK_KEY, String(Math.round(width)));
  } catch {
    // As above.
  }
}

/** The app keeps at least this much beside a docked panel. */
export const DOCK_APP_MIN = 480;

/**
 * A side-by-side width that leaves the app DOCK_APP_MIN where it can, and
 * never takes more than half a window too narrow for both.
 */
export function clampDockWidth(width: number, windowWidth: number, minWidth: number): number {
  const low = Math.min(minWidth, Math.floor(windowWidth / 2));
  const high = Math.max(windowWidth - DOCK_APP_MIN, Math.floor(windowWidth / 2));
  return Math.round(Math.min(Math.max(width, low), high));
}
