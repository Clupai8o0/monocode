import { basename } from "../../platform/tauri/fs";

/** Route Excel workbooks (the zip-based formats) to the spreadsheet view. */
export function isSpreadsheetPath(path: string): boolean {
  return /\.(xlsx|xlsm)$/.test(basename(path).toLowerCase());
}

export type Sheet = { name: string; rows: string[][]; truncated: boolean };

/** Past these a sheet is cut short, so a stray far-off cell cannot eat memory. */
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 1_000;
/**
 * Total unzipped bytes allowed, against zip bombs. Each byte is held about
 * four times over (chunks, joined bytes, decoded string), so keep it modest.
 */
const MAX_UNZIPPED = 64 * 1024 * 1024;

// ---------------------------------------------------------------- zip

type ZipEntry = { method: number; data: Uint8Array; unzipped: number };

/**
 * Reads the zip central directory. Only stored and deflated entries, no
 * zip64 and no encryption: that covers every workbook Excel, Numbers,
 * LibreOffice and Google Sheets write.
 */
function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 22 - 0xffff);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) {
    throw new Error("Not an Excel workbook (no zip directory found).");
  }
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (offset === 0xffffffff) {
    throw new Error("Workbooks over 4 GB are not supported.");
  }
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The workbook's zip directory is damaged.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const unzipped = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) {
      throw new Error("Password-protected workbooks can't be previewed.");
    }
    if (view.getUint32(local, true) !== 0x04034b50) {
      continue;
    }
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    entries.set(name.replace(/^\/+/, ""), {
      method,
      data: bytes.subarray(start, start + size),
      unzipped,
    });
  }
  return entries;
}

async function inflate(entry: ZipEntry, budget: { left: number }) {
  // The declared size is checked first; the running count below still
  // catches an entry that lies about it.
  if (entry.unzipped > budget.left) {
    throw new Error("The workbook is too large to preview.");
  }
  if (entry.method === 0) {
    budget.left -= entry.data.length;
    if (budget.left < 0) {
      throw new Error("The workbook is too large to preview.");
    }
    return entry.data;
  }
  if (entry.method !== 8) {
    throw new Error(`Unsupported zip compression (method ${entry.method}).`);
  }
  const stream = new Blob([entry.data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.length;
    budget.left -= value.length;
    if (budget.left < 0) {
      await reader.cancel();
      throw new Error("The workbook is too large to preview.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------- xml

type XmlEvent =
  | {
      kind: "open";
      name: string;
      attrs: Record<string, string>;
      empty: boolean;
    }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const TOKEN =
  /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<(\/?)([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

export function decodeXmlText(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, code) => {
      switch (code) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return String.fromCodePoint(
            code[1] === "x"
              ? parseInt(code.slice(2), 16)
              : parseInt(code.slice(1), 10),
          );
      }
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** A small streaming scanner: workbooks are machine-written, plain XML. */
function* scanXml(xml: string): Generator<XmlEvent> {
  for (const match of xml.matchAll(TOKEN)) {
    const [, cdata, slash, name, rawAttrs, selfClose, text] = match;
    if (cdata !== undefined) {
      yield { kind: "text", text: cdata };
    } else if (text !== undefined) {
      yield { kind: "text", text: decodeXmlText(text) };
    } else if (name === undefined) {
      continue;
    } else if (slash) {
      yield { kind: "close", name: localName(name) };
    } else {
      const attrs: Record<string, string> = {};
      for (const attr of (rawAttrs ?? "").matchAll(ATTR)) {
        attrs[localName(attr[1])] = decodeXmlText(attr[2] ?? attr[3] ?? "");
      }
      yield { kind: "open", name: localName(name), attrs, empty: !!selfClose };
    }
  }
}

// ---------------------------------------------------------------- workbook

type Relationship = { target: string; type: string };

function relationships(xml: string, base: string): Map<string, Relationship> {
  const map = new Map<string, Relationship>();
  for (const event of scanXml(xml)) {
    if (event.kind === "open" && event.name === "Relationship") {
      const target = event.attrs.Target ?? "";
      if (event.attrs.TargetMode === "External") {
        continue;
      }
      map.set(event.attrs.Id ?? "", {
        target: resolvePath(base, target),
        type: event.attrs.Type ?? "",
      });
    }
  }
  return map;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const parts = base ? base.split("/") : [];
  for (const part of target.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function folderOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function relsPathFor(path: string): string {
  const folder = folderOf(path);
  const name = path.slice(folder ? folder.length + 1 : 0);
  return `${folder ? `${folder}/` : ""}_rels/${name}.rels`;
}

function sharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  for (const event of scanXml(xml)) {
    if (event.kind === "open") {
      if (event.name === "si") {
        current = "";
        if (event.empty) {
          strings.push("");
          current = null;
        }
      } else if (event.name === "rPh") {
        phonetic += event.empty ? 0 : 1;
      } else if (event.name === "t" && !event.empty) {
        inText = true;
      }
    } else if (event.kind === "close") {
      if (event.name === "si" && current !== null) {
        strings.push(current);
        current = null;
      } else if (event.name === "rPh") {
        phonetic -= 1;
      } else if (event.name === "t") {
        inText = false;
      }
    } else if (inText && phonetic === 0 && current !== null) {
      current += event.text;
    }
  }
  return strings;
}

const BUILT_IN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const BUILT_IN_PERCENT_FORMATS = new Set([9, 10]);

/** Strip quoted text, escapes, padding and colour/locale tags first. */
export function formatKind(code: string): "date" | "percent" | "number" {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  if (/[dmyhs]/i.test(bare.replace(/General/gi, ""))) {
    return "date";
  }
  return bare.includes("%") ? "percent" : "number";
}

type CellStyle = "date" | "percent" | "number";

function cellStyles(xml: string): CellStyle[] {
  const custom = new Map<number, CellStyle>();
  const styles: CellStyle[] = [];
  let inCellXfs = false;
  for (const event of scanXml(xml)) {
    if (event.kind === "open") {
      if (event.name === "numFmt") {
        custom.set(
          Number(event.attrs.numFmtId),
          formatKind(event.attrs.formatCode ?? ""),
        );
      } else if (event.name === "cellXfs") {
        inCellXfs = !event.empty;
      } else if (inCellXfs && event.name === "xf") {
        const id = Number(event.attrs.numFmtId ?? 0);
        styles.push(
          custom.get(id) ??
            (BUILT_IN_DATE_FORMATS.has(id)
              ? "date"
              : BUILT_IN_PERCENT_FORMATS.has(id)
                ? "percent"
                : "number"),
        );
      }
    } else if (event.kind === "close" && event.name === "cellXfs") {
      inCellXfs = false;
    }
  }
  return styles;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Excel day serial → `2026-10-16`, `13:05:00` or `2026-10-16 13:05`. */
export function formatSerialDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial) || serial < 0) {
    return String(serial);
  }
  const whole = Math.floor(serial);
  const seconds = Math.round((serial - whole) * 86400);
  const time = `${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor(seconds / 60) % 60)}`;
  if (whole === 0 && !date1904) {
    return `${time}:${pad(seconds % 60)}`;
  }
  // Excel's 1900 system counts a 29 Feb 1900 that never was.
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, whole < 60 ? 31 : 30);
  const day = new Date(epoch + whole * 86400000);
  const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
  return seconds === 0 ? date : `${date} ${time}`;
}

function formatNumber(raw: string, style: CellStyle, date1904: boolean) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return raw;
  }
  if (style === "date") {
    return formatSerialDate(value, date1904);
  }
  if (style === "percent") {
    return `${Number((value * 100).toPrecision(12))}%`;
  }
  return String(Number(value.toPrecision(15)));
}

/** `B12` → [11, 1] (row, column), both zero-based. */
function parseRef(ref: string): [number, number] | null {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  if (!match) {
    return null;
  }
  let column = 0;
  for (const char of match[1]) {
    column = column * 26 + (char.charCodeAt(0) - 64);
  }
  return [Number(match[2]) - 1, column - 1];
}

function parseSheet(
  xml: string,
  strings: string[],
  styles: CellStyle[],
  date1904: boolean,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  let rowIndex = -1;
  let columnIndex = -1;
  let cell: { type: string; style: number; value: string } | null = null;
  let capture: "v" | "t" | null = null;
  let inline = false;

  const store = () => {
    if (!cell) {
      return;
    }
    const { type, style, value } = cell;
    cell = null;
    if (rowIndex >= MAX_ROWS || columnIndex >= MAX_COLUMNS) {
      truncated = true;
      return;
    }
    let text: string;
    if (type === "s") {
      text = strings[Number(value)] ?? "";
    } else if (type === "b") {
      text = value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
    } else if (type === "n" || type === "") {
      text =
        value === ""
          ? ""
          : formatNumber(value, styles[style] ?? "number", date1904);
    } else {
      text = value;
    }
    if (text === "") {
      return;
    }
    while (rows.length <= rowIndex) {
      rows.push([]);
    }
    const row = rows[rowIndex];
    while (row.length < columnIndex) {
      row.push("");
    }
    row[columnIndex] = text;
  };

  for (const event of scanXml(xml)) {
    if (event.kind === "open") {
      if (event.name === "row") {
        const number = Number(event.attrs.r);
        rowIndex =
          Number.isInteger(number) && number > 0 ? number - 1 : rowIndex + 1;
        columnIndex = -1;
      } else if (event.name === "c") {
        const ref = event.attrs.r ? parseRef(event.attrs.r) : null;
        if (ref) {
          [rowIndex, columnIndex] = ref;
        } else {
          columnIndex += 1;
        }
        if (!event.empty) {
          cell = {
            type: event.attrs.t ?? "",
            style: Number(event.attrs.s ?? 0),
            value: "",
          };
        }
      } else if (event.name === "is") {
        inline = true;
      } else if (cell && !event.empty && event.name === "v") {
        capture = "v";
      } else if (cell && inline && !event.empty && event.name === "t") {
        capture = "t";
      }
    } else if (event.kind === "close") {
      if (event.name === "c") {
        store();
      } else if (event.name === "is") {
        inline = false;
      } else if (event.name === "v" || event.name === "t") {
        capture = null;
      }
    } else if (capture && cell) {
      cell.value += event.text;
    }
  }
  return { rows, truncated };
}

/** Every visible worksheet of an `.xlsx` as rows of display text. */
export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = readZip(bytes);
  const budget = { left: MAX_UNZIPPED };
  const decoder = new TextDecoder();
  const text = async (path: string) => {
    const entry = zip.get(path);
    return entry ? decoder.decode(await inflate(entry, budget)) : null;
  };

  const rootRels = await text("_rels/.rels");
  const workbookPath =
    [...relationships(rootRels ?? "", "").values()].find((rel) =>
      rel.type.endsWith("/officeDocument"),
    )?.target ?? "xl/workbook.xml";
  const workbookXml = await text(workbookPath);
  if (workbookXml === null) {
    throw new Error("Not an Excel workbook (no workbook part).");
  }
  const rels = relationships(
    (await text(relsPathFor(workbookPath))) ?? "",
    folderOf(workbookPath),
  );
  const relOfType = (suffix: string) =>
    [...rels.values()].find((rel) => rel.type.endsWith(suffix))?.target;

  const strings = sharedStrings(
    (await text(relOfType("/sharedStrings") ?? "xl/sharedStrings.xml")) ?? "",
  );
  const styles = cellStyles(
    (await text(relOfType("/styles") ?? "xl/styles.xml")) ?? "",
  );

  let date1904 = false;
  const listed: { name: string; target: string }[] = [];
  for (const event of scanXml(workbookXml)) {
    if (event.kind !== "open") {
      continue;
    }
    if (event.name === "workbookPr") {
      date1904 = ["1", "true"].includes(event.attrs.date1904 ?? "");
    } else if (
      event.name === "sheet" &&
      event.attrs.state !== "hidden" &&
      event.attrs.state !== "veryHidden"
    ) {
      const rel = rels.get(event.attrs.id ?? "");
      if (rel?.type.endsWith("/worksheet")) {
        listed.push({ name: event.attrs.name ?? "Sheet", target: rel.target });
      }
    }
  }

  const sheets: Sheet[] = [];
  for (const { name, target } of listed) {
    const xml = await text(target);
    if (xml !== null) {
      sheets.push({ name, ...parseSheet(xml, strings, styles, date1904) });
    }
  }
  return sheets;
}
