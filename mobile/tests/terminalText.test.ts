import { describe, expect, it } from "vitest";
import {
  applySgr,
  colorValue,
  emptyTerminalText,
  feedTerminalText,
  runTextStyle,
  TERMINAL_PALETTES,
} from "@/features/terminal/terminalText";

const state = (...chunks: string[]) =>
  chunks.reduce(feedTerminalText, emptyTerminalText());
const feed = (...chunks: string[]) => state(...chunks).lines;
/** Each chunk fed one character at a time, to split every sequence. */
const trickle = (text: string) => state(...text.split(""));

describe("terminal text", () => {
  it("drops titles and bracketed-paste switches", () => {
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

  it("keeps the last two thousand lines, runs in step", () => {
    const text = state("x\n".repeat(2_500));
    expect(text.lines).toHaveLength(2_000);
    expect(text.runs).toHaveLength(2_000);
  });

  it("strips cursor positioning, the alternate screen and charset picks", () => {
    expect(feed("\x1b[?1049h\x1b[H\x1b[2J\x1b(Bhi\x1b7\x1b8\x1b=\x1b[?1049l")).toEqual([
      "hi",
    ]);
  });

  it("ignores the bell and other controls", () => {
    expect(feed("a\x07b\x00c")).toEqual(["abc"]);
  });
});

describe("line editing", () => {
  it("erases to the end of the line", () => {
    expect(feed("hello\x1b[3D\x1b[K")).toEqual(["he"]);
  });

  it("erases to the start and the whole line", () => {
    expect(feed("hello\x1b[2D\x1b[1K")).toEqual(["    o"]);
    expect(feed("hello\x1b[2Kx")).toEqual(["     x"]);
  });

  it("moves the cursor left and right within the line", () => {
    expect(feed("abc\x1b[2DX\x1b[CY")).toEqual(["aXcY"]);
    expect(feed("ab\x1b[D\x1b[DZ")).toEqual(["Zb"]);
    expect(feed("a\x1b[3Cb")).toEqual(["a   b"]);
  });

  it("deletes and inserts characters as readline does mid-line", () => {
    expect(feed("abcd\x1b[3D\x1b[P")).toEqual(["acd"]);
    expect(feed("acd\x1b[2D\x1b[@b")).toEqual(["abcd"]);
  });

  it("redraws a readline history recall", () => {
    expect(feed("$ ls -la\r$ \x1b[Kgit status")).toEqual(["$ git status"]);
  });

  it("gives the same result however the output is split", () => {
    const raw = "\x1b[1;31merr\x1b[0m ok\r\n\x1b]0;t\x07$ ab\x1b[D\x1b[K\x1b[38;2;1;2;3mz\x1b[m\n";
    const whole = state(raw);
    const split = trickle(raw);
    expect(split.lines).toEqual(whole.lines);
    expect(split.runs).toEqual(whole.runs);
    expect(split.lines).toEqual(["err ok", "$ az", ""]);
  });
});

describe("styled runs", () => {
  it("cuts a line into runs by colour", () => {
    expect(state("\x1b[32mgreen\x1b[0m plain").runs[0]).toEqual([
      { text: "green", style: { fg: 2 } },
      { text: " plain", style: null },
    ]);
  });

  it("keeps a colour across chunks and lines", () => {
    const text = state("\x1b[34ma\n", "b\x1b[39mc");
    expect(text.runs).toEqual([
      [{ text: "a", style: { fg: 4 } }],
      [
        { text: "b", style: { fg: 4 } },
        { text: "c", style: null },
      ],
    ]);
  });

  it("restyles an overwritten character", () => {
    expect(state("ab\r\x1b[1mA").runs[0]).toEqual([
      { text: "A", style: { bold: true } },
      { text: "b", style: null },
    ]);
  });

  it("splits a run's sequence anywhere and still colours it", () => {
    expect(trickle("\x1b[38;5;208mo").runs[0]).toEqual([
      { text: "o", style: { fg: 208 } },
    ]);
  });
});

describe("SGR", () => {
  it("reads the sixteen colours, bright ones too", () => {
    expect(applySgr(null, "31;42")).toEqual({ fg: 1, bg: 2 });
    expect(applySgr(null, "91;102")).toEqual({ fg: 9, bg: 10 });
  });

  it("reads 256 and true colour, in both separators", () => {
    expect(applySgr(null, "38;5;196;48;5;21")).toEqual({ fg: 196, bg: 21 });
    expect(applySgr(null, "38;2;255;128;0")).toEqual({ fg: "#ff8000" });
    expect(applySgr(null, "38:2::0:10:255")).toEqual({ fg: "#000aff" });
    expect(applySgr(null, "48:5:7")).toEqual({ bg: 7 });
  });

  it("sets and clears weights and decorations", () => {
    const on = applySgr(null, "1;2;3;4;7");
    expect(on).toEqual({ bold: true, dim: true, italic: true, underline: true, inverse: true });
    expect(applySgr(on, "22;23;24;27")).toBeNull();
  });

  it("resets on 0 and on an empty sequence", () => {
    expect(applySgr({ fg: 1, bold: true }, "0")).toBeNull();
    expect(applySgr({ fg: 1 }, "")).toBeNull();
    expect(applySgr({ fg: 1, bg: 2 }, "39")).toEqual({ bg: 2 });
  });

  it("leaves private forms alone", () => {
    const style = { fg: 3 };
    expect(applySgr(style, ">4;2")).toBe(style);
  });

  it("keeps the same style object when nothing changes", () => {
    const style = applySgr(null, "32");
    expect(applySgr(style, "32")).toBe(style);
  });
});

describe("colours", () => {
  const palette = TERMINAL_PALETTES.dark;

  it("maps the palette, the cube and the greys", () => {
    expect(colorValue(1, palette)).toBe(palette[1]);
    expect(colorValue(16, palette)).toBe("#000000");
    expect(colorValue(196, palette)).toBe("#ff0000");
    expect(colorValue(231, palette)).toBe("#ffffff");
    expect(colorValue(232, palette)).toBe("#080808");
    expect(colorValue("#123456", palette)).toBe("#123456");
  });

  it("has sixteen colours for each theme", () => {
    expect(TERMINAL_PALETTES.dark).toHaveLength(16);
    expect(TERMINAL_PALETTES.light).toHaveLength(16);
  });

  it("swaps ink and paper on inverse, against the screen's own", () => {
    const base = { content: "#eeeeee", background: "#111111" };
    expect(runTextStyle({ inverse: true }, palette, base)).toEqual({
      color: "#111111",
      backgroundColor: "#eeeeee",
    });
    expect(runTextStyle({ fg: 1, bold: true, italic: true, underline: true }, palette, base)).toEqual({
      color: palette[1],
      fontWeight: "bold",
      fontStyle: "italic",
      textDecorationLine: "underline",
    });
  });

  it("fades dim text", () => {
    const base = { content: "#eeeeee", background: "#111111" };
    expect(runTextStyle({ dim: true }, palette, base).color).toBe("#eeeeee99");
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

  it("caps cursor moves and inserts at the line's width", () => {
    const text = state("\x1b[99999C\x1b[99999@x");
    expect(Math.max(...text.lines.map((line) => line.length))).toBeLessThanOrEqual(4_096);
  });

  it("gives up on an escape that never ends", () => {
    const lines = feed(`\x1b]${"y".repeat(5_000)}`, "after");
    expect(lines.join("")).toContain("after");
  });
});
