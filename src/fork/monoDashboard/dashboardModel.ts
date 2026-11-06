/**
 * Fork feature: the sums behind a Mono's Overview tab, ported from upstream's
 * native app (`crates/monocode-gpui/src/monos/dashboard.rs`).
 */
import type { Habit } from "../../features/monos/model/monoHabits";

export type ContributionKind =
  "commit" | "review" | "opened" | "merged" | "landed";

/** What `fork_mono_contributions` found one session doing. */
export type Contribution = {
  sessionId: string;
  kind: ContributionKind;
  /** A commit id, a pull request, or a review of one. */
  reference: string;
  at: number;
  additions: number;
  deletions: number;
};

export type MonoContributions = {
  contributions: Contribution[];
  sessions: { id: string; updatedAt: number }[];
};

export type ContributionDay = {
  /** Local date, as YYYY-MM-DD. */
  date: string;
  commits: number;
  reviews: number;
  opened: number;
  merged: number;
  additions: number;
  deletions: number;
};

/** Weeks the calendar can show; a narrow panel keeps the latest. */
export const CALENDAR_WEEKS = 26;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function dayKey(at: Date | number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Midnight on the Sunday that opens the calendar's first week. */
export function firstDay(now: number): Date {
  const today = new Date(now);
  return new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - today.getDay() - (CALENDAR_WEEKS - 1) * 7,
  );
}

/** Every day from the calendar's first Sunday through today. */
export function daysFrom(
  items: readonly Contribution[],
  now: number,
): ContributionDay[] {
  const start = firstDay(now);
  const today = dayKey(now);
  const days: ContributionDay[] = [];
  const byDate = new Map<string, ContributionDay>();
  for (let offset = 0; ; offset += 1) {
    // Built from the calendar date, so a daylight-saving day is still one day.
    const date = dayKey(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset),
    );
    const day: ContributionDay = {
      date,
      commits: 0,
      reviews: 0,
      opened: 0,
      merged: 0,
      additions: 0,
      deletions: 0,
    };
    days.push(day);
    byDate.set(date, day);
    if (date === today) break;
  }
  for (const item of items) {
    const day = byDate.get(dayKey(item.at));
    if (!day) continue;
    switch (item.kind) {
      case "commit":
        day.commits += 1;
        day.additions += item.additions;
        day.deletions += item.deletions;
        break;
      case "review":
        day.reviews += 1;
        break;
      case "opened":
        day.opened += 1;
        break;
      case "merged":
        day.merged += 1;
        break;
      case "landed":
        // Counts toward merged pull requests, not toward contributions.
        break;
    }
  }
  return days;
}

/** Commits, reviews, and pull requests opened or merged count once; lines never. */
export function dayCount(day: ContributionDay): number {
  return day.commits + day.reviews + day.opened + day.merged;
}

/** Distinct pull requests merged on a day, by the Mono or after it opened them. */
export function mergedOn(items: readonly Contribution[], date: string): number {
  const merged = items.filter(
    (item) =>
      (item.kind === "merged" || item.kind === "landed") &&
      dayKey(item.at) === date,
  );
  return new Set(merged.map((item) => item.reference)).size;
}

/**
 * Calendar intensity: 0 for an empty day, 1 to 4 by quartile of the Mono's own
 * active days, so a quiet Mono still shows contrast.
 */
export function dayLevels(days: readonly ContributionDay[]): number[] {
  const active = days
    .map(dayCount)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  const at = (quartile: number) =>
    active[Math.min(Math.floor(active.length * quartile), active.length - 1)] ??
    0;
  const cuts = [at(0.25), at(0.5), at(0.75)];
  return days.map((day) => {
    const count = dayCount(day);
    if (count === 0) return 0;
    return 1 + cuts.filter((cut) => count > cut).length;
  });
}

/** Consecutive days with a contribution, ending today or yesterday. */
export function streak(days: readonly ContributionDay[]): number {
  let index = days.length - 1;
  // Today still counts as open until it ends.
  if (index >= 0 && dayCount(days[index]) === 0) index -= 1;
  let length = 0;
  while (index >= 0 && dayCount(days[index]) > 0) {
    length += 1;
    index -= 1;
  }
  return length;
}

/** Whole weeks that fit a width, always at least one. */
export function weeksThatFit(
  width: number,
  pitch: number,
  square: number,
  total: number,
): number {
  const fits = Math.floor((width + pitch - square) / pitch);
  return Math.max(1, Math.min(fits, total));
}

/** "now", "5m", "3h", "2d". */
export function shortSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type Ticker = { live: boolean; text: string };

/** The line under a Mono's name: what it is doing right now. */
export function monoTicker({
  status,
  activity,
  busyTitles,
  lastActive,
  now,
}: {
  status: "working" | "needs-you" | "idle";
  activity?: string;
  /** Sessions it started that are running. */
  busyTitles: readonly string[];
  lastActive?: number;
  now: number;
}): Ticker {
  if (status === "needs-you") {
    return { live: true, text: "Waiting for your input" };
  }
  if (busyTitles.length > 1) {
    return {
      live: true,
      text: `Working on ${busyTitles[0]} +${busyTitles.length - 1} more`,
    };
  }
  if (busyTitles.length === 1) {
    return { live: true, text: `Working on ${busyTitles[0]}` };
  }
  if (status === "working") {
    return { live: true, text: activity?.trim() || "Thinking…" };
  }
  if (!lastActive) return { live: false, text: "Idle" };
  const span = shortSpan(now - lastActive);
  return {
    live: false,
    text:
      span === "now"
        ? "Idle · active just now"
        : `Idle · last active ${span} ago`,
  };
}

/** The soonest scheduled habits, running ones first. */
export function upcomingHabits(
  habits: readonly Habit[],
  runningSince: (habitId: string) => number | undefined,
  count = 3,
): Habit[] {
  return habits
    .filter((habit) => habit.enabled || runningSince(habit.id) != null)
    .sort((a, b) => {
      const running =
        Number(runningSince(b.id) != null) - Number(runningSince(a.id) != null);
      return running || a.nextRunAt - b.nextRunAt;
    })
    .slice(0, count);
}

/** When a habit next runs: today's by time, later ones by weekday. */
export function habitWhen(habit: Habit, now: number): string {
  const at = new Date(habit.nextRunAt);
  const day =
    dayKey(at) === dayKey(now)
      ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleDateString(undefined, { weekday: "short" });
  const span = shortSpan(Math.max(0, habit.nextRunAt - now));
  return span === "now" ? `${day} · soon` : `${day} · in ${span}`;
}

/** Habit runs so far today, and the runs still scheduled for today. */
export function habitsRunToday(
  habits: readonly Habit[],
  now: number,
): { ran: number; total: number } {
  const today = dayKey(now);
  let ran = 0;
  let still = 0;
  for (const habit of habits) {
    ran += (habit.runs ?? []).filter((run) => dayKey(run.at) === today).length;
    if (
      habit.enabled &&
      habit.nextRunAt > now &&
      dayKey(habit.nextRunAt) === today
    ) {
      still += 1;
    }
  }
  return { ran, total: ran + still };
}
