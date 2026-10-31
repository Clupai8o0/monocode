import type {
  ArcadeMode,
  ArcadeSprite,
  GridArcade,
  LogoPickup,
  SpeechBubble,
} from "../../features/terminal/arcade/gridArcade";
import {
  BOOT_FADE_MS,
  IDLE_ROWS,
  clamp,
  fadeOut,
  lightRect,
  type Random,
} from "./kit";

/**
 * Fork: "stack tower". A block slides across the top of the tower; drop it and
 * whatever hangs over the edge is cut away, so the next block is only as wide
 * as what landed. A drop within `PERFECT_TOLERANCE` cells snaps true, keeps its
 * width and scores a bonus. The game is calm: modes only change the slide speed.
 */

/** Cells per second the block slides at. */
export const SLIDE_SPEED: Record<ArcadeMode, number> = {
  low: 20,
  mid: 28,
  hard: 40,
};
export const PERFECT_TOLERANCE = 1;
export const PERFECT_BONUS = 2;
export const MOVER_VALUE = 0.95;
const TOWER_VALUE = 0.55;
const TOP_VALUE = 0.75;
const FLASH_VALUE = 1;
const DEBRIS_VALUE = 0.3;

const IDLE_SPEED = 24;
const IDLE_RESET_LEVELS = 30;
/** The idle player only fumbles a drop while the block is still wide. */
const IDLE_SLOPPY_WIDTH = 8;
const IDLE_SLOPPY_CHANCE = 0.25;

const STEP_MS = 16;
const FLASH_MS = 320;
const OVER_RETRY_MS = 700;
const OVER_RESTART_MS = 1800;
const DEBRIS_GRAVITY = 90;
const CAMERA_EASE = 6;
const MIN_WIDTH = 6;
const MAX_WIDTH = 40;

type Level = { x: number; w: number };
type Debris = { x: number; w: number; level: number; fall: number; vy: number };

export function createStackArcade(random: Random = Math.random): GridArcade {
  let cols = 0;
  let rows = 0;
  let player = false;
  let mode: ArcadeMode = "mid";
  let booted = 0;

  let levels: Level[] = [];
  let slide = 0;
  let width = 0;
  let dir = 1;
  let aim = 0;
  let camera = 0;
  let bonus = 0;
  let flash = 0;
  let over = false;
  let overFor = 0;
  let accumulator = 0;
  let debris: Debris[] = [];

  const boardRows = () =>
    player ? rows : Math.max(8, Math.floor(rows * IDLE_ROWS));

  const blockHeight = () => clamp(Math.floor(boardRows() / 10), 2, 3);

  const ground = () => boardRows() - 2;

  const speed = () => (player ? SLIDE_SPEED[mode] : IDLE_SPEED);

  const top = () => levels[levels.length - 1]!;

  const reach = () => Math.max(0, cols - width);

  const chooseAim = () => {
    const t = top();
    let target = t.x;
    if (width >= IDLE_SLOPPY_WIDTH && random() < IDLE_SLOPPY_CHANCE) {
      const off = 2 + Math.floor(random() * 2);
      target += random() < 0.5 ? -off : off;
    }
    aim = clamp(target, 0, reach());
  };

  const enter = () => {
    // Blocks arrive from alternating sides, so the rhythm never settles.
    const fromLeft = levels.length % 2 === 1;
    dir = fromLeft ? 1 : -1;
    slide = fromLeft ? 0 : reach();
    chooseAim();
  };

  const reset = () => {
    booted = 0;
    bonus = 0;
    flash = 0;
    over = false;
    overFor = 0;
    accumulator = 0;
    camera = 0;
    debris = [];
    width = Math.min(cols, clamp(Math.floor(cols * 0.3), MIN_WIDTH, MAX_WIDTH));
    levels = [{ x: Math.floor((cols - width) / 2), w: width }];
    enter();
  };

  const drop = () => {
    if (over || !levels.length) return;
    const t = top();
    const x = Math.round(slide);
    const left = Math.max(x, t.x);
    const right = Math.min(x + width, t.x + t.w);
    const level = levels.length;
    if (right - left <= 0) {
      over = true;
      overFor = 0;
      debris.push({ x, w: width, level, fall: 0, vy: 0 });
      return;
    }
    if (Math.abs(x - t.x) <= PERFECT_TOLERANCE) {
      levels.push({ x: t.x, w: t.w });
      width = t.w;
      bonus += PERFECT_BONUS;
      flash = FLASH_MS;
    } else {
      levels.push({ x: left, w: right - left });
      const overhang = x + width - (t.x + t.w);
      if (x < t.x) {
        debris.push({ x, w: t.x - x, level, fall: 0, vy: 0 });
      }
      if (overhang > 0) {
        debris.push({ x: t.x + t.w, w: overhang, level, fall: 0, vy: 0 });
      }
      width = right - left;
    }
    enter();
  };

  const think = () => {
    if (dir > 0 ? slide >= aim : slide <= aim) drop();
  };

  const tick = (ms: number) => {
    const seconds = ms / 1000;
    flash = Math.max(0, flash - ms);

    if (!over) {
      slide += dir * speed() * seconds;
      const end = reach();
      if (slide >= end) {
        slide = end;
        dir = -1;
      } else if (slide <= 0) {
        slide = 0;
        dir = 1;
      }
      if (!player) think();
    }

    for (const piece of debris) {
      piece.vy += DEBRIS_GRAVITY * seconds;
      piece.fall += piece.vy * seconds;
    }
    debris = debris.filter((it) => it.fall < boardRows() + 6);

    const target = Math.max(
      0,
      (levels.length + 1) * blockHeight() - Math.floor(boardRows() * 0.55),
    );
    camera += (target - camera) * Math.min(1, seconds * CAMERA_EASE);
  };

  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

  const score = () => levels.length - 1 + bonus;

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
      if (player && !over && x === 0 && y > 0) drop();
    },

    action() {
      if (!player) return;
      if (!over) {
        drop();
      } else if (overFor >= OVER_RETRY_MS) {
        reset();
      }
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
      return player ? score() : 0;
    },

    lives() {
      return 0;
    },

    gameOver() {
      return player && over;
    },

    step(dt: number) {
      if (!cols || !rows) return;
      booted += dt;
      if (over) {
        overFor += dt;
        if (!player && overFor >= OVER_RESTART_MS) reset();
      }
      accumulator += Math.min(dt, 120);
      while (accumulator >= STEP_MS) {
        accumulator -= STEP_MS;
        tick(STEP_MS);
      }
      if (!player && levels.length > IDLE_RESET_LEVELS) reset();
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
      if (!levels.length) return;
      const bh = blockHeight();
      const clip = Math.min(stampRows, boardRows());
      const rowOf = (level: number, fall = 0) =>
        Math.round(ground() - (level + 1) * bh + camera + fall);

      levels.forEach((it, index) => {
        const last = index === levels.length - 1;
        const value = last
          ? flash > 0
            ? FLASH_VALUE
            : TOP_VALUE
          : TOWER_VALUE;
        lightRect(out, stampCols, clip, it.x, rowOf(index), it.w, bh, value);
      });

      for (const piece of debris) {
        lightRect(
          out,
          stampCols,
          clip,
          piece.x,
          rowOf(piece.level, piece.fall),
          piece.w,
          bh,
          DEBRIS_VALUE,
        );
      }

      if (!over) {
        lightRect(
          out,
          stampCols,
          clip,
          Math.round(slide),
          rowOf(levels.length),
          width,
          bh,
          MOVER_VALUE,
        );
      }

      fadeOut(out, clamp(bootAlpha(), 0, 1));
    },
  };
}
