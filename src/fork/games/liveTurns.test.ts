import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  });
});

it("keeps exact turn timing before the betting game is loaded", async () => {
  const { publishTurns } = await import("./liveTurns");
  publishTurns([], 0);
  publishTurns([{ id: "a", title: "Build", busy: true }], 1000);
  const { turnBetSnapshot, placeBet } = await import("./calm/turnBet");
  expect(turnBetSnapshot().live).toEqual([
    { sessionId: "a", title: "Build", startedAt: 1000, knownStart: true },
  ]);
  expect(placeBet("a", 60_000, "mid", 1000)).toBe(true);
  publishTurns([{ id: "a", title: "Build", busy: false }], 61_000);
  expect(turnBetSnapshot().record.points).toBe(100);
});

it("does not turn an already running session into a known start on lazy load", async () => {
  const { publishTurns } = await import("./liveTurns");
  publishTurns([{ id: "a", title: "Build", busy: true }], 1000);
  const { placeBet } = await import("./calm/turnBet");
  expect(placeBet("a", 60_000, "mid", 2000)).toBe(false);
});
