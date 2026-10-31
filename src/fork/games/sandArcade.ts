import type {
  ArcadeMode,
  ArcadeSprite,
  GridArcade,
  LogoPickup,
  SpeechBubble,
} from "../../features/terminal/arcade/gridArcade";
import { BOOT_FADE_MS, IDLE_ROWS, clamp, fadeOut, type Random } from "./kit";

/**
 * Fork: "sand drop". A goal-free falling-sand toy. A spout at the top pours
 * grains that fall and slide into piles; each pour is a new brightness, so
 * the layers show as stripes. Nothing to lose: a full grid drains from below.
 */

export const SHADES = 4;
/** Cells above this share of the board start the drain. */
export const FULL_SHARE = 0.85;
/** The drain stops once the board is back under this share. */
export const DRAINED_SHARE = 0.7;
const STEP_MS = 16;
/** A pour key is held while it keeps arriving more often than this. */
const POUR_HOLD_MS = 160;
const SPOUT_SPEED = 38;
const DRAIN_PER_TICK = 6;
const IDLE_POUR_MS = 1800;
const IDLE_REST_MS = 700;
const SHADE_VALUE = [0.25, 0.45, 0.68, 0.92] as const;

export function createSandArcade(random: Random = Math.random): GridArcade {
  let cols = 0;
  let rows = 0;
  let player = false;
  let mode: ArcadeMode = "mid";
  let booted = 0;
  let accumulator = 0;

  let cells = new Uint8Array(0);
  let count = 0;
  let poured = 0;
  let draining = false;
  let flip = false;
  let jammed = false;

  let spoutX = 0;
  let heading = 0;
  let shade = 1;
  let pourFor = 0;
  let idleX = 0;
  let idleTarget = 0;
  let idleClock = 0;

  const boardRows = () =>
    player ? rows : Math.max(8, Math.floor(rows * IDLE_ROWS));

  const reset = () => {
    booted = 0;
    accumulator = 0;
    cells = new Uint8Array(cols * boardRows());
    count = 0;
    poured = 0;
    draining = false;
    heading = 0;
    pourFor = 0;
    shade = 1;
    spoutX = Math.floor(cols / 2);
    idleX = spoutX;
    idleTarget = spoutX;
    idleClock = 0;
  };

  const startPour = () => {
    if (pourFor <= 0) shade = (shade % SHADES) + 1;
    pourFor = POUR_HOLD_MS;
  };

  const drop = (x: number) => {
    if (x < 0 || x >= cols) return;
    // A pile that reaches the spout is as full as the board gets: drain.
    if (cells[x]) {
      jammed = true;
      return;
    }
    cells[x] = shade;
    count += 1;
    poured += 1;
  };

  const fall = () => {
    const board = boardRows();
    flip = !flip;
    for (let y = board - 2; y >= 0; y--) {
      for (let i = 0; i < cols; i++) {
        const x = flip ? i : cols - 1 - i;
        const at = y * cols + x;
        const value = cells[at];
        if (!value) continue;
        const below = at + cols;
        if (!cells[below]) {
          cells[below] = value;
          cells[at] = 0;
          continue;
        }
        const first = random() < 0.5 ? -1 : 1;
        for (const side of [first, -first]) {
          const nx = x + side;
          if (nx < 0 || nx >= cols || cells[below + side]) continue;
          cells[below + side] = value;
          cells[at] = 0;
          break;
        }
      }
    }
  };

  /** Lift the floor out from under the pile: the bottom row goes, rows above sink. */
  const drain = () => {
    const board = boardRows();
    const floor = (board - 1) * cols;
    let removed = 0;
    for (let x = 0; x < cols && removed < DRAIN_PER_TICK; x++) {
      const at = floor + x;
      if (cells[at]) {
        cells[at] = 0;
        removed += 1;
      }
    }
    count -= removed;
  };

  const tick = (ms: number) => {
    const seconds = ms / 1000;
    const board = boardRows();

    if (player) {
      spoutX = clamp(spoutX + heading * SPOUT_SPEED * seconds, 0, cols - 1);
    } else {
      idleClock += ms;
      if (idleClock > IDLE_POUR_MS + IDLE_REST_MS) {
        idleClock = 0;
        idleTarget = Math.floor(random() * cols);
        shade = (shade % SHADES) + 1;
      }
      const gap = idleTarget - idleX;
      idleX += clamp(gap, -SPOUT_SPEED * 0.5 * seconds, SPOUT_SPEED * 0.5 * seconds);
      spoutX = idleX;
      if (idleClock < IDLE_POUR_MS) pourFor = POUR_HOLD_MS;
    }

    fall();

    if (pourFor > 0) {
      pourFor -= ms;
      drop(Math.round(spoutX));
    }

    const total = cols * board;
    if (count > total * FULL_SHARE) draining = true;
    if (jammed) {
      jammed = false;
      drain();
    }
    if (draining) {
      drain();
      if (count <= total * DRAINED_SHARE) draining = false;
    }
  };

  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

  return {
    resize(nextCols: number, nextRows: number) {
      if (nextCols === cols && nextRows === rows) return;
      cols = nextCols;
      rows = nextRows;
      reset();
    },

    takeControl() {
      if (player) return;
      player = true;
      reset();
    },

    releaseControl() {
      if (!player) return;
      player = false;
      reset();
    },

    steer(x: number, y: number) {
      if (!player) return;
      if (x !== 0) heading = x < 0 ? -1 : 1;
      if (y > 0) startPour();
      else if (y < 0) shade = (shade % SHADES) + 1;
    },

    steerEnd(x: number, _y: number) {
      if (player && x !== 0 && Math.sign(x) === heading) heading = 0;
    },

    action() {
      if (player) startPour();
    },

    setMode(next: ArcadeMode) {
      mode = next;
    },

    mode() {
      return mode;
    },

    controlled() {
      return player;
    },

    score() {
      return player ? poured : 0;
    },

    lives() {
      return 0;
    },

    gameOver() {
      return false;
    },

    step(dt: number) {
      if (!cols || !rows) return;
      booted += dt;
      accumulator += Math.min(dt, 120);
      while (accumulator >= STEP_MS) {
        accumulator -= STEP_MS;
        tick(STEP_MS);
      }
    },

    speechBubble(): SpeechBubble | null {
      return null;
    },

    logoPickup(): LogoPickup | null {
      return null;
    },

    sprites(): ArcadeSprite[] {
      return [];
    },

    fade() {
      return bootAlpha();
    },

    stamp(out: Float32Array, stampCols: number, stampRows: number) {
      const board = boardRows();
      const width = Math.min(cols, stampCols);
      const height = Math.min(board, stampRows);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const value = cells[y * cols + x];
          if (value) out[y * stampCols + x] = SHADE_VALUE[value - 1] ?? 0.5;
        }
      }
      // The spout: a bright cell at the top while it is yours or pouring.
      if (player || pourFor > 0) {
        const x = Math.round(spoutX);
        if (x >= 0 && x < stampCols) out[x] = Math.max(out[x] ?? 0, 1);
      }
      fadeOut(out, clamp(bootAlpha(), 0, 1));
    },
  };
}
