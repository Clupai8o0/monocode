import { describe, expect, it } from "vitest";

import {
  rememberTerminalScroll,
  restoreTarget,
  savedTerminalScroll,
} from "@/features/terminal/terminalScroll";

describe("terminal scroll memory", () => {
  it("remembers per shell, and forgets at the end", () => {
    rememberTerminalScroll("a", 300);
    expect(savedTerminalScroll("a")).toBe(300);
    expect(savedTerminalScroll("b")).toBeNull();
    rememberTerminalScroll("a", null);
    expect(savedTerminalScroll("a")).toBeNull();
  });

  it("keeps a position of zero: the very top is a place too", () => {
    rememberTerminalScroll("top", 0);
    expect(savedTerminalScroll("top")).toBe(0);
  });

  it("forgets the oldest past its limit", () => {
    for (let index = 0; index < 20; index++) rememberTerminalScroll(`t${index}`, 1);
    expect(savedTerminalScroll("t0")).toBeNull();
    expect(savedTerminalScroll("t19")).toBe(1);
  });
});

describe("restoreTarget", () => {
  it("waits for the replay to reach the place", () => {
    expect(restoreTarget(1000, 800, 500)).toEqual({ y: 300, done: false });
    expect(restoreTarget(1000, 1500, 500)).toEqual({ y: 1000, done: true });
  });

  it("copes with content shorter than the screen", () => {
    expect(restoreTarget(1000, 100, 500)).toEqual({ y: 0, done: false });
  });
});
