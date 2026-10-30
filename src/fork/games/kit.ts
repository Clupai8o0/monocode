/** Fork: small helpers the panel's grid games share. */
import type { SpeechBubble } from "../../features/terminal/arcade/gridArcade";

export const BOOT_FADE_MS = 420;
const SPEECH_FADE_MS = 260;
const SPEECH_HOLD_MS = 2200;

/** Idle boards keep to the band's unmasked top; a player gets every row. */
export const IDLE_ROWS = 0.62;

export type Random = () => number;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function light(
  out: Float32Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
  value: number,
) {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return;
  const index = y * cols + x;
  if ((out[index] ?? 0) < value) out[index] = value;
}

export function lightRect(
  out: Float32Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
) {
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      light(out, cols, rows, px, py, value);
    }
  }
}

/** Stable noise for a column index, so scenery scrolls without being stored. */
export function hash(value: number) {
  let n = Math.imul(value | 0, 2654435761) >>> 0;
  n ^= n >>> 15;
  n = Math.imul(n, 2246822519) >>> 0;
  return (n ^ (n >>> 13)) >>> 0;
}

export function fadeOut(out: Float32Array, alpha: number) {
  if (alpha >= 0.999) return;
  for (let i = 0; i < out.length; i++) out[i] *= alpha;
}

/** One line at a time, never the same twice running, fading in and out. */
export function createChatter(lines: readonly string[], random: Random) {
  let text: string | null = null;
  let age = 0;
  let last = -1;

  return {
    say() {
      let index = last;
      while (index === last && lines.length > 1) {
        index = Math.floor(random() * lines.length);
      }
      last = index;
      text = lines[index] ?? null;
      age = 0;
    },
    step(dt: number) {
      if (!text) return;
      age += dt;
      if (age >= SPEECH_HOLD_MS + SPEECH_FADE_MS) text = null;
    },
    clear() {
      text = null;
    },
    bubble(x: number, y: number, alpha = 1): SpeechBubble | null {
      if (!text) return null;
      const fadeIn = Math.min(1, age / SPEECH_FADE_MS);
      const fadeAway = Math.max(0, 1 - (age - SPEECH_HOLD_MS) / SPEECH_FADE_MS);
      return { text, x, y, alpha: Math.min(fadeIn, fadeAway) * alpha };
    },
  };
}
