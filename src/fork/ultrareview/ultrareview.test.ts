import { describe, expect, it } from "vitest";
import {
  queueTerminalStartInput,
  takeTerminalStartInput,
  ultrareviewCommand,
} from "./ultrareview";

describe("ultrareviewCommand", () => {
  it("reviews the current branch when empty", () => {
    expect(ultrareviewCommand("  ")).toBe("claude ultrareview\r");
  });

  it("takes a PR number, with or without #", () => {
    expect(ultrareviewCommand("42")).toBe("claude ultrareview 42\r");
    expect(ultrareviewCommand("#42")).toBe("claude ultrareview 42\r");
  });

  it("takes a base branch", () => {
    expect(ultrareviewCommand("origin/main")).toBe(
      "claude ultrareview origin/main\r",
    );
  });

  it("refuses anything a shell would read as more than a ref", () => {
    for (const bad of ["main; rm -rf ~", "$(id)", "a b", "-x", "a..b", "`x`"]) {
      expect(ultrareviewCommand(bad)).toBeNull();
    }
  });
});

describe("terminal start input", () => {
  it("is taken once, by the terminal in the queued folder", () => {
    queueTerminalStartInput("/p", "cmd\r", 1000);
    expect(takeTerminalStartInput("/other", 1001)).toBeUndefined();
    expect(takeTerminalStartInput("/p", 1002)).toBe("cmd\r");
    expect(takeTerminalStartInput("/p", 1003)).toBeUndefined();
  });

  it("keeps two quick requests apart, oldest first", () => {
    queueTerminalStartInput("/p", "first\r", 1000);
    queueTerminalStartInput("/p", "second\r", 1001);
    expect(takeTerminalStartInput("/p", 1002)).toBe("first\r");
    expect(takeTerminalStartInput("/p", 1003)).toBe("second\r");
    expect(takeTerminalStartInput("/p", 1004)).toBeUndefined();
  });

  it("expires when no terminal claims it", () => {
    queueTerminalStartInput("/p", "cmd\r", 1000);
    expect(takeTerminalStartInput("/p", 12_000)).toBeUndefined();
    expect(takeTerminalStartInput("/p", 12_001)).toBeUndefined();
  });
});
