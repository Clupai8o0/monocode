import { columnLetter } from "../table/tableModel";

/** Selected rows beyond this are summed up rather than listed. */
const MAX_LISTED_ROWS = 8;

/**
 * The selected text, quoted, under a line saying where it came from. `exact`
 * text keeps its edges: a table's blank first row or cell is part of its shape.
 */
export function quoteForChat(
  reference: string,
  text: string,
  exact = false,
): string {
  if (!text.trim()) return "";
  const normalized = text.replace(/\r\n?/g, "\n");
  const quote = (exact ? normalized : normalized.trim())
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  const from = reference.replace(/\s+/g, " ").trim();
  return from ? `${from}:\n\n${quote}` : quote;
}

/** `report.pdf p. 3`, or `report.pdf pp. 3-4` across pages. */
export function pageReference(
  file: string,
  first: number,
  last: number,
): string {
  return first === last
    ? `${file} p. ${first}`
    : `${file} pp. ${Math.min(first, last)}-${Math.max(first, last)}`;
}

/** `notebook.ipynb cell 4`, or `notebook.ipynb cells 4-6`. */
export function notebookReference(
  file: string,
  first: number,
  last: number,
): string {
  return first === last
    ? `${file} cell ${first}`
    : `${file} cells ${Math.min(first, last)}-${Math.max(first, last)}`;
}

/** `src/app.ts:40-44`; lines a diff removed say so, their numbers being old. */
export function lineReference(
  path: string,
  first: number,
  last: number,
  removed = false,
): string {
  const lines =
    first === last
      ? `${first}`
      : `${Math.min(first, last)}-${Math.max(first, last)}`;
  return `${path}:${lines}${removed ? " (removed)" : ""}`;
}

/** `guide.md § Install`: rendered Markdown keeps no line numbers. */
export function headingReference(file: string, heading: string | null): string {
  const title = heading?.replace(/\s+/g, " ").trim();
  return title ? `${file} § ${title}` : file;
}

/** A sheet name with anything but letters, digits or `_` is quoted, as in Excel. */
function sheetPrefix(sheet: string | undefined): string {
  if (!sheet) return "";
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(sheet)
    ? `${sheet}!`
    : `'${sheet.replace(/'/g, "''")}'!`;
}

export type CellSelection = {
  file: string;
  sheet?: string;
  firstColumn: number;
  lastColumn: number;
  /** One-based rows as the file numbers them; a sorted table scatters them. */
  rows: number[];
};

/**
 * `data.xlsx Sheet1!B2:D9`. Rows a sort has pulled apart are not a range, so
 * they are named one by one rather than as a span that includes other rows.
 */
export function cellReference({
  file,
  sheet,
  firstColumn,
  lastColumn,
  rows,
}: CellSelection): string {
  const left = columnLetter(Math.min(firstColumn, lastColumn));
  const right = columnLetter(Math.max(firstColumn, lastColumn));
  const prefix = sheetPrefix(sheet);
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  if (bottom - top + 1 === sorted.length) {
    const start = `${left}${top}`;
    const end = `${right}${bottom}`;
    return `${file} ${prefix}${start === end ? start : `${start}:${end}`}`;
  }
  const columns = left === right ? left : `${left}:${right}`;
  const listed = sorted.slice(0, MAX_LISTED_ROWS).join(", ");
  const more =
    sorted.length > MAX_LISTED_ROWS
      ? ` and ${sorted.length - MAX_LISTED_ROWS} more`
      : "";
  return `${file} ${prefix}${columns} rows ${listed}${more}`;
}
