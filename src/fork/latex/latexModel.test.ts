import { describe, expect, it } from "vitest";
import { clampSplit, formatMillis, isTexPath, issueLabel } from "./latexModel";

describe("isTexPath", () => {
  it("matches .tex in any case only", () => {
    expect(isTexPath("/p/main.tex")).toBe(true);
    expect(isTexPath("/p/Main.TEX")).toBe(true);
    expect(isTexPath("/p/refs.bib")).toBe(false);
    expect(isTexPath("/p/tex/notes.md")).toBe(false);
  });
});

describe("clampSplit", () => {
  it("keeps both panes usable", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.01)).toBe(0.2);
    expect(clampSplit(2)).toBe(0.8);
    expect(clampSplit(Number.NaN)).toBe(0.5);
  });
});

describe("issueLabel", () => {
  const root = "/p/thesis/main.tex";
  it("shows paths relative to the root's folder", () => {
    expect(
      issueLabel({ file: "/p/thesis/ch/one.tex", line: 12, message: "" }, root),
    ).toBe("ch/one.tex:12");
  });
  it("falls back to the file name outside it", () => {
    expect(
      issueLabel({ file: "/q/style.sty", line: null, message: "" }, root),
    ).toBe("style.sty");
  });
  it("is empty without a file", () => {
    expect(issueLabel({ file: null, line: 3, message: "" }, root)).toBe("");
  });
});

describe("formatMillis", () => {
  it("switches to seconds at one second", () => {
    expect(formatMillis(420)).toBe("420 ms");
    expect(formatMillis(1530)).toBe("1.5 s");
  });
});
