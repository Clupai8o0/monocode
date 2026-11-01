import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_POINTS,
  MIN_AHEAD_MS,
  firstGuess,
  formatDuration,
  placeBet,
  publishTurns,
  resetTurnBet,
  scoreBet,
  stepGuess,
  turnBetSnapshot,
} from "./turnBet";

const session = (id: string, busy: boolean, title = id) => ({ id, title, busy });

describe("turn bet scoring", () => {
  it("pays in full for an exact guess placed at the start", () => {
    expect(scoreBet({ guessMs: 60_000, placedAfterMs: 0, mode: "mid" }, 60_000)).toBe(MAX_POINTS);
  });

  it("treats twice as long like half as long, and pays nothing past the tolerance", () => {
    const long = scoreBet({ guessMs: 60_000, placedAfterMs: 0, mode: "low" }, 120_000);
    const short = scoreBet({ guessMs: 60_000, placedAfterMs: 0, mode: "low" }, 30_000);
    expect(long).toBe(short);
    expect(long).toBeGreaterThan(0);
    expect(scoreBet({ guessMs: 60_000, placedAfterMs: 0, mode: "mid" }, 120_000)).toBe(0);
  });

  it("pays less the later the bet went down, but never nothing for a good late guess", () => {
    const early = scoreBet({ guessMs: 100_000, placedAfterMs: 0, mode: "mid" }, 100_000);
    const half = scoreBet({ guessMs: 100_000, placedAfterMs: 50_000, mode: "mid" }, 100_000);
    const late = scoreBet({ guessMs: 100_000, placedAfterMs: 99_000, mode: "mid" }, 100_000);
    expect(early).toBe(100);
    expect(half).toBe(50);
    expect(late).toBe(10);
  });

  it("steps guesses on a log scale and never below what has already gone", () => {
    expect(stepGuess(60_000, 1, 0)).toBe(75_000);
    expect(stepGuess(10_000, -1, 30_000)).toBe(30_000 + MIN_AHEAD_MS);
    expect(firstGuess(0)).toBe(60_000);
    expect(firstGuess(90_000)).toBe(180_000);
  });

  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });
});

describe("turn bet store", () => {
  beforeEach(() => {
    // A fresh store each time; vitest's node environment has none of its own.
    const items = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    resetTurnBet();
  });

  it("won't take bets on a turn that was running before it was first seen", () => {
    publishTurns([session("a", true)], 0);
    expect(turnBetSnapshot().live[0]?.knownStart).toBe(false);
    expect(placeBet("a", 60_000, "mid", 1_000)).toBe(false);
  });

  it("settles a bet when its turn ends, and keeps the tally", () => {
    publishTurns([session("a", false)], 0);
    publishTurns([session("a", true, "Fix login")], 1_000);
    expect(placeBet("a", 60_000, "mid", 1_000)).toBe(true);
    // One bet per turn.
    expect(placeBet("a", 90_000, "mid", 2_000)).toBe(false);
    publishTurns([session("a", true, "Fix login")], 30_000);
    expect(turnBetSnapshot().bets).toHaveLength(1);
    publishTurns([session("a", false, "Fix login")], 61_000);
    const { bets, record, live } = turnBetSnapshot();
    expect(bets).toHaveLength(0);
    expect(live).toHaveLength(0);
    expect(record.bets).toBe(1);
    expect(record.points).toBe(MAX_POINTS);
    expect(record.recent[0]).toMatchObject({ title: "Fix login", guessMs: 60_000, actualMs: 60_000 });
    // The tally outlives a restart.
    resetTurnBet();
    expect(turnBetSnapshot().record.points).toBe(MAX_POINTS);
  });

  it("refuses a guess shorter than the turn has already run", () => {
    publishTurns([], 0);
    publishTurns([session("a", true)], 0);
    expect(placeBet("a", 20_000, "mid", 30_000)).toBe(false);
    expect(placeBet("a", 40_000, "mid", 30_000)).toBe(true);
  });

  it("drops a bet whose session disappears without settling it", () => {
    publishTurns([], 0);
    publishTurns([session("a", true)], 0);
    placeBet("a", 60_000, "mid", 0);
    publishTurns([], 10_000);
    expect(turnBetSnapshot().bets).toHaveLength(0);
    expect(turnBetSnapshot().record.bets).toBe(1);
  });

  it("leaves out hidden and throwaway sessions", () => {
    publishTurns([], 0);
    publishTurns([{ ...session("a", true), ephemeral: true }, { ...session("b", true), sidebarHidden: true }], 0);
    expect(turnBetSnapshot().live).toHaveLength(0);
  });
});
