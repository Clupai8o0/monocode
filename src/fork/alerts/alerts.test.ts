import { describe, expect, it } from "vitest";
import { dueAgain, NEEDS_AGAIN_MS } from "./needsAgain";
import {
  needsCount,
  setNeedsCount,
  subscribeNeedsCount,
  titleWithNeeds,
} from "./needsCount";

describe("dueAgain", () => {
  it("fires once per request after 5 minutes, then drops answered ones", () => {
    const seen = new Map<string, number>();
    const alerted = new Set<string>();
    expect(dueAgain(["a"], seen, alerted, 0)).toEqual([]);
    expect(dueAgain(["a", "b"], seen, alerted, 60_000)).toEqual([]);
    expect(dueAgain(["a", "b"], seen, alerted, NEEDS_AGAIN_MS)).toEqual(["a"]);
    alerted.add("a");
    expect(dueAgain(["a", "b"], seen, alerted, NEEDS_AGAIN_MS + 1)).toEqual([]);
    expect(
      dueAgain(["a", "b"], seen, alerted, NEEDS_AGAIN_MS + 60_000),
    ).toEqual(["b"]);
    // "a" answered: forgotten, so a new request with the same key starts over.
    expect(dueAgain(["b"], seen, alerted, NEEDS_AGAIN_MS + 61_000)).toEqual([
      "b",
    ]);
    expect(seen.has("a")).toBe(false);
    expect(alerted.has("a")).toBe(false);
  });

  it("keeps a skipped request due until the caller marks it", () => {
    const seen = new Map([["a", 0]]);
    const alerted = new Set<string>();
    expect(dueAgain(["a"], seen, alerted, NEEDS_AGAIN_MS)).toEqual(["a"]);
    expect(dueAgain(["a"], seen, alerted, NEEDS_AGAIN_MS + 15_000)).toEqual([
      "a",
    ]);
  });
});

describe("window title count", () => {
  it("puts the count in front, only when something waits", () => {
    expect(titleWithNeeds("app — MonoCode", 0)).toBe("app — MonoCode");
    expect(titleWithNeeds("app — MonoCode", 1)).toBe(
      "1 needs you · app — MonoCode",
    );
    expect(titleWithNeeds("MonoCode", 3)).toBe("3 need you · MonoCode");
  });

  it("tells listeners only when the count changes", () => {
    let calls = 0;
    const off = subscribeNeedsCount(() => {
      calls += 1;
    });
    setNeedsCount(2);
    setNeedsCount(2);
    setNeedsCount(0);
    off();
    setNeedsCount(5);
    expect(calls).toBe(2);
    expect(needsCount()).toBe(5);
    setNeedsCount(0);
  });
});
