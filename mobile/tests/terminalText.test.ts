import { describe, expect, it } from "vitest";
import {
  emptyTerminalText,
  feedTerminalText,
} from "@/features/terminal/terminalText";

const feed = (...chunks: string[]) =>
  chunks.reduce(feedTerminalText, emptyTerminalText()).lines;

describe("terminal text", () => {
  it("drops colours, titles and bracketed-paste switches", () => {
    expect(
      feed(
        "\x1b]0;title\x07\x1b[?2004h\x1b[32muser@host\x1b[0m:~$ ls\r\n",
        "a.txt\x1b]3008;end=1\x1b\\\n",
      ),
    ).toEqual(["user@host:~$ ls", "a.txt", ""]);
  });

  it("holds a sequence split between two chunks", () => {
    expect(feed("red: \x1b[3", "1mhot\x1b", "[0m done")).toEqual([
      "red: hot done",
    ]);
  });

  it("rewrites the line on carriage return and backspace", () => {
    expect(feed("50%\r100%\n", "abc\b\bX")).toEqual(["100%", "aXc"]);
  });

  it("expands tabs to the next stop", () => {
    expect(feed("a\tb")).toEqual(["a       b"]);
  });

  it("keeps the last two thousand lines", () => {
    const lines = feed("x\n".repeat(2_500));
    expect(lines).toHaveLength(2_000);
  });
});

describe("terminal text limits", () => {
  it("wraps a line with no newline so it cannot grow without end", () => {
    const lines = feed("x".repeat(10_000));
    expect(lines.every((line) => line.length <= 4_096)).toBe(true);
    expect(lines.join("")).toHaveLength(10_000);
  });

  it("wraps a line of tabs too", () => {
    const lines = feed("\t".repeat(40_000));
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(4_096);
  });

  it("gives up on an escape that never ends", () => {
    const lines = feed(`\x1b]${"y".repeat(5_000)}`, "after");
    expect(lines.join("")).toContain("after");
  });
});
