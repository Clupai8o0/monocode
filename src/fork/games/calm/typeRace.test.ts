import { describe, expect, it } from "vitest";
import {
  WORD_COUNT,
  accuracy,
  applyKey,
  correctChars,
  elapsed,
  isDone,
  newRace,
  ordinal,
  place,
  progress,
  rawWpm,
  rivalChars,
  rivalFinishMs,
  setPaused,
  standings,
  totalChars,
  wpm,
  type RaceState,
} from "./typeRace";

const race = (words: string[], rivalWpm = [40, 60, 80]): RaceState => ({
  ...newRace(1, "mid"),
  words,
  rivals: rivalWpm.map((speed, at) => ({ id: (["claude", "codex", "kimi"] as const)[at]!, wpm: speed, phase: 0 })),
});

const type = (state: RaceState, text: string, now = 0) => {
  let s = state;
  for (const ch of text) {
    s = applyKey(s, ch, now);
  }
  return s;
};

describe("type race", () => {
  it("makes the right number of words and three different agents", () => {
    for (const mode of ["low", "mid", "hard"] as const) {
      const state = newRace(42, mode);
      expect(state.words).toHaveLength(WORD_COUNT[mode]);
      expect(new Set(state.rivals.map((r) => r.id)).size).toBe(3);
    }
    expect(newRace(7, "mid").words).toEqual(newRace(7, "mid").words);
  });

  it("only hard mode has capitals, numbers or punctuation", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      expect(newRace(seed, "low").words.join(" ")).toMatch(/^[a-z ]+$/);
    }
    const hard = Array.from({ length: 20 }, (_, seed) => newRace(seed, "hard").words.join(" ")).join(" ");
    expect(hard).toMatch(/[A-Z0-9,.;:?!]/);
  });

  it("the clock starts on the first letter, not before", () => {
    let s = applyKey(race(["ab", "cd"]), " ", 100);
    expect(s.startedAt).toBeNull();
    s = applyKey(s, "a", 500);
    expect(s.startedAt).toBe(500);
  });

  it("typing every word right finishes on the last letter", () => {
    const s = type(race(["ab", "cd"]), "ab cd", 0);
    expect(isDone(s)).toBe(true);
    expect(accuracy(s)).toBe(100);
    expect(correctChars(s)).toBe(totalChars(s));
    expect(progress(s)).toBe(1);
  });

  it("a wrong word can be passed with space and costs its letters", () => {
    const s = type(race(["ab", "cd", "ef"]), "ax cd ", 0);
    expect(s.index).toBe(2);
    expect(correctChars(s)).toBe(3);
    expect(accuracy(s)).toBeLessThan(100);
    expect(progress(s)).toBeCloseTo(6 / 8);
  });

  it("backspace goes back into a wrong word but not a right one", () => {
    let s = type(race(["ab", "cd", "ef"]), "ax ", 0);
    s = applyKey(s, "Backspace", 0);
    expect(s.index).toBe(0);
    expect(s.typed).toBe("ax");
    s = applyKey(s, "Backspace", 0);
    s = type(s, "b cd ", 0);
    expect(s.index).toBe(2);
    s = applyKey(s, "Backspace", 0);
    expect(s.index).toBe(2);
  });

  it("fixing a word with backspace turns it right", () => {
    let s = type(race(["ab", "cd"]), "ax", 0);
    s = applyKey(s, "Backspace", 0);
    s = type(s, "b cd", 0);
    expect(isDone(s)).toBe(true);
    expect(correctChars(s)).toBe(5);
    expect(accuracy(s)).toBe(Math.round((5 / 6) * 100));
  });

  it("space on an empty word does nothing", () => {
    const s = type(race(["ab", "cd"]), "ab  ", 0);
    expect(s.index).toBe(1);
    expect(s.typed).toBe("");
  });

  it("wpm counts right characters over the racing minutes", () => {
    let s = type(race(["hello", "world"]), "hello worl", 0);
    s = applyKey(s, "d", 6000);
    // 11 chars, 0.1 min: 11 / 5 / 0.1 = 22.
    expect(wpm(s, 99_999)).toBe(22);
    expect(rawWpm(s, 99_999)).toBe(22);
  });

  it("pauses come off the clock", () => {
    let s = applyKey(race(["abc", "d"]), "a", 0);
    s = setPaused(s, true, 1000);
    s = setPaused(s, false, 5000);
    expect(elapsed(s, 6000)).toBe(2000);
    s = setPaused(s, true, 7000);
    expect(elapsed(s, 9000)).toBe(3000);
  });

  it("agents only ever move forward, at about their speed", () => {
    const rival = { id: "claude" as const, wpm: 60, phase: 1.3 };
    let last = 0;
    for (let ms = 0; ms <= 120_000; ms += 50) {
      const chars = rivalChars(rival, ms);
      expect(chars).toBeGreaterThanOrEqual(last);
      last = chars;
    }
    // 60 wpm is 300 chars a minute, give or take the wobble.
    expect(rivalChars(rival, 60_000)).toBeGreaterThan(290);
    expect(rivalChars(rival, 60_000)).toBeLessThan(310);
  });

  it("finish times and places line up", () => {
    const s0 = race(["a".repeat(49)], [30, 60, 120]);
    const finishes = s0.rivals.map((r) => rivalFinishMs(r, s0));
    expect(finishes[0]).toBeGreaterThan(finishes[1]!);
    expect(finishes[1]).toBeGreaterThan(finishes[2]!);
    expect(rivalChars(s0.rivals[1]!, finishes[1]!)).toBeGreaterThanOrEqual(49);

    let s = applyKey(s0, "a", 0);
    s = type(s, "a".repeat(48), finishes[1]! - 100);
    expect(isDone(s)).toBe(true);
    expect(place(s, 0)).toBe(2);
    expect(standings(s, 0).map((p) => p.id)).toEqual(["kimi", "you", "codex", "claude"]);
  });

  it("ordinals read right", () => {
    expect([1, 2, 3, 4].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th"]);
  });
});
