import { describe, expect, it } from "vitest";
import { accuracy, applyKey, currentTarget, isDone, makeRound, newState, score, targetText, wpm, type Conflict } from "./mergeConflict";

const type = (state: ReturnType<typeof newState>, text: string, now = 0) => {
  let s = state;
  for (const ch of text) {
    s = applyKey(s, ch === "\n" ? "Enter" : ch, now);
  }
  return s;
};

const one = (rule: Conflict["rule"]): Conflict => ({ ours: "let a = 1;", theirs: "let a = 2;", rule });

describe("merge conflict", () => {
  it("targets follow the rule", () => {
    expect(targetText(one("ours"))).toBe("let a = 1;");
    expect(targetText(one("theirs"))).toBe("let a = 2;");
    expect(targetText(one("both"))).toBe("let a = 1;\nlet a = 2;");
  });

  it("typing the exact target resolves and advances", () => {
    const state = type(newState([one("both"), one("ours")]), "let a = 1;\nlet a = 2;");
    expect(state.index).toBe(1);
    expect(state.typed).toBe("");
    expect(currentTarget(state)).toBe("let a = 1;");
    expect(isDone(type(state, "let a = 1;"))).toBe(true);
  });

  it("a wrong char then backspace then the right one resolves with accuracy under 100", () => {
    let s = type(newState([one("ours")]), "let a = ");
    s = applyKey(s, "x", 0);
    s = applyKey(s, "Backspace", 0);
    s = type(s, "1;");
    expect(isDone(s)).toBe(true);
    expect(accuracy(s)).toBeLessThan(100);
  });

  it("a wrong char does not resolve", () => {
    const s = type(newState([one("ours")]), "let a = 2;");
    expect(isDone(s)).toBe(false);
  });

  it("backspace on empty is harmless", () => {
    const s = newState([one("ours")]);
    expect(applyKey(s, "Backspace", 5)).toBe(s);
  });

  it("wpm uses correct chars over five per minute on a fixed clock", () => {
    // 50 correct chars in 60s is 10 wpm.
    const long = { ours: "a".repeat(50), theirs: "b", rule: "ours" as const };
    const s = applyKey(newState([long]), "a", 1000);
    const half = type(s, "a".repeat(24), 1000);
    expect(half.correctChars).toBe(25);
    expect(wpm(half, 31_000)).toBe(10);
    const done = type(half, "a".repeat(25), 61_000);
    expect(done.endedAt).toBe(61_000);
    expect(wpm(done, 999_999)).toBe(10);
    expect(score(10, 90)).toBe(9);
  });

  it("low mode never produces keep both", () => {
    for (let seed = 0; seed < 200; seed++) {
      expect(makeRound(seed, "low").every((c) => c.rule !== "both")).toBe(true);
    }
  });

  it("rounds are five long, deterministic, and mid/hard can keep both", () => {
    expect(makeRound(7, "mid")).toEqual(makeRound(7, "mid"));
    expect(makeRound(7, "hard")).toHaveLength(5);
    expect(makeRound(1, "low")).not.toEqual(makeRound(2, "low"));
    const all = Array.from({ length: 50 }, (_, i) => makeRound(i, "hard")).flat();
    expect(all.some((c) => c.rule === "both")).toBe(true);
  });
});
