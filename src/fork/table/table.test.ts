import { describe, expect, it } from "vitest";
import { delimiterFor, isDelimitedPath, parseDelimited } from "./csv";
import { cellNumber, columnLetter, nextSort, sortedOrder } from "./tableModel";
import {
  decodeXmlText,
  formatKind,
  formatSerialDate,
  isSpreadsheetPath,
  readWorkbook,
} from "./xlsx";

describe("parseDelimited", () => {
  it("splits plain rows and drops the final line break", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps delimiters, quotes and line breaks inside quoted fields", () => {
    expect(
      parseDelimited('name,note\r\n"Smith, J","said ""hi""\nthen left"', ","),
    ).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
    ]);
  });

  it("strips a BOM and keeps empty fields", () => {
    expect(parseDelimited("﻿a,,c\r", ",")).toEqual([["a", "", "c"]]);
  });

  it("splits on tabs", () => {
    expect(parseDelimited("a\tb\n", "\t")).toEqual([["a", "b"]]);
  });
});

describe("delimiterFor", () => {
  it("uses tab for .tsv whatever the text", () => {
    expect(delimiterFor("/w/data.tsv", "a,b,c")).toBe("\t");
  });

  it("detects semicolons in .csv and ignores ones inside quotes", () => {
    expect(delimiterFor("/w/eu.csv", "a;b;c\n1;2;3")).toBe(";");
    expect(delimiterFor("/w/x.csv", '"a;b;c",d\n')).toBe(",");
  });

  it("defaults to comma", () => {
    expect(delimiterFor("/w/x.csv", "single")).toBe(",");
  });
});

describe("paths", () => {
  it("routes delimited and workbook files", () => {
    expect(isDelimitedPath("/w/A.CSV")).toBe(true);
    expect(isDelimitedPath("/w/a.tsv")).toBe(true);
    expect(isDelimitedPath("/w/a.csv.md")).toBe(false);
    expect(isSpreadsheetPath("/w/Budget.xlsx")).toBe(true);
    expect(isSpreadsheetPath("/w/m.xlsm")).toBe(true);
    expect(isSpreadsheetPath("/w/old.xls")).toBe(false);
  });
});

describe("table model", () => {
  it("names columns like a spreadsheet", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "ZZ",
      "AAA",
    ]);
  });

  it("reads numbers, money and percentages", () => {
    expect(cellNumber("1,234.5")).toBe(1234.5);
    expect(cellNumber("$12")).toBe(12);
    expect(cellNumber("-$3")).toBe(-3);
    expect(cellNumber("45%")).toBe(45);
    expect(cellNumber("1e3")).toBe(1000);
    expect(cellNumber("12,34")).toBeNull();
    expect(cellNumber("abc")).toBeNull();
    expect(cellNumber("")).toBeNull();
  });

  it("sorts numbers by value, text naturally, empties last both ways", () => {
    const rows = [["10"], [""], ["9"], ["b"], ["a2"], ["a10"]];
    const ascending = sortedOrder(rows, { column: 0, direction: "asc" });
    expect(ascending.map((index) => rows[index][0])).toEqual([
      "9",
      "10",
      "a2",
      "a10",
      "b",
      "",
    ]);
    const descending = sortedOrder(rows, { column: 0, direction: "desc" });
    expect(descending.map((index) => rows[index][0])).toEqual([
      "b",
      "a10",
      "a2",
      "10",
      "9",
      "",
    ]);
  });

  it("keeps file order for ties and cycles the sort", () => {
    expect(
      sortedOrder([["x"], ["x"], ["x"]], { column: 0, direction: "desc" }),
    ).toEqual([0, 1, 2]);
    expect(nextSort(null, 2)).toEqual({ column: 2, direction: "asc" });
    expect(nextSort({ column: 2, direction: "asc" }, 2)).toEqual({
      column: 2,
      direction: "desc",
    });
    expect(nextSort({ column: 2, direction: "desc" }, 2)).toBeNull();
    expect(nextSort({ column: 1, direction: "desc" }, 2)).toEqual({
      column: 2,
      direction: "asc",
    });
  });
});

describe("xlsx helpers", () => {
  it("decodes entities and Excel's _xHHHH_ escapes", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &#233;&#x41;_x000D_")).toBe(
      "a & b <c> éA\r",
    );
  });

  it("tells date formats from number formats", () => {
    expect(formatKind("yyyy-mm-dd")).toBe("date");
    expect(formatKind("[h]:mm:ss")).toBe("date");
    expect(formatKind('#,##0 "days"')).toBe("number");
    expect(formatKind("[$€-1] #,##0.00")).toBe("number");
    expect(formatKind("[Red]0.00")).toBe("number");
    expect(formatKind("0.0%")).toBe("percent");
    expect(formatKind("General")).toBe("number");
  });

  it("turns day serials into dates and times", () => {
    expect(formatSerialDate(45000, false)).toBe("2023-03-15");
    expect(formatSerialDate(1, false)).toBe("1900-01-01");
    expect(formatSerialDate(61, false)).toBe("1900-03-01");
    expect(formatSerialDate(0.5, false)).toBe("12:00:00");
    expect(formatSerialDate(45000.75, false)).toBe("2023-03-15 18:00");
    expect(formatSerialDate(0, true)).toBe("1904-01-01");
  });
});

// ---------------------------------------------------------------- workbook

const encoder = new TextEncoder();

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal zip writer: enough to hand-build a workbook. */
async function zip(files: Record<string, string>, compress: boolean) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = encoder.encode(text);
    const data = compress ? await deflate(raw) : raw;
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, compress ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, compress ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const WORKBOOK = {
  "_rels/.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="${REL}"><sheets>
    <sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/>
    <sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/>
    <sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships>
    <Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>
    <Relationship Id="rId3" Type="${REL}/worksheet" Target="/xl/worksheets/sheet3.xml"/>
    <Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>
    <Relationship Id="rId5" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>When</t></si>
    <si><r><t>Rich </t></r><r><t xml:space="preserve">text</t></r><rPh><t>ignored</t></rPh></si><si/></sst>`,
  "xl/styles.xml": `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="d/m/yyyy"/></numFmts>
    <cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="9"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Paid?</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2" s="2"><v>0.125</v></c><c r="D2" t="b"><v>1</v></c></row>
    <row r="4"><c r="A4"><v>0.30000000000000004</v></c><c r="B4" t="str"><f>A4*2</f><v>x&lt;y</v></c><c r="C4" t="e"><v>#DIV/0!</v></c><c r="D4" s="3"/></row>
  </sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet3.xml": `<worksheet><sheetData><row><c><v>7</v></c><c><v>8</v></c></row></sheetData></worksheet>`,
};

describe("readWorkbook", () => {
  for (const compress of [false, true]) {
    it(`reads visible sheets with strings, dates, percents and gaps (${compress ? "deflated" : "stored"})`, async () => {
      const sheets = await readWorkbook(await zip(WORKBOOK, compress));
      expect(sheets.map((sheet) => sheet.name)).toEqual([
        "Budget & plan",
        "Notes",
      ]);
      expect(sheets[0].rows).toEqual([
        ["Item", "When", "", "Paid?"],
        ["Rich text", "2023-03-15", "12.5%", "TRUE"],
        [],
        ["0.3", "x<y", "#DIV/0!"],
      ]);
      expect(sheets[0].truncated).toBe(false);
      expect(sheets[1].rows).toEqual([["7", "8"]]);
    });
  }

  it("rejects files that are not workbooks", async () => {
    await expect(readWorkbook(encoder.encode("a,b\n1,2"))).rejects.toThrow(
      /Not an Excel workbook/,
    );
    await expect(
      readWorkbook(await zip({ "readme.txt": "hi" }, false)),
    ).rejects.toThrow(/no workbook part/);
  });
});
