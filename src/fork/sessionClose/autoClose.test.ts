import { describe, expect, it } from "vitest";
import {
  AUTO_CLOSE_AFTER_S,
  autoCloseKey,
  isKeptOpen,
  keepOpen,
  tickCountdown,
} from "./autoClose";

describe("autoCloseKey", () => {
  it("uses the session id and the last block's id", () => {
    expect(autoCloseKey("s", [{ id: "u" }, { id: "a" }])).toBe("s@a");
  });

  it("ends in @ when there are no blocks", () => {
    expect(autoCloseKey("s", [])).toBe("s@");
  });

  it("changes when a new last block arrives", () => {
    const before = autoCloseKey("s", [{ id: "u" }, { id: "a" }]);
    const after = autoCloseKey("s", [
      { id: "u" },
      { id: "a" },
      { id: "u2" },
    ]);
    expect(after).not.toBe(before);
  });
});

describe("keepOpen and isKeptOpen", () => {
  it("is false before and true after for that key only", () => {
    const key = "keep-open:one";
    const other = "keep-open:other";
    expect(isKeptOpen(key)).toBe(false);
    keepOpen(key);
    expect(isKeptOpen(key)).toBe(true);
    expect(isKeptOpen(other)).toBe(false);
  });
});

describe("tickCountdown", () => {
  const seen = { windowActive: true, inView: true };

  it("counts down by one when the window is active and the offer is in view", () => {
    expect(tickCountdown(20, seen)).toBe(19);
  });

  it("does not move when the window is inactive", () => {
    expect(
      tickCountdown(20, { windowActive: false, inView: true }),
    ).toBe(20);
  });

  it("does not move when the offer is out of view", () => {
    expect(
      tickCountdown(20, { windowActive: true, inView: false }),
    ).toBe(20);
  });

  it("does not move when neither is true", () => {
    expect(
      tickCountdown(20, { windowActive: false, inView: false }),
    ).toBe(20);
  });

  it("never goes below zero", () => {
    expect(tickCountdown(1, seen)).toBe(0);
    expect(tickCountdown(0, seen)).toBe(0);
  });
});

describe("AUTO_CLOSE_AFTER_S", () => {
  it("is a positive number", () => {
    expect(typeof AUTO_CLOSE_AFTER_S).toBe("number");
    expect(AUTO_CLOSE_AFTER_S).toBeGreaterThan(0);
  });
});
