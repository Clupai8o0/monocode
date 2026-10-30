/**
 * Turns a shell's raw output into lines of styled text. The phone shows text,
 * not a screen, so this keeps what a line printer with colour would: SGR
 * colours and weights become styled runs, and the controls readline uses to
 * edit the line it is on (carriage return, backspace, erase in line, cursor
 * left and right, insert and delete) rewrite the current line. Every other
 * escape sequence — titles, cursor positioning, the alternate screen — is
 * dropped. Feed it chunks as they come; a sequence split across two chunks is
 * held until the rest arrives.
 */

/** Lines kept; older ones scroll away. */
const MAX_LINES = 5_000;
/** Longer lines wrap, so output with no newlines still scrolls away. */
const MAX_LINE_CHARS = 4_096;
/** An escape sequence longer than this is garbage, not one to wait for. */
const MAX_PENDING_CHARS = 4_096;

/** One of the 256 indexed colours, or a true colour as `#rrggbb`. */
export type TerminalColor = number | string;

export type TerminalStyle = {
  fg?: TerminalColor;
  bg?: TerminalColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

/** A stretch of one line in one style; `null` is the terminal's default. */
export type TerminalRun = { text: string; style: TerminalStyle | null };

export type TerminalText = {
  lines: string[];
  /** Each line cut into styled runs, in step with `lines`. */
  runs: TerminalRun[][];
  /** Where the next character lands in the last line. */
  column: number;
  /** An escape sequence still waiting for its end. */
  pending: string;
  /** The style the next character is printed in. */
  style: TerminalStyle | null;
  /** The style of each character of the last line. */
  cells: (TerminalStyle | null)[];
};

export const emptyTerminalText = (): TerminalText => ({
  lines: [""],
  runs: [[]],
  column: 0,
  pending: "",
  style: null,
  cells: [],
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
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    // OSC and friends: up to BEL or ESC \.
    for (let i = 2; i < text.length; i++) {
      if (text[i] === "\x07") return i + 1;
      if (text[i] === "\x1b" && i + 1 < text.length && text[i + 1] === "\\")
        return i + 2;
    }
    return 0;
  }
  // Character set picks and the like take one more byte; the rest are two.
  if ("()*+-./#% ".includes(kind!)) return text.length >= 3 ? 3 : 0;
  return 2;
}

const sameStyle = (a: TerminalStyle | null, b: TerminalStyle | null) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !a.bold === !b.bold &&
    !a.dim === !b.dim &&
    !a.italic === !b.italic &&
    !a.underline === !b.underline &&
    !a.inverse === !b.inverse
  );
};

/** A style with nothing set is the default, `null`. */
const settle = (style: TerminalStyle): TerminalStyle | null =>
  Object.values(style).some((value) => value !== undefined && value !== false)
    ? style
    : null;

const hex = (value: number) =>
  Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0");

/** Reads an extended colour (`38;5;n` or `38;2;r;g;b`) from `values` at `at`. */
function extended(
  values: (number | undefined)[],
  at: number,
): { color: TerminalColor | undefined; used: number } {
  const mode = values[at];
  if (mode === 5) {
    const index = values[at + 1];
    return {
      color: index !== undefined && index >= 0 && index <= 255 ? index : undefined,
      used: 2,
    };
  }
  if (mode === 2) {
    const [r, g, b] = values.slice(at + 1, at + 4);
    return {
      color:
        r !== undefined && g !== undefined && b !== undefined
          ? `#${hex(r)}${hex(g)}${hex(b)}`
          : undefined,
      used: 4,
    };
  }
  return { color: undefined, used: 1 };
}

/** The style after an SGR sequence with these parameters. */
export function applySgr(
  current: TerminalStyle | null,
  params: string,
): TerminalStyle | null {
  // Private forms (`CSI > 4 ; 2 m`) set keyboard modes, not colours.
  if (/[^\d;:]/.test(params)) return current;
  const style: TerminalStyle = { ...current };
  const tokens = params === "" ? ["0"] : params.split(";");
  const values = tokens.map((token) =>
    token === "" ? 0 : token.includes(":") ? undefined : Number(token),
  );
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.includes(":")) {
      // ITU form: `38:2::r:g:b`, `38:5:n`, `4:3` (curly underline).
      const subs = token.split(":").map((part) => (part === "" ? undefined : Number(part)));
      const [code, mode] = subs;
      if (code === 38 || code === 48) {
        const rest = mode === 2 && subs.length >= 6 ? [2, ...subs.slice(-3)] : subs.slice(1);
        const { color } = extended(rest, 0);
        if (code === 38) style.fg = color;
        else style.bg = color;
      } else if (code === 4) {
        style.underline = mode !== 0;
      }
      continue;
    }
    const code = values[i]!;
    if (code === 0) {
      for (const key of Object.keys(style)) delete style[key as keyof TerminalStyle];
    } else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4 || code === 21) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code >= 30 && code <= 37) style.fg = code - 30;
    else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
    else if (code >= 40 && code <= 47) style.bg = code - 40;
    else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
    else if (code === 39) style.fg = undefined;
    else if (code === 49) style.bg = undefined;
    else if (code === 38 || code === 48) {
      const { color, used } = extended(values, i + 1);
      if (code === 38) style.fg = color;
      else style.bg = color;
      i += used;
    }
  }
  const settled = settle(style);
  return sameStyle(settled, current) ? current : settled;
}

/** Cuts a line into runs of one style each. */
function toRuns(line: string, cells: (TerminalStyle | null)[]): TerminalRun[] {
  const runs: TerminalRun[] = [];
  let from = 0;
  for (let i = 1; i <= line.length; i++) {
    if (i === line.length || !sameStyle(cells[i] ?? null, cells[from] ?? null)) {
      runs.push({ text: line.slice(from, i), style: cells[from] ?? null });
      from = i;
    }
  }
  return runs;
}

/** The count a cursor or erase sequence asks for; 1 when left out. */
const count = (params: string) => Math.max(1, Number.parseInt(params, 10) || 1);

export function feedTerminalText(
  state: TerminalText,
  chunk: string,
): TerminalText {
  const lines = state.lines.slice(0, -1);
  const runs = state.runs.slice(0, -1);
  let line = state.lines[state.lines.length - 1] ?? "";
  let cells = [...state.cells];
  let column = state.column;
  let style = state.style;
  const text = state.pending + chunk;
  let pending = "";

  const newline = () => {
    lines.push(line);
    runs.push(toRuns(line, cells));
    line = "";
    cells = [];
    column = 0;
  };
  /** Pads the line with blanks out to `to`, so the cursor can sit past its end. */
  const reach = (to: number) => {
    if (line.length >= to) return;
    cells.push(...new Array<null>(to - line.length).fill(null));
    line = line.padEnd(to, " ");
  };
  const csi = (params: string, final: string) => {
    if (final === "m") style = applySgr(style, params);
    else if (final === "K") {
      const mode = Number.parseInt(params, 10) || 0;
      if (mode === 0) {
        line = line.slice(0, column);
        cells = cells.slice(0, column);
      } else if (mode === 1) {
        const end = Math.min(line.length, column + 1);
        line = " ".repeat(end) + line.slice(end);
        cells = [...new Array<null>(end).fill(null), ...cells.slice(end)];
      } else if (mode === 2) {
        line = "";
        cells = [];
      }
    } else if (final === "C") column = Math.min(MAX_LINE_CHARS, column + count(params));
    else if (final === "D") column = Math.max(0, column - count(params));
    else if (final === "G") column = Math.min(MAX_LINE_CHARS, count(params) - 1);
    else if (final === "P") {
      const n = count(params);
      line = line.slice(0, column) + line.slice(column + n);
      cells = [...cells.slice(0, column), ...cells.slice(column + n)];
    } else if (final === "@") {
      const n = Math.min(count(params), MAX_LINE_CHARS);
      reach(column);
      line = (line.slice(0, column) + " ".repeat(n) + line.slice(column)).slice(
        0,
        MAX_LINE_CHARS,
      );
      cells = [
        ...cells.slice(0, column),
        ...new Array<null>(n).fill(null),
        ...cells.slice(column),
      ].slice(0, MAX_LINE_CHARS);
    }
    // Everything else moves a cursor this view has no screen for: dropped.
  };

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
      if (text[i + 1] === "[") {
        const body = text.slice(i + 2, i + length - 1);
        csi(body, text[i + length - 1]!);
      }
      i += length - 1;
    } else if (char === "\n") {
      newline();
    } else if (char === "\r") {
      column = 0;
    } else if (char === "\b") {
      column = Math.max(0, column - 1);
    } else if (char === "\t") {
      if (column + 8 > MAX_LINE_CHARS) newline();
      const next = (Math.floor(column / 8) + 1) * 8;
      reach(next);
      column = next;
    } else if (char >= " " && char !== "\x7f") {
      if (column >= MAX_LINE_CHARS) newline();
      reach(column);
      line = line.slice(0, column) + char + line.slice(column + 1);
      cells[column] = style;
      column++;
    }
    // Bell and the other C0 controls print nothing.
  }
  lines.push(line);
  runs.push(toRuns(line, cells));
  const over = lines.length - MAX_LINES;
  return {
    lines: over > 0 ? lines.slice(over) : lines,
    runs: over > 0 ? runs.slice(over) : runs,
    column,
    pending,
    style,
    cells,
  };
}

/** The sixteen ANSI colours, tuned to read on the app's dark and light bases. */
export const TERMINAL_PALETTES: Record<"dark" | "light", readonly string[]> = {
  dark: [
    "#3a3a3a", "#f87171", "#6ee7b7", "#fbbf24", "#60a5fa", "#c084fc", "#22d3ee", "#d4d4d4",
    "#737373", "#fca5a5", "#a7f3d0", "#fde68a", "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff",
  ],
  light: [
    "#2e2e2e", "#c62828", "#2e7d32", "#9a6700", "#1d4ed8", "#8e24aa", "#00838f", "#6b6b6b",
    "#595959", "#e53935", "#388e3c", "#b45309", "#2563eb", "#a21caf", "#0e7490", "#404040",
  ],
};

const CUBE = [0, 95, 135, 175, 215, 255];

/** A colour as CSS, from the sixteen in `palette` or the 256-colour table. */
export function colorValue(color: TerminalColor, palette: readonly string[]): string {
  if (typeof color === "string") return color;
  if (color < 16) return palette[color]!;
  if (color < 232) {
    const n = color - 16;
    return `#${hex(CUBE[Math.floor(n / 36)]!)}${hex(CUBE[Math.floor(n / 6) % 6]!)}${hex(CUBE[n % 6]!)}`;
  }
  const grey = 8 + (color - 232) * 10;
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}

export type RunTextStyle = {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecorationLine?: "underline";
};

/** What a run looks like, against the screen's own text and background. */
export function runTextStyle(
  style: TerminalStyle,
  palette: readonly string[],
  base: { content: string; background: string },
): RunTextStyle {
  let color = style.fg === undefined ? undefined : colorValue(style.fg, palette);
  let backgroundColor = style.bg === undefined ? undefined : colorValue(style.bg, palette);
  if (style.inverse) {
    [color, backgroundColor] = [backgroundColor ?? base.background, color ?? base.content];
  }
  const out: RunTextStyle = {};
  if (color) out.color = color;
  if (backgroundColor) out.backgroundColor = backgroundColor;
  if (style.bold) out.fontWeight = "bold";
  if (style.italic) out.fontStyle = "italic";
  if (style.underline) out.textDecorationLine = "underline";
  // Nested Text takes no opacity on Android, so dim fades the colour itself.
  if (style.dim) {
    const ink = out.color ?? base.content;
    if (/^#[0-9a-f]{6}$/i.test(ink)) out.color = `${ink}99`;
  }
  return out;
}
