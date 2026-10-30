import { describe, expect, it } from "vitest";
import {
  describeLargePaste,
  formatPasteSize,
  isLargePaste,
  LARGE_PASTE_BYTES,
  pastedFileName,
  pastedFirstLine,
  pastedTextFile,
} from "./largePaste";

describe("isLargePaste", () => {
  it("draws the line at 32 KiB, exactly", () => {
    expect(isLargePaste("x".repeat(LARGE_PASTE_BYTES - 1))).toBe(false);
    expect(isLargePaste("x".repeat(LARGE_PASTE_BYTES))).toBe(true);
  });

  it("counts bytes, so wide characters reach it sooner", () => {
    const threeBytes = "語";
    expect(isLargePaste(threeBytes.repeat(Math.ceil(LARGE_PASTE_BYTES / 3)))).toBe(
      true,
    );
    expect(isLargePaste(threeBytes.repeat(100))).toBe(false);
  });
});

describe("pastedFirstLine", () => {
  it("skips blank lines and trims", () => {
    expect(pastedFirstLine("\n\n   \n  Error: boom  \nnext")).toBe("Error: boom");
  });

  it("shortens a very long line", () => {
    const line = pastedFirstLine("a".repeat(500));
    expect(line.length).toBe(121);
    expect(line.endsWith("…")).toBe(true);
  });

  it("is empty for whitespace only", () => {
    expect(pastedFirstLine(" \n \n")).toBe("");
  });
});

describe("pastedFileName", () => {
  it("names the file after its first words", () => {
    expect(pastedFileName("Error: failed at line 12 of main")).toBe(
      "pasted-error-failed-at-line.txt",
    );
  });

  it("has a plain name when nothing is usable", () => {
    expect(pastedFileName("日本語")).toBe("pasted-text.txt");
    expect(pastedFileName("")).toBe("pasted-text.txt");
  });

  it("can't produce a path", () => {
    expect(pastedFileName("../../etc/passwd")).toBe("pasted-etc-passwd.txt");
  });
});

describe("the file and its note", () => {
  it("makes a plain text file with the exact text", async () => {
    const file = pastedTextFile("hello\nthere");
    expect(file.type).toContain("text/plain");
    expect(await file.text()).toBe("hello\nthere");
  });

  it("describes it by bytes and first line", () => {
    expect(describeLargePaste("id", "first\nsecond")).toEqual({
      attachmentId: "id",
      text: "first\nsecond",
      firstLine: "first",
      size: 12,
    });
  });

  it("formats sizes plainly", () => {
    expect(formatPasteSize(84 * 1024)).toBe("84 KB");
    expect(formatPasteSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
