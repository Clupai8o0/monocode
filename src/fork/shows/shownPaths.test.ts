import { describe, expect, it } from "vitest";
import { allowShownPath, isShownAllowed, isShownPath, setShownRoot } from "./shownPaths";

describe("isShownPath", () => {
  it("is conservative until the root is known, then exact", () => {
    setShownRoot(undefined);
    expect(isShownPath("/Users/sam/Library/Caches/app/shown/m/i/a.tex")).toBe(true);
    expect(isShownPath("/Users/sam/notes/shown/a.tex")).toBe(true);
    expect(isShownPath("/Users/sam/paper.tex")).toBe(false);
    setShownRoot("/Users/sam/Library/Caches/app/shown/");
    expect(isShownPath("/Users/sam/Library/Caches/app/shown/m/i/a.tex")).toBe(true);
    expect(isShownPath("/Users/sam/notes/shown/a.tex")).toBe(false);
    expect(isShownPath("/Users/sam/Library/Caches/app/shownx/a.tex")).toBe(false);
  });
  it("remembers a click per path", () => {
    expect(isShownAllowed("/c/shown/a.docx")).toBe(false);
    allowShownPath("/c/shown/a.docx");
    expect(isShownAllowed("/c/shown/a.docx")).toBe(true);
    expect(isShownAllowed("/c/shown/b.docx")).toBe(false);
  });
});
