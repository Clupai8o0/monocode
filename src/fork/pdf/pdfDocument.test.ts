import { describe, expect, it } from "vitest";
import { isPdfPath } from "./pdfDocument";

describe("isPdfPath", () => {
  it("matches .pdf in any case", () => {
    expect(isPdfPath("/w/spec.pdf")).toBe(true);
    expect(isPdfPath("/w/SCAN.PDF")).toBe(true);
  });

  it("leaves other files and folders named like PDFs alone", () => {
    expect(isPdfPath("/w/spec.pdf.md")).toBe(false);
    expect(isPdfPath("/w/pdf")).toBe(false);
    expect(isPdfPath("/w/notes.txt")).toBe(false);
  });
});
