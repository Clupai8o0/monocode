import { describe, expect, it } from "vitest";
import type { Habit } from "../../features/monos/model/monoHabits";
import {
  CALENDAR_WEEKS,
  dayCount,
  dayKey,
  dayLevels,
  daysFrom,
  habitsRunToday,
  habitWhen,
  mergedOn,
  monoTicker,
  shortSpan,
  streak,
  upcomingHabits,
  weeksThatFit,
  type Contribution,
  type ContributionDay,
} from "./dashboardModel";

const NOW = new Date(2026, 9, 29, 15).getTime();
const at = (daysBack: number, hour: number) =>
  new Date(2026, 9, 29 - daysBack, hour).getTime();

function item(
  kind: Contribution["kind"],
  reference: string,
  when: number,
): Contribution {
  return {
    sessionId: "s",
    kind,
    reference,
    at: when,
    additions: 10,
    deletions: 2,
  };
}

function day(commits: number): ContributionDay {
  return {
    date: "2026-01-01",
    commits,
    reviews: 0,
    opened: 0,
    merged: 0,
    additions: 0,
    deletions: 0,
  };
}

function habit(overrides: Partial<Habit>): Habit {
  return {
    id: "h",
    name: "Digest",
    instructions: "",
    schedule: { kind: "daily", time: "09:00" },
    enabled: true,
    createdAt: 0,
    nextRunAt: NOW + 3_600_000,
    ...overrides,
  } as Habit;
}

describe("daysFrom", () => {
  it("covers whole weeks from a Sunday and counts each kind", () => {
    const items = [
      item("commit", "a", at(0, 9)),
      item("commit", "b", at(0, 10)),
      item("review", "acme/app#1@x", at(0, 11)),
      item("opened", "acme/app#2", at(1, 12)),
      item("landed", "acme/app#2", at(0, 13)),
      item("merged", "acme/app#3", at(0, 14)),
      // Older than the calendar.
      item("commit", "c", at(40 * 7, 9)),
    ];
    const days = daysFrom(items, NOW);
    expect(new Date(`${days[0].date}T12:00`).getDay()).toBe(0);
    // 29 Oct 2026 is a Thursday, so the last week holds 5 days.
    expect(days).toHaveLength((CALENDAR_WEEKS - 1) * 7 + 5);
    const last = days[days.length - 1];
    expect(last.date).toBe(dayKey(NOW));
    expect([last.commits, last.reviews, last.merged]).toEqual([2, 1, 1]);
    expect([last.additions, last.deletions]).toEqual([20, 4]);
    // Landing counts toward merged pull requests, not contributions.
    expect(dayCount(last)).toBe(4);
    expect(days[days.length - 2].opened).toBe(1);
    expect(days.reduce((sum, entry) => sum + dayCount(entry), 0)).toBe(5);
    expect(mergedOn(items, dayKey(NOW))).toBe(2);
    expect(mergedOn(items, dayKey(at(1, 0)))).toBe(0);
  });

  it("gives every calendar day once across a daylight-saving change", () => {
    const days = daysFrom([], new Date(2026, 10, 3, 12).getTime());
    expect(new Set(days.map((entry) => entry.date)).size).toBe(days.length);
  });
});

it("counts a pull request merged twice over as one", () => {
  const items = [
    item("merged", "acme/app#3", at(0, 9)),
    item("landed", "acme/app#3", at(0, 10)),
  ];
  expect(mergedOn(items, dayKey(NOW))).toBe(1);
});

it("splits active days into levels by quartile", () => {
  const days = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(day);
  expect(dayLevels(days)).toEqual([0, 1, 1, 1, 2, 2, 3, 3, 4]);
  expect(dayLevels([day(0), day(0)])).toEqual([0, 0]);
  expect(dayLevels([day(3)])).toEqual([1]);
});

it("counts a streak back from today or yesterday", () => {
  const run = (counts: number[]) => streak(counts.map(day));
  expect(run([1, 0, 2, 3, 1])).toBe(3);
  expect(run([1, 2, 3, 0])).toBe(3);
  expect(run([1, 0, 0])).toBe(0);
  expect(run([])).toBe(0);
});

it("keeps the weeks a narrow panel has room for", () => {
  expect(weeksThatFit(258, 10, 8, 26)).toBe(26);
  expect(weeksThatFit(100, 10, 8, 26)).toBe(10);
  expect(weeksThatFit(1000, 10, 8, 26)).toBe(26);
  expect(weeksThatFit(0, 10, 8, 26)).toBe(1);
});

it("says spans shortly", () => {
  expect(shortSpan(30_000)).toBe("now");
  expect(shortSpan(5 * 60_000)).toBe("5m");
  expect(shortSpan(3 * 3_600_000)).toBe("3h");
  expect(shortSpan(50 * 3_600_000)).toBe("2d");
});

describe("monoTicker", () => {
  const base = { busyTitles: [], now: NOW };

  it("puts a wait for the user first", () => {
    expect(
      monoTicker({ ...base, status: "needs-you", busyTitles: ["Fix"] }),
    ).toEqual({ live: true, text: "Waiting for your input" });
  });

  it("names what it started, even while its own chat is idle", () => {
    expect(
      monoTicker({ ...base, status: "idle", busyTitles: ["Fix"] }).text,
    ).toBe("Working on Fix");
    expect(
      monoTicker({
        ...base,
        status: "working",
        busyTitles: ["Fix", "Docs", "CI"],
      }).text,
    ).toBe("Working on Fix +2 more");
  });

  it("falls back to its step, then to thinking", () => {
    expect(
      monoTicker({ ...base, status: "working", activity: "Reading" }).text,
    ).toBe("Reading");
    expect(monoTicker({ ...base, status: "working" }).text).toBe("Thinking…");
  });

  it("says when it was last active", () => {
    expect(monoTicker({ ...base, status: "idle" })).toEqual({
      live: false,
      text: "Idle",
    });
    expect(
      monoTicker({ ...base, status: "idle", lastActive: NOW - 3 * 3_600_000 })
        .text,
    ).toBe("Idle · last active 3h ago");
    expect(monoTicker({ ...base, status: "idle", lastActive: NOW }).text).toBe(
      "Idle · active just now",
    );
  });
});

describe("habits", () => {
  it("lists running habits first, then the soonest, leaving out paused ones", () => {
    const habits = [
      habit({ id: "later", nextRunAt: NOW + 9e6 }),
      habit({ id: "soon", nextRunAt: NOW + 1e6 }),
      habit({ id: "paused", enabled: false }),
      habit({ id: "running", nextRunAt: NOW + 8e6 }),
      habit({ id: "fourth", nextRunAt: NOW + 7e6 }),
    ];
    const running = (id: string) => (id === "running" ? NOW : undefined);
    expect(upcomingHabits(habits, running).map((entry) => entry.id)).toEqual([
      "running",
      "soon",
      "fourth",
    ]);
  });

  it("keeps a paused habit that is running right now", () => {
    const paused = habit({ id: "paused", enabled: false });
    expect(upcomingHabits([paused], () => NOW)).toEqual([paused]);
  });

  it("gives today's runs a time and later ones a weekday", () => {
    expect(habitWhen(habit({ nextRunAt: NOW + 3_600_000 }), NOW)).toMatch(
      / · in 1h$/,
    );
    expect(
      habitWhen(habit({ nextRunAt: new Date(2026, 9, 31, 9).getTime() }), NOW),
    ).toMatch(/· in 1d$/);
    expect(habitWhen(habit({ nextRunAt: NOW - 1000 }), NOW)).toMatch(/· soon$/);
  });

  it("counts today's runs against what is still scheduled", () => {
    const habits = [
      habit({
        id: "a",
        nextRunAt: NOW + 3_600_000,
        runs: [
          { at: at(0, 8), durationMs: 1, outcome: "quiet" },
          { at: at(1, 8), durationMs: 1, outcome: "quiet" },
        ],
      }),
      habit({ id: "b", nextRunAt: at(-2, 8) }),
      habit({ id: "c", enabled: false, nextRunAt: NOW + 3_600_000 }),
    ];
    expect(habitsRunToday(habits, NOW)).toEqual({ ran: 1, total: 2 });
  });
});
