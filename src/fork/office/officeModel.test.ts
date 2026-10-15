import { describe, expect, it } from "vitest";
import { isOfficePath } from "./officeModel";

describe("isOfficePath", () => {
  it("matches Word, PowerPoint and OpenDocument files", () => {
    for (const name of [
      "a.docx",
      "A.DOC",
      "b.pptx",
      "c.odt",
      "d.rtf",
      "e.ods",
    ]) {
      expect(isOfficePath(`/p/${name}`)).toBe(true);
    }
  });
  it("leaves files with their own view alone", () => {
    for (const name of ["a.xlsx", "b.pdf", "c.csv", "docx.md"]) {
      expect(isOfficePath(`/p/${name}`)).toBe(false);
    }
  });
});
