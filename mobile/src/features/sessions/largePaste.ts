import type { Attachment } from "./attachments";

/** A paste this big travels as a file, as on the desktop. */
export const LARGE_PASTE_BYTES = 32 * 1024;
const FIRST_LINE_CHARS = 80;
const NAME_WORDS = 4;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * A text field has no paste event here, so a paste shows up as a big change.
 * Returns the inserted text and the field without it, when one change added
 * this much at once.
 */
export function findLargeInsert(
  previous: string,
  next: string,
): { inserted: string; remaining: string; at: number } | null {
  // At most 3 bytes a character here, so short text skips the search. Net growth
  // wouldn't do: a paste can replace a selection just as long.
  if (next.length * 3 < LARGE_PASTE_BYTES) return null;
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    previous[start] === next[start]
  ) {
    start++;
  }
  let end = 0;
  while (
    end < previous.length - start &&
    end < next.length - start &&
    previous[previous.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  const inserted = next.slice(start, next.length - end);
  if (utf8(inserted).length < LARGE_PASTE_BYTES) return null;
  return {
    inserted,
    remaining: next.slice(0, start) + next.slice(next.length - end),
    at: start,
  };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64[c & 63];
  }
  return out;
}

export function pasteFirstLine(text: string): string {
  const line = (text.split(/\r?\n/).find((entry) => entry.trim()) ?? "").trim();
  return line.length > FIRST_LINE_CHARS ? `${line.slice(0, FIRST_LINE_CHARS)}…` : line;
}

export function pasteFileName(text: string): string {
  const slug = pasteFirstLine(text)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, NAME_WORDS)
    .join("-");
  return `pasted-${slug || "text"}.txt`;
}

export function pasteAttachment(id: string, text: string): Attachment {
  const bytes = utf8(text);
  return {
    id,
    name: pasteFileName(text),
    mimeType: "text/plain",
    size: bytes.length,
    // Nothing on the phone to show; the chip for a text file has no thumbnail.
    uri: "",
    data: toBase64(bytes),
  };
}
