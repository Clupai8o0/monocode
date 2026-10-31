import { describe, expect, it } from "vitest";
import {
  cellReference,
  headingReference,
  lineReference,
  notebookReference,
  pageReference,
  quoteForChat,
} from "./askChatModel";

describe("quoteForChat", () => {
  it("quotes every line under where it came from", () => {
    expect(quoteForChat("report.pdf p. 3", "one\n\ntwo\r\nthree\n")).toBe(
      "report.pdf p. 3:\n\n> one\n>\n> two\n> three",
    );
  });

  it("keeps a table's blank edges when the text is exact", () => {
    expect(quoteForChat("d.csv B2:C3", "\tc2\nb3\tc3", true)).toBe(
      "d.csv B2:C3:\n\n> \tc2\n> b3\tc3",
    );
    expect(quoteForChat("d.csv A2:A3", "\nvalue", true)).toBe(
      "d.csv A2:A3:\n\n>\n> value",
    );
    expect(quoteForChat("d.csv", "\t\n\t", true)).toBe("");
  });

  it("sends nothing for blank text and keeps a reference on one line", () => {
    expect(quoteForChat("report.pdf", "  \n ")).toBe("");
    expect(quoteForChat("a\nb.pdf", "x")).toBe("a b.pdf:\n\n> x");
  });
});

describe("references", () => {
  it("names a page or a span of pages", () => {
    expect(pageReference("report.pdf", 3, 3)).toBe("report.pdf p. 3");
    expect(pageReference("report.pdf", 3, 4)).toBe("report.pdf pp. 3-4");
  });

  it("names a notebook cell or a span of cells", () => {
    expect(notebookReference("nb.ipynb", 4, 4)).toBe("nb.ipynb cell 4");
    expect(notebookReference("nb.ipynb", 4, 6)).toBe("nb.ipynb cells 4-6");
  });

  it("names diff lines and flags removed ones", () => {
    expect(lineReference("src/app.ts", 40, 40)).toBe("src/app.ts:40");
    expect(lineReference("src/app.ts", 40, 44)).toBe("src/app.ts:40-44");
    expect(lineReference("src/app.ts", 44, 40)).toBe("src/app.ts:40-44");
    expect(lineReference("src/app.ts", 7, 8, true)).toBe(
      "src/app.ts:7-8 (removed)",
    );
  });

  it("adds the nearest heading to a Markdown file when there is one", () => {
    expect(headingReference("guide.md", " Install\n now ")).toBe(
      "guide.md § Install now",
    );
    expect(headingReference("guide.md", null)).toBe("guide.md");
  });
});

describe("cellReference", () => {
  const cells = { file: "data.xlsx", firstColumn: 1, lastColumn: 3 };

  it("writes a rectangle the way a spreadsheet does", () => {
    expect(
      cellReference({
        ...cells,
        sheet: "Sheet1",
        rows: [2, 3, 4, 5, 6, 7, 8, 9],
      }),
    ).toBe("data.xlsx Sheet1!B2:D9");
  });

  it("writes one cell without a range, and leaves out a CSV's missing sheet", () => {
    expect(
      cellReference({
        file: "a.csv",
        firstColumn: 1,
        lastColumn: 1,
        rows: [2],
      }),
    ).toBe("a.csv B2");
  });

  it("quotes a sheet name Excel would quote", () => {
    expect(cellReference({ ...cells, sheet: "Budget & plan", rows: [2] })).toBe(
      "data.xlsx 'Budget & plan'!B2:D2",
    );
    expect(cellReference({ ...cells, sheet: "Bob's", rows: [2] })).toBe(
      "data.xlsx 'Bob''s'!B2:D2",
    );
  });

  it("accepts rows in sorted-table order when they still touch", () => {
    expect(cellReference({ ...cells, rows: [4, 2, 3] })).toBe(
      "data.xlsx B2:D4",
    );
  });

  it("never spans rows a sort has pulled apart", () => {
    expect(cellReference({ ...cells, rows: [40, 2, 9] })).toBe(
      "data.xlsx B:D rows 2, 9, 40",
    );
    expect(
      cellReference({
        ...cells,
        rows: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
      }),
    ).toBe("data.xlsx B:D rows 2, 4, 6, 8, 10, 12, 14, 16 and 2 more");
  });
});
