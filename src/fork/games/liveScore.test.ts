import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushBest,
  liveScore,
  reportScore,
  resetLiveScoreForTest,
  subscribeLiveScore,
} from "./liveScore";

const BEST_KEY = "monocode.fork.games.best";

describe("liveScore", () => {
  const saved = new Map<string, string>();
  const save = vi.fn((key: string, value: string) => {
    saved.set(key, value);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    saved.clear();
    save.mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: save,
    });
    resetLiveScoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tells listeners about a change and nothing else", () => {
    const heard = vi.fn();
    subscribeLiveScore(heard);
    reportScore("blocks", 10, 0);
    reportScore("blocks", 10, 0);
    expect(heard).toHaveBeenCalledTimes(1);
    reportScore("blocks", 5, 0);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("keeps a best per game, and a lower score leaves it", () => {
    reportScore("blocks", 10, 0);
    reportScore("snake", 3, 0);
    reportScore("blocks", 4, 0);
    expect(liveScore().best).toEqual({ blocks: 10, snake: 3 });
  });

  it("writes a run of records to disk at most once a second", () => {
    for (let score = 1; score <= 50; score += 1) {
      reportScore("sand", score, 0);
    }
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saved.get(BEST_KEY)!)).toEqual({ sand: 50 });
  });

  it("flushes a waiting best at once, and flushing twice writes once", () => {
    reportScore("rain", 7, 3);
    flushBest();
    flushBest();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
