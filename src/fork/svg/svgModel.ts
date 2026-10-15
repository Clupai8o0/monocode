export type SvgSize = { width: number; height: number };

const ROOT = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(attrs);
  return match ? (match[1] ?? match[2]).trim() : null;
}

/** A length in user units: `24`, `24px` or `24.5`. Not `%`, `em` or `auto`. */
function length(value: string | null): number | null {
  const match = value ? /^(\d+(?:\.\d+)?|\.\d+)(px)?$/.exec(value) : null;
  const number = match ? Number(match[1]) : NaN;
  return number > 0 ? number : null;
}

/**
 * The size an SVG asks to be drawn at, from the root `width` / `height`,
 * falling back to the `viewBox` (and its ratio when only one side is set).
 * Null when the file gives neither, so the caller can use the image's own
 * size once it loads.
 */
export function svgSize(source: string): SvgSize | null {
  const root = ROOT.exec(
    source.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, ""),
  );
  if (!root) {
    return null;
  }
  const attrs = root[1];
  const width = length(attribute(attrs, "width"));
  const height = length(attribute(attrs, "height"));
  const box = (attribute(attrs, "viewBox") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const boxWidth = box.length === 4 && box[2] > 0 ? box[2] : null;
  const boxHeight = box.length === 4 && box[3] > 0 ? box[3] : null;

  if (width && height) {
    return { width, height };
  }
  if (boxWidth && boxHeight) {
    if (width) {
      return { width, height: (width * boxHeight) / boxWidth };
    }
    if (height) {
      return { width: (height * boxWidth) / boxHeight, height };
    }
    return { width: boxWidth, height: boxHeight };
  }
  return null;
}

/** Scale that fits `size` inside `box` with `padding` on every side. */
export function fitScale(
  size: SvgSize,
  box: { width: number; height: number },
  padding: number,
): number {
  const width = Math.max(1, box.width - padding * 2);
  const height = Math.max(1, box.height - padding * 2);
  return Math.min(width / size.width, height / size.height);
}

export function formatSize(size: SvgSize): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  return `${round(size.width)} × ${round(size.height)}`;
}
