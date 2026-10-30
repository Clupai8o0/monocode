/**
 * Fork feature: teaches the features the owner hasn't picked up. In three
 * weeks of parallel work the local database showed no worktrees, pins,
 * orchestration runs or queued follow-ups. Everything here is local: session
 * summaries the app already has, plus a small counter for the rest.
 */

export type CoachFeatureId =
  | "worktrees"
  | "queue"
  | "pinned"
  | "quick-composer"
  | "orchestration"
  | "habits"
  | "split"
  | "palette";

export type CountedFeature = "queue" | "quick-composer" | "split" | "palette";

const USE_KEY = "monocode.fork.featureUse";
const FOLLOW_UP_MARK_KEY = "monocode.fork.coach.followUpSeen";
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Enough to fill any ring; older uses fall off the front. */
const MAX_KEPT = 100;

type UseLog = Partial<Record<CountedFeature, number[]>>;

function readUses(): UseLog {
  try {
    const parsed = JSON.parse(localStorage.getItem(USE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as UseLog) : {};
  } catch {
    return {};
  }
}

export function recordFeatureUse(feature: CountedFeature, now = Date.now()) {
  try {
    const uses = readUses();
    const list = Array.isArray(uses[feature]) ? uses[feature] : [];
    uses[feature] = [...list, now].slice(-MAX_KEPT);
    localStorage.setItem(USE_KEY, JSON.stringify(uses));
  } catch {
    // Counting is a nicety; never let it get in the way of the action.
  }
}

export function featureUses(feature: CountedFeature, now = Date.now()): number {
  const list = readUses()[feature];
  if (!Array.isArray(list)) return 0;
  return list.filter((at) => typeof at === "number" && now - at < WINDOW_MS)
    .length;
}

/** The fields of a saved or open session that the coach reads. */
export type CoachSession = {
  id: string;
  cwd: string;
  title?: string;
  worktreeCwd?: string;
  pinned?: boolean;
  archived?: boolean;
  draft?: boolean;
  orchestrationLeadId?: string;
  additions?: number;
  deletions?: number;
  createdAt?: number;
  updatedAt?: number;
};

export type CoachCounts = Record<CoachFeatureId, number>;

export function coachCounts(
  sessions: readonly CoachSession[],
  habits: number,
  now = Date.now(),
): CoachCounts {
  const recent = sessions.filter(
    (session) => now - (session.updatedAt ?? session.createdAt ?? 0) < WINDOW_MS,
  );
  return {
    worktrees: recent.filter((session) => session.worktreeCwd).length,
    pinned: sessions.filter((session) => session.pinned && !session.archived)
      .length,
    orchestration: new Set(
      recent.flatMap((session) =>
        session.orchestrationLeadId ? [session.orchestrationLeadId] : [],
      ),
    ).size,
    habits,
    queue: featureUses("queue", now),
    "quick-composer": featureUses("quick-composer", now),
    split: featureUses("split", now),
    palette: featureUses("palette", now),
  };
}

export type CoachCard = {
  id: CoachFeatureId;
  label: string;
  why: string;
  /** What the count means, for the line under the ring. */
  unit: string;
  /** The count that fills the ring: a habit formed, not a target to hit. */
  goal: number;
  /** Higher comes first among features at the same progress. */
  value: number;
};

export const COACH_CARDS: readonly CoachCard[] = [
  {
    id: "worktrees",
    label: "Worktrees",
    why: "You run sessions side by side. Give each its own copy of the project and they can't overwrite each other.",
    unit: "sessions in 30 days",
    goal: 10,
    value: 8,
  },
  {
    id: "queue",
    label: "Queue or steer follow-ups",
    why: "Have another thought while the agent works? Line it up for later, or steer the agent now, without stopping it.",
    unit: "follow-ups in 30 days",
    goal: 10,
    value: 7,
  },
  {
    id: "orchestration",
    label: "Orchestration",
    why: "Split a big job across several agents that report back to one lead, instead of juggling the sessions yourself.",
    unit: "runs in 30 days",
    goal: 3,
    value: 6,
  },
  {
    id: "habits",
    label: "Mono habits",
    why: "Let a Mono do the weekly chores on its own, and hear from it only when there's something worth saying.",
    unit: "habits set up",
    goal: 2,
    value: 5,
  },
  {
    id: "pinned",
    label: "Pinned sessions",
    why: "Keep the session you return to most at the top of its project, so you stop scrolling for it.",
    unit: "pinned now",
    goal: 3,
    value: 4,
  },
  {
    id: "quick-composer",
    label: "Quick composer",
    why: "Start a task from anywhere with a shortcut, without switching to MonoCode first.",
    unit: "uses in 30 days",
    goal: 5,
    value: 3,
  },
  {
    id: "split",
    label: "Split panes",
    why: "Watch two sessions at once, instead of flipping between tabs to see who finished.",
    unit: "splits in 30 days",
    goal: 10,
    value: 2,
  },
  {
    id: "palette",
    label: "Command palette",
    why: "Reach any command from the keyboard, without hunting through menus.",
    unit: "opens in 30 days",
    goal: 10,
    value: 1,
  },
];

export const coachProgress = (card: CoachCard, count: number) =>
  Math.min(1, Math.max(0, count / card.goal));

/** Least used first; the most useful one wins a tie. */
export function rankCoachCards(counts: CoachCounts): CoachCard[] {
  return [...COACH_CARDS].sort(
    (a, b) =>
      coachProgress(a, counts[a.id]) - coachProgress(b, counts[b.id]) ||
      b.value - a.value,
  );
}

/**
 * The session to suggest pinning in each project: the one with the most
 * changed lines, the closest thing the summaries have to "used most". A
 * project that already has a pin has made its choice.
 */
export function pinSuggestions(
  sessions: readonly CoachSession[],
  limit = 3,
): CoachSession[] {
  const projects = new Map<string, CoachSession[]>();
  for (const session of sessions) {
    if (session.archived || session.draft) continue;
    projects.set(session.cwd, [...(projects.get(session.cwd) ?? []), session]);
  }
  const weight = (session: CoachSession) =>
    (session.additions ?? 0) + (session.deletions ?? 0);
  const picks: CoachSession[] = [];
  for (const list of projects.values()) {
    if (list.some((session) => session.pinned)) continue;
    const best = list.reduce((top, session) =>
      weight(session) > weight(top) ||
      (weight(session) === weight(top) &&
        (session.updatedAt ?? 0) > (top.updatedAt ?? 0))
        ? session
        : top,
    );
    if (weight(best) > 0) picks.push(best);
  }
  return picks.sort((a, b) => weight(b) - weight(a)).slice(0, limit);
}

export function followUpMarkSeen(): boolean {
  try {
    return localStorage.getItem(FOLLOW_UP_MARK_KEY) === "1";
  } catch {
    return true;
  }
}

export function markFollowUpSeen() {
  try {
    localStorage.setItem(FOLLOW_UP_MARK_KEY, "1");
  } catch {
    // The mark may come back next run; nothing breaks.
  }
}

/** App registers what the panel's buttons can do; Settings gets no new props. */
export type CoachHost = {
  sessions: () => CoachSession[];
  openSettings: (section: "worktrees" | "general" | "chat", anchor?: string) => void;
  /** Opens a new session with this already typed in its composer. */
  newSessionWith: (draft: string) => void;
  openPalette: () => void;
  split: () => void;
  pin: (sessionId: string) => Promise<unknown> | void;
};

let host: CoachHost | null = null;

export function registerCoachHost(next: CoachHost | null) {
  host = next;
}

export const coachHost = () => host;
