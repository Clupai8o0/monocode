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
  light,
  lightRect,
  type Random,
} from "./kit";

/**
 * Fork: "token rain". Tokens fall into a bucket and fill the context window,
 * a meter on the right edge. Compacting (Space) banks the fill as score, and
 * banking a window that is over 75% full pays double, so greed is rewarded
 * until the window overflows and costs a life. Cache hits score directly, and
 * errors cost a life if caught.
 */

export const CAPACITY = 40;
export const START_LIVES = 3;
export const CACHE_SCORE = 5;
export const RISK_THRESHOLD = 0.75;
/** Rows per second that things fall at. */
export const FALL_SPEED: Record<ArcadeMode, number> = {
  low: 9,
  mid: 12,
  hard: 16,
};
/** Chance that a spawn is an error. */
export const ERROR_CHANCE: Record<ArcadeMode, number> = {
  low: 0.1,
  mid: 0.16,
  hard: 0.24,
};

const CACHE_CHANCE = 0.06;
const BUCKET_W = 7;
const BUCKET_H = 2;
const METER_W = 2;
const PLAYER_STEP = 2;
const TOKEN_VALUE = 0.75;
const CACHE_VALUE = 1;
const BUCKET_VALUE = 0.85;
const METER_EMPTY = 0.12;

const IDLE_MOVE = 30;
const IDLE_COMPACT_AT = 0.8;
const IDLE_ERROR_LOOKAHEAD = 12;

const STEP_MS = 16;
const SPAWN_MS = 520;
const RAMP_MS = 120_000;
const MAX_PACE = 2.2;
const FLASH_MS = 360;
const OVER_RETRY_MS = 700;
const OVER_RESTART_MS = 1800;

type Kind = "token" | "cache" | "error";
type Drop = { kind: Kind; x: number; y: number; w: number; landed: boolean };
type Flash = "compact" | "overflow" | null;

const SIZE: Record<Kind, number> = { token: 1, cache: 2, error: 3 };

/** Test hooks, kept out of the GridArcade surface. */
export type RainProbe = {
  spawn(kind: Kind, x: number, y?: number): void;
  setFill(value: number): void;
  fill(): number;
  bucketX(): number;
  bucketY(): number;
  quiet(on: boolean): void;
};
const probes = new WeakMap<GridArcade, RainProbe>();
export const rainProbe = (arcade: GridArcade) => probes.get(arcade);

export function createRainArcade(random: Random = Math.random): GridArcade {
  let cols = 0;
  let rows = 0;
  let player = false;
  let mode: ArcadeMode = "mid";
  let booted = 0;

  let drops: Drop[] = [];
  let bucket = 0;
  let fill = 0;
  let banked = 0;
  let lives = START_LIVES;
  let flash: Flash = null;
  let flashFor = 0;
  let over = false;
  let overFor = 0;
  let elapsed = 0;
  let spawnIn = 0;
  let accumulator = 0;
  let moveDebt = 0;
  let silent = false;

  const boardRows = () =>
    player ? rows : Math.max(8, Math.floor(rows * IDLE_ROWS));
  const playWidth = () => Math.max(BUCKET_W, cols - METER_W - 1);
  const bucketY = () => boardRows() - BUCKET_H;
  const maxBucket = () => Math.max(0, playWidth() - BUCKET_W);
  const pace = () => Math.min(MAX_PACE, 1 + elapsed / RAMP_MS);

  const reset = () => {
    booted = 0;
    drops = [];
    fill = 0;
    banked = 0;
    lives = START_LIVES;
    flash = null;
    flashFor = 0;
    over = false;
    overFor = 0;
    elapsed = 0;
    spawnIn = SPAWN_MS;
    accumulator = 0;
    moveDebt = 0;
    bucket = Math.floor(maxBucket() / 2);
  };

  const showFlash = (kind: Flash) => {
    flash = kind;
    flashFor = FLASH_MS;
  };

  const loseLife = () => {
    lives -= 1;
    if (lives <= 0) {
      lives = 0;
      over = true;
      overFor = 0;
    }
  };

  const compact = () => {
    if (over || fill <= 0) return;
    const risky = fill / CAPACITY > RISK_THRESHOLD;
    banked += risky ? fill * 2 : fill;
    fill = 0;
    showFlash("compact");
  };

  const spawn = (kind?: Kind, x?: number, y = 0) => {
    let picked = kind;
    if (!picked) {
      const roll = random();
      const errors = ERROR_CHANCE[mode];
      picked =
        roll < errors ? "error" : roll < errors + CACHE_CHANCE ? "cache" : "token";
    }
    const w = SIZE[picked];
    const at = x ?? Math.floor(random() * (playWidth() - w + 1));
    drops.push({ kind: picked, x: at, y, w, landed: false });
  };

  const catchDrop = (it: Drop) => {
    if (it.kind === "token") {
      fill += 1;
      if (fill >= CAPACITY) {
        fill = 0;
        showFlash("overflow");
        loseLife();
      }
    } else if (it.kind === "cache") {
      banked += CACHE_SCORE;
    } else {
      loseLife();
    }
  };

  const move = (dx: number) => {
    bucket = clamp(bucket + dx, 0, maxBucket());
  };

  const think = (seconds: number) => {
    if (fill / CAPACITY >= IDLE_COMPACT_AT) compact();

    const by = bucketY();
    const centre = () => bucket + BUCKET_W / 2;
    const incoming = drops.filter((it) => !it.landed && it.y < by);
    const wanted = incoming
      .filter((it) => it.kind !== "error")
      .sort((a, b) => b.y - a.y)[0];
    let goal = wanted ? wanted.x + wanted.w / 2 : playWidth() / 2;

    // Step away from an error that would land on the bucket before the goal does.
    for (const err of incoming) {
      if (err.kind !== "error" || by - err.y > IDLE_ERROR_LOOKAHEAD) continue;
      // The bucket's centre is unsafe inside this span; the edges are the nearest safe spots.
      const half = BUCKET_W / 2;
      const left = err.x - half - 0.5;
      const right = err.x + err.w + half + 0.5;
      if (goal > left && goal < right) {
        goal = Math.abs(centre() - left) < Math.abs(centre() - right) ? left : right;
      }
    }

    moveDebt += IDLE_MOVE * seconds;
    while (moveDebt >= 1) {
      moveDebt -= 1;
      const diff = goal - centre();
      if (Math.abs(diff) < 1) break;
      move(diff > 0 ? 1 : -1);
    }
  };

  const tick = (ms: number) => {
    const seconds = ms / 1000;
    flashFor = Math.max(0, flashFor - ms);
    if (flashFor === 0) flash = null;
    if (over) return;

    elapsed += ms;
    if (!player) think(seconds);

    if (!silent) {
      spawnIn -= ms;
      if (spawnIn <= 0) {
        spawn();
        spawnIn += SPAWN_MS / pace();
      }
    }

    const fall = FALL_SPEED[mode] * pace() * seconds;
    const by = bucketY();
    const kept: Drop[] = [];
    for (const it of drops) {
      it.y += fall;
      const bottom = Math.floor(it.y) + it.w;
      if (!it.landed && bottom >= by + 1) {
        // Judged once, when it reaches the bucket's rim, so sliding under later is no catch.
        it.landed = true;
        if (it.x < bucket + BUCKET_W && it.x + it.w > bucket) {
          catchDrop(it);
          if (over) break;
          continue;
        }
      }
      if (Math.floor(it.y) < boardRows()) kept.push(it);
    }
    drops = kept;
  };

  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

  const arcade: GridArcade = {
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

    steer(x: number, _y: number) {
      if (player && !over && x !== 0) move(Math.sign(x) * PLAYER_STEP);
    },

    action() {
      if (!player) return;
      if (!over) {
        compact();
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
      return player ? Math.round(banked) : 0;
    },

    lives() {
      return player ? lives : 0;
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
      if (!cols || !rows) return;
      const clip = Math.min(stampRows, boardRows());
      const pulse = 0.65 + 0.35 * Math.sin(elapsed / 90);

      for (const it of drops) {
        const x = it.x;
        const y = Math.floor(it.y);
        if (it.kind === "token") {
          light(out, stampCols, clip, x, y, TOKEN_VALUE);
        } else if (it.kind === "cache") {
          lightRect(out, stampCols, clip, x, y, 2, 2, CACHE_VALUE);
        } else {
          // An X, so it reads as a hazard and not as a bigger token.
          for (const [dx, dy] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]] as const) {
            light(out, stampCols, clip, x + dx, y + dy, pulse);
          }
        }
      }

      // Open-topped bucket: a floor and two walls.
      const by = bucketY();
      lightRect(out, stampCols, clip, bucket, by + 1, BUCKET_W, 1, BUCKET_VALUE);
      light(out, stampCols, clip, bucket, by, BUCKET_VALUE);
      light(out, stampCols, clip, bucket + BUCKET_W - 1, by, BUCKET_VALUE);

      // Context meter fills bottom-up and brightens as the window nears full.
      const height = boardRows();
      const left = cols - METER_W;
      const ratio = clamp(fill / CAPACITY, 0, 1);
      const lit = Math.round(ratio * height);
      const flashValue =
        flash === "compact" ? 1 : flash === "overflow" ? 0.18 : null;
      for (let i = 0; i < height; i++) {
        const y = height - 1 - i;
        let value = i < lit ? 0.35 + 0.6 * ratio : METER_EMPTY;
        if (flashValue !== null) {
          value = flash === "compact" ? flashValue : Math.min(value, flashValue);
        }
        lightRect(out, stampCols, clip, left, y, METER_W, 1, value);
      }

      fadeOut(out, clamp(bootAlpha(), 0, 1));
    },
  };

  probes.set(arcade, {
    spawn: (kind, x, y) => spawn(kind, x, y),
    setFill: (value) => {
      fill = value;
    },
    fill: () => fill,
    bucketX: () => bucket,
    bucketY,
    quiet: (on) => {
      silent = on;
    },
  });

  return arcade;
}
