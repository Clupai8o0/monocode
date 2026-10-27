/**
 * Turns a shell's raw output into lines of plain text. The phone shows text,
 * not a screen, so this keeps only what a line printer would: carriage
 * returns and backspaces rewrite the current line, and escape sequences —
 * colours, titles, cursor moves — are dropped. Feed it chunks as they come;
 * a sequence split across two chunks is held until the rest arrives.
 */

/** Lines kept; older ones scroll away. */
const MAX_LINES = 2_000;
/** Longer lines wrap, so output with no newlines still scrolls away. */
const MAX_LINE_CHARS = 4_096;
/** An escape sequence longer than this is garbage, not one to wait for. */
const MAX_PENDING_CHARS = 4_096;

export type TerminalText = {
  lines: string[];
  /** Where the next character lands in the last line. */
  column: number;
  /** An escape sequence still waiting for its end. */
  pending: string;
};

export const emptyTerminalText = (): TerminalText => ({
  lines: [""],
  column: 0,
  pending: "",
});

/** How long the escape sequence at the start of `text` is; 0 if unfinished. */
function escapeLength(text: string): number {
  if (text.length < 2) return 0;
  const kind = text[1];
  if (kind === "[") {
    // CSI: parameters, then one final byte in @–~.
    for (let i = 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
    }
    return 0;
  }
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
    // OSC and friends: up to BEL or ESC \.
    for (let i = 2; i < text.length; i++) {
      if (text[i] === "\x07") return i + 1;
      if (text[i] === "\x1b" && i + 1 < text.length && text[i + 1] === "\\")
        return i + 2;
    }
    return 0;
  }
  // Character set picks take one more byte; everything else is two bytes.
  if (kind === "(" || kind === ")") return text.length >= 3 ? 3 : 0;
  return 2;
}

export function feedTerminalText(
  state: TerminalText,
  chunk: string,
): TerminalText {
  const lines = [...state.lines];
  let line = lines.pop() ?? "";
  let column = state.column;
  const text = state.pending + chunk;
  let pending = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\x1b") {
      const length = escapeLength(text.slice(i, i + MAX_PENDING_CHARS + 1));
      if (!length) {
        if (text.length - i <= MAX_PENDING_CHARS) {
          pending = text.slice(i);
          break;
        }
        // Never ends: drop the escape and show what follows.
        continue;
      }
      i += length - 1;
    } else if (char === "\n") {
      lines.push(line);
      line = "";
      column = 0;
    } else if (char === "\r") {
      column = 0;
    } else if (char === "\b") {
      column = Math.max(0, column - 1);
    } else if (char === "\t") {
      if (column + 8 > MAX_LINE_CHARS) {
        lines.push(line);
        line = "";
        column = 0;
      }
      const next = (Math.floor(column / 8) + 1) * 8;
      line = line.padEnd(next, " ");
      column = next;
    } else if (char >= " " && char !== "\x7f") {
      if (column >= MAX_LINE_CHARS) {
        lines.push(line);
        line = "";
        column = 0;
      }
      line = line.slice(0, column).padEnd(column, " ") + char + line.slice(column + 1);
      column++;
    }
  }
  lines.push(line);
  return {
    lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
    column,
    pending,
  };
}
