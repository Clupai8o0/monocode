/**
 * Fork: a paste this big floods the context and the composer, so it travels as
 * a file instead. One click puts it back as text.
 */
export const LARGE_PASTE_BYTES = 32 * 1024;
const NAME_WORDS = 4;
const FIRST_LINE_CHARS = 120;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export function isLargePaste(text: string): boolean {
  // Every character is at least one byte, so short text skips the encode.
  if (text.length >= LARGE_PASTE_BYTES) return true;
  return text.length * 3 >= LARGE_PASTE_BYTES && byteLength(text) >= LARGE_PASTE_BYTES;
}

export function pastedFirstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > FIRST_LINE_CHARS
    ? `${trimmed.slice(0, FIRST_LINE_CHARS)}…`
    : trimmed;
}

/** `pasted-error-at-line-12.txt`, or plain `pasted-text.txt` with nothing usable. */
export function pastedFileName(text: string): string {
  const slug = pastedFirstLine(text)
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

export function pastedTextFile(text: string): File {
  return new File([text], pastedFileName(text), { type: "text/plain" });
}

export function formatPasteSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type LargePaste = {
  attachmentId: string;
  text: string;
  firstLine: string;
  size: number;
};

export const describeLargePaste = (
  attachmentId: string,
  text: string,
): LargePaste => ({
  attachmentId,
  text,
  firstLine: pastedFirstLine(text),
  size: byteLength(text),
});
