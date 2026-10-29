import { describe, expect, it } from "vitest";
import {
  exhaustedSwitchTarget,
  pickAutoAccount,
  supportsAutoAccount,
  type AutoTone,
} from "./autoAccount";

const TONES: AutoTone[] = ["ready", "low", "checking", "unknown", "exhausted"];
const RANK: Record<AutoTone, number> = {
  ready: 0,
  low: 1,
  checking: 2,
  unknown: 2,
  exhausted: 3,
};

describe("pickAutoAccount", () => {
  it("picks by tone for every main/cx combination, ties going to main", () => {
    for (const main of TONES) {
      for (const cx of TONES) {
        const picked = pickAutoAccount(
          [
            { id: "default", tone: main },
            { id: "cx", tone: cx },
          ],
          "default",
        );
        const expected = RANK[cx] < RANK[main] ? "cx" : "default";
        expect(picked, `main=${main} cx=${cx}`).toBe(expected);
      }
    }
  });

  it("gives a tie to main wherever main sits in the list", () => {
    expect(
      pickAutoAccount(
        [
          { id: "cx", tone: "ready" },
          { id: "default", tone: "ready" },
        ],
        "default",
      ),
    ).toBe("default");
  });

  it("skips exhausted accounts unless all are, then uses main", () => {
    expect(
      pickAutoAccount(
        [
          { id: "default", tone: "exhausted" },
          { id: "cx", tone: "unknown" },
        ],
        "default",
      ),
    ).toBe("cx");
    expect(
      pickAutoAccount(
        [
          { id: "cx", tone: "exhausted" },
          { id: "default", tone: "exhausted" },
        ],
        "default",
      ),
    ).toBe("default");
  });

  it("uses the first account of the best tone when main is not in it", () => {
    expect(
      pickAutoAccount(
        [
          { id: "default", tone: "low" },
          { id: "a", tone: "ready" },
          { id: "b", tone: "ready" },
        ],
        "default",
      ),
    ).toBe("a");
    expect(pickAutoAccount([], "default")).toBeNull();
  });

  it("within one tone prefers more headroom, ties going to main", () => {
    const pick = (main: [AutoTone, number?], cx: [AutoTone, number?]) =>
      pickAutoAccount(
        [
          { id: "default", tone: main[0], headroom: main[1] },
          { id: "cx", tone: cx[0], headroom: cx[1] },
        ],
        "default",
      );
    // Same tone: more remaining % wins, either way round.
    expect(pick(["ready", 40], ["ready", 90])).toBe("cx");
    expect(pick(["ready", 90], ["ready", 40])).toBe("default");
    expect(pick(["low", 5], ["low", 15])).toBe("cx");
    expect(pick(["low", 15], ["low", 5])).toBe("default");
    // Equal headroom, or none known: main.
    expect(pick(["ready", 70], ["ready", 70])).toBe("default");
    expect(pick(["exhausted", 0], ["exhausted", 0])).toBe("default");
    expect(pick(["checking"], ["unknown"])).toBe("default");
    expect(pick(["ready", 70], ["ready"])).toBe("default");
    // Tone still beats headroom.
    expect(pick(["low", 19], ["ready", 21])).toBe("cx");
    expect(pick(["ready", 21], ["low", 19])).toBe("default");
    // Main listed second still wins a tie and loses on headroom.
    expect(
      pickAutoAccount(
        [
          { id: "cx", tone: "ready", headroom: 60 },
          { id: "default", tone: "ready", headroom: 60 },
        ],
        "default",
      ),
    ).toBe("default");
    expect(
      pickAutoAccount(
        [
          { id: "cx", tone: "ready", headroom: 80 },
          { id: "default", tone: "ready", headroom: 60 },
        ],
        "default",
      ),
    ).toBe("cx");
  });

  it("is offered for Claude only", () => {
    expect(supportsAutoAccount("claude")).toBe(true);
    expect(supportsAutoAccount("codex")).toBe(false);
  });
});

describe("exhaustedSwitchTarget", () => {
  it("offers another account with headroom, main first", () => {
    const candidates = [
      { id: "default", tone: "low" as const },
      { id: "cx", tone: "exhausted" as const },
      { id: "work", tone: "ready" as const },
    ];
    expect(exhaustedSwitchTarget("cx", candidates, "default")).toBe("work");
    expect(
      exhaustedSwitchTarget(
        "cx",
        [
          { id: "default", tone: "ready" },
          { id: "cx", tone: "exhausted" },
          { id: "work", tone: "ready" },
        ],
        "default",
      ),
    ).toBe("default");
  });

  it("offers nothing when no other account has known headroom", () => {
    expect(
      exhaustedSwitchTarget(
        "default",
        [
          { id: "default", tone: "exhausted" },
          { id: "cx", tone: "unknown" },
          { id: "b", tone: "exhausted" },
        ],
        "default",
      ),
    ).toBeNull();
  });
});
