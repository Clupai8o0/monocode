/**
 * Fork feature: turns one ANSI-coloured status line into styled text runs.
 * Handles the SGR codes status lines use: reset, bold, dim, italic, the 16
 * basic colours, 256-colour and truecolour, for text and background.
 */

export type AnsiStyle = {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
};

export type AnsiRun = { text: string; style: AnsiStyle };

const BASIC = [
  "#1e1e1e", "#e06c75", "#98c379", "#e5c07b",
  "#61afef", "#c678dd", "#56b6c2", "#d4d4d4",
  "#7f848e", "#ff7b86", "#b5e890", "#ffd68a",
  "#7cc5ff", "#de9bff", "#7fdbe6", "#ffffff",
];

function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return BASIC[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

/** Reads `38;5;n` or `38;2;r;g;b` starting at codes[at]; returns colour and codes used. */
function extended(codes: number[], at: number): [string | undefined, number] {
  if (codes[at] === 5) return [color256(codes[at + 1]), 2];
  if (codes[at] === 2) {
    const [r, g, b] = codes.slice(at + 1, at + 4);
    const ok = [r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255);
    return [ok ? `rgb(${r},${g},${b})` : undefined, 4];
  }
  return [undefined, 0];
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(";").map((p) => (p === "" ? 0 : Number(p)));
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 39) delete next.color;
    else if (code === 49) delete next.background;
    else if (code >= 30 && code <= 37) next.color = BASIC[code - 30];
    else if (code >= 90 && code <= 97) next.color = BASIC[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.background = BASIC[code - 40];
    else if (code >= 100 && code <= 107) next.background = BASIC[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const [value, used] = extended(codes, i + 1);
      if (value) next[code === 38 ? "color" : "background"] = value;
      i += used;
    }
  }
  return next;
}

// SGR, other CSI sequences, and OSC sequences such as hyperlinks.
const ESCAPES = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function parseAnsi(line: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = runs[runs.length - 1];
    if (prev && JSON.stringify(prev.style) === JSON.stringify(style)) {
      prev.text += text;
    } else {
      runs.push({ text, style });
    }
  };
  for (const match of line.matchAll(ESCAPES)) {
    push(line.slice(last, match.index));
    if (match[1] !== undefined) style = applySgr(style, match[1]);
    last = match.index + match[0].length;
  }
  // Drop any stray control characters left over.
  push(line.slice(last).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
  return runs;
}
