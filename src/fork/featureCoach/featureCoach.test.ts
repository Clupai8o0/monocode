// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  COACH_CARDS,
  coachCounts,
  coachProgress,
  featureUses,
  followUpMarkSeen,
  markFollowUpSeen,
  pinSuggestions,
  rankCoachCards,
  recordFeatureUse,
  type CoachCounts,
} from "./featureCoach";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => localStorage.clear());

describe("feature use counter", () => {
  it("counts only the last 30 days", () => {
    recordFeatureUse("palette", NOW - 31 * DAY);
    recordFeatureUse("palette", NOW - DAY);
    recordFeatureUse("palette", NOW);
    expect(featureUses("palette", NOW)).toBe(2);
    expect(featureUses("split", NOW)).toBe(0);
  });

  it("keeps only the latest uses", () => {
    for (let i = 0; i < 150; i++) recordFeatureUse("queue", NOW);
    expect(featureUses("queue", NOW)).toBe(100);
  });

  it("survives a damaged store", () => {
    localStorage.setItem("monocode.fork.featureUse", "{broken");
    expect(featureUses("queue", NOW)).toBe(0);
    localStorage.setItem("monocode.fork.featureUse", '{"queue":"nope"}');
    expect(featureUses("queue", NOW)).toBe(0);
    recordFeatureUse("queue", NOW);
    expect(featureUses("queue", NOW)).toBe(1);
  });
});

describe("coachCounts", () => {
  it("reads sessions, with old ones falling out of the window", () => {
    const counts = coachCounts(
      [
        { id: "a", cwd: "/p", worktreeCwd: "/w", updatedAt: NOW - DAY },
        { id: "b", cwd: "/p", worktreeCwd: "/w2", updatedAt: NOW - 40 * DAY },
        { id: "c", cwd: "/p", pinned: true, updatedAt: NOW - 40 * DAY },
        { id: "d", cwd: "/p", pinned: true, archived: true, updatedAt: NOW },
        { id: "e", cwd: "/p", orchestrationLeadId: "l1", updatedAt: NOW },
        { id: "f", cwd: "/p", orchestrationLeadId: "l1", updatedAt: NOW },
      ],
      2,
      NOW,
    );
    expect(counts.worktrees).toBe(1);
    expect(counts.pinned).toBe(1);
    expect(counts.orchestration).toBe(1);
    expect(counts.habits).toBe(2);
  });
});

describe("ranking", () => {
  const zero = Object.fromEntries(
    COACH_CARDS.map((card) => [card.id, 0]),
  ) as CoachCounts;

  it("leads with the most useful when nothing is used", () => {
    expect(rankCoachCards(zero)[0].id).toBe("worktrees");
  });

  it("moves a feature back as it gets used", () => {
    const ranked = rankCoachCards({ ...zero, worktrees: 10 });
    expect(ranked[0].id).toBe("queue");
    expect(ranked.at(-1)?.id).toBe("worktrees");
  });

  it("caps progress at a full ring", () => {
    expect(coachProgress(COACH_CARDS[0], 500)).toBe(1);
    expect(coachProgress(COACH_CARDS[0], 0)).toBe(0);
  });
});

describe("pinSuggestions", () => {
  it("picks each project's busiest session, biggest first", () => {
    const picks = pinSuggestions([
      { id: "a1", cwd: "/a", additions: 10 },
      { id: "a2", cwd: "/a", additions: 50, deletions: 5 },
      { id: "b1", cwd: "/b", additions: 200 },
    ]);
    expect(picks.map((pick) => pick.id)).toEqual(["b1", "a2"]);
  });

  it("skips projects with a pin, archived and untouched sessions", () => {
    expect(
      pinSuggestions([
        { id: "a1", cwd: "/a", additions: 10 },
        { id: "a2", cwd: "/a", pinned: true },
        { id: "b1", cwd: "/b", additions: 9, archived: true },
        { id: "c1", cwd: "/c" },
        { id: "d1", cwd: "/d", additions: 9, draft: true },
      ]),
    ).toEqual([]);
  });

  it("limits how many it offers", () => {
    const many = ["/a", "/b", "/c", "/d"].map((cwd) => ({
      id: cwd,
      cwd,
      additions: 1,
    }));
    expect(pinSuggestions(many)).toHaveLength(3);
  });
});

describe("follow-up coach mark", () => {
  it("shows until it's been seen", () => {
    expect(followUpMarkSeen()).toBe(false);
    markFollowUpSeen();
    expect(followUpMarkSeen()).toBe(true);
  });
});
