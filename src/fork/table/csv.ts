import { basename } from "../../platform/tauri/fs";

const DELIMITED_EXTENSIONS: Record<string, string | null> = {
  ".csv": null,
  ".tsv": "\t",
  ".tab": "\t",
};

function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** Route `.csv` and `.tsv` files to the table preview. */
export function isDelimitedPath(path: string): boolean {
  return extension(path) in DELIMITED_EXTENSIONS;
}

/**
 * Tab for `.tsv`; for `.csv`, whichever of comma, semicolon or tab appears
 * most in the first line (outside quotes), so European exports that use `;`
 * still split. Comma wins ties.
 */
export function delimiterFor(path: string, text: string): string {
  const fixed = DELIMITED_EXTENSIONS[extension(path)];
  if (fixed) {
    return fixed;
  }
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const char of text.slice(0, 64 * 1024)) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      break;
    } else if (!quoted && char in counts) {
      counts[char] += 1;
    }
  }
  let best = ",";
  for (const candidate of [";", "\t"]) {
    if (counts[candidate] > counts[best]) {
      best = candidate;
    }
  }
  return best;
}

/**
 * RFC 4180 parsing: quoted fields may hold the delimiter, line breaks and
 * doubled quotes. Accepts CRLF, LF or CR line ends and a leading BOM. A final
 * line break does not make an extra empty row.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
