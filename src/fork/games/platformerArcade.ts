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
  createChatter,
  fadeOut,
  hash,
  lightRect,
  type Random,
} from "./kit";

/**
 * Fork: "mono bros", a side-scrolling platformer with its own art. The level
 * is built a column at a time as the camera walks right, and the camera never
 * walks back. World units are tiles, y up, with the bottom of the board at 0.
 */

const RUN_SPEED = 9.5;
const RUN_ACCEL = 62;
const RUN_FRICTION = 48;
const GRAVITY = 46;
export const JUMP_VELOCITY = 17.2;
const RELEASE_CUT = 0.5;
const STOMP_BOUNCE = 11;
const FALL_LIMIT = 24;
const COYOTE_MS = 90;
const JUMP_BUFFER_MS = 110;
const INVULNERABLE_MS = 1600;
const START_LIVES = 3;
const STEP_MS = 16;

const BODY_W = 0.72;
const BODY_H = 0.9;
const ENEMY_W = 0.8;
const ENEMY_H = 0.8;
const ENEMY_SPEED: Record<ArcadeMode, number> = { low: 1.5, mid: 2.2, hard: 3 };
const ENEMY_CHANCE: Record<ArcadeMode, number> = {
  low: 0.3,
  mid: 0.5,
  hard: 0.75,
};

export const MAX_GAP = 3;
export const MAX_STEP = 2;
const MAX_GROUND = 3;
const BLOCK_LIFT = 3;
const START_FLAT = 16;

const COIN_POINTS = 1;
const QUESTION_POINTS = 2;
const BRICK_POINTS = 1;
const STOMP_POINTS = 3;
const TILES_PER_POINT = 8;
const CAMERA_LEAD = 0.38;
const COLUMNS_AHEAD = 6;

const MASCOT = "frog";
const ENEMY_MASCOT = "crab";

const TOP_VALUE = 0.62;
const DIRT_VALUE = 0.24;
const BRICK_VALUE = 0.58;
const QUESTION_VALUE = 0.9;
const USED_VALUE = 0.34;
const COIN_VALUE = 0.95;
const CLOUD_VALUE = 0.08;

const CHATTER = [
  "WRONG CASTLE",
  "HOLD MY TOKENS",
  "COIN COUNT: NOT BILLABLE",
  "THE AGENTS CAN WAIT",
  "NICE",
  "BONK",
  "DIDN'T SEE THAT PIT",
  "STILL COMPILING",
];

type Tile = "brick" | "question" | "used";
type Coin = { x: number; y: number };
type Enemy = {
  x: number;
  y: number;
  dir: 1 | -1;
  minX: number;
  maxX: number;
};

/** Falling and coming down on the top half counts; anything else is a hit. */
export function isStomp(
  velocity: number,
  feet: number,
  enemyY: number,
  enemyHeight: number,
) {
  return velocity < 0 && feet > enemyY + enemyHeight * 0.4;
}

export function jumpHeight() {
  return (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
}

const key = (x: number, y: number) => `${x},${y}`;

export type PlatformerArcade = GridArcade & {
  /** How far right the run has got, in tiles. */
  progress(): number;
  /** Ground height per column built so far, for checking the level is fair. */
  groundProfile(): readonly number[];
};

export function createPlatformerArcade(
  random: Random = Math.random,
): PlatformerArcade {
  let cols = 0;
  let rows = 0;
  let player = false;
  let mode: ArcadeMode = "mid";
  let booted = 0;

  // The level.
  let ground: number[] = [];
  let tiles = new Map<string, Tile>();
  let coins: Coin[] = [];
  let enemies: Enemy[] = [];
  let builtHeight = 1;

  // The hero.
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let facing: 1 | -1 = 1;
  let onGround = false;
  let coyote = 0;
  let buffered = 0;
  let jumpHeld = false;
  let leftHeld = false;
  let rightHeld = false;
  /** Whichever direction went down last wins while both are held. */
  let lastDir: 1 | -1 = 1;
  let invulnerable = 0;
  let camera = 0;
  let farthest = 0;

  let score = 0;
  let lives = START_LIVES;
  let over = false;
  let accumulator = 0;
  const chatter = createChatter(CHATTER, random);

  const tileSize = () =>
    player ? Math.max(1, Math.floor(Math.min(rows / 14, cols / 24))) : 2;

  const boardRows = () =>
    player ? rows : Math.max(8, Math.floor(rows * IDLE_ROWS));

  const viewTiles = () => cols / tileSize();

  const groundAt = (column: number) => ground[column] ?? 0;

  const solid = (column: number, row: number) =>
    row < groundAt(column) || tiles.has(key(column, row));

  /** One flat stretch, then a change of height or a gap to the next. */
  const buildSegment = () => {
    const start = ground.length;
    const flat = 5 + Math.floor(random() * 9);
    for (let i = 0; i < flat; i++) ground.push(builtHeight);

    // Keep decoration well inside the flat, so a block is never in the way of
    // the jump up a step or over a gap.
    if (flat >= 7) {
      const roll = random();
      const at = start + 2 + Math.floor(random() * (flat - 6));
      const row = builtHeight + BLOCK_LIFT;
      if (roll < 0.34) {
        tiles.set(key(at, row), "brick");
        tiles.set(key(at + 1, row), "question");
        tiles.set(key(at + 2, row), "brick");
      } else if (roll < 0.58) {
        tiles.set(key(at + 1, row), "question");
      } else if (roll < 0.82) {
        for (let i = 0; i < 3; i++) {
          coins.push({ x: at + i + 0.5, y: builtHeight + 1.6 });
        }
      }
    }
    if (flat >= 8 && random() < ENEMY_CHANCE[mode]) {
      const minX = start + 1;
      const maxX = start + flat - 1 - ENEMY_W;
      enemies.push({
        x: minX + random() * (maxX - minX),
        y: builtHeight,
        dir: random() < 0.5 ? 1 : -1,
        minX,
        maxX,
      });
    }

    const roll = random();
    if (roll < 0.42) {
      const gap = 1 + Math.floor(random() * MAX_GAP);
      for (let i = 0; i < gap; i++) ground.push(0);
    } else if (roll < 0.8) {
      const change =
        (1 + Math.floor(random() * MAX_STEP)) * (random() < 0.5 ? 1 : -1);
      builtHeight = clamp(builtHeight + change, 1, MAX_GROUND);
    }
  };

  const buildTo = (column: number) => {
    while (ground.length <= column) buildSegment();
  };

  /** Forget what the camera has left behind. */
  const prune = () => {
    const edge = camera - 4;
    for (const id of tiles.keys()) {
      if (Number(id.split(",")[0]) < edge) tiles.delete(id);
    }
    if (coins.some((coin) => coin.x < edge)) {
      coins = coins.filter((coin) => coin.x >= edge);
    }
    if (enemies.some((enemy) => enemy.maxX < edge)) {
      enemies = enemies.filter((enemy) => enemy.maxX >= edge);
    }
  };

  const newRun = () => {
    ground = new Array<number>(START_FLAT).fill(1);
    tiles = new Map();
    coins = [];
    enemies = [];
    builtHeight = 1;
    x = 3;
    y = 1;
    vx = 0;
    vy = 0;
    facing = 1;
    onGround = true;
    coyote = 0;
    buffered = 0;
    jumpHeld = false;
    leftHeld = false;
    rightHeld = false;
    invulnerable = 0;
    camera = 0;
    farthest = 0;
    score = 0;
    lives = START_LIVES;
    over = false;
    accumulator = 0;
    chatter.clear();
    buildTo(Math.ceil(viewTiles()) + COLUMNS_AHEAD);
  };

  const boot = () => {
    booted = 0;
    newRun();
  };

  const press = () => {
    if (jumpHeld) return;
    jumpHeld = true;
    buffered = JUMP_BUFFER_MS;
  };

  const release = () => {
    jumpHeld = false;
    if (vy > 0) vy *= RELEASE_CUT;
  };

  /** Back on the first solid footing in view, with a moment to get bearings. */
  const respawn = () => {
    let column = Math.max(Math.ceil(camera) + 1, 0);
    buildTo(column + 8);
    while (
      groundAt(column) === 0 ||
      groundAt(column + 1) === 0 ||
      enemies.some((enemy) => Math.abs(enemy.x - column) < 3)
    ) {
      column += 1;
      buildTo(column + 8);
    }
    x = column + 0.1;
    y = groundAt(column);
    vx = 0;
    vy = 0;
    onGround = true;
    invulnerable = INVULNERABLE_MS;
  };

  const lose = () => {
    if (invulnerable > 0) return;
    if (player) {
      lives -= 1;
      if (lives <= 0) {
        lives = 0;
        over = true;
        return;
      }
    }
    chatter.say();
    respawn();
  };

  const hitBlock = (column: number, row: number) => {
    const tile = tiles.get(key(column, row));
    if (tile === "brick") {
      tiles.delete(key(column, row));
      if (player) score += BRICK_POINTS;
    } else if (tile === "question") {
      tiles.set(key(column, row), "used");
      if (player) score += QUESTION_POINTS;
      chatter.say();
    }
  };

  const moveX = (dx: number) => {
    x += dx;
    const bottom = Math.floor(y + 0.001);
    const top = Math.floor(y + BODY_H - 0.001);
    if (dx > 0) {
      const column = Math.floor(x + BODY_W);
      for (let row = bottom; row <= top; row++) {
        if (solid(column, row)) {
          x = column - BODY_W - 0.001;
          vx = 0;
          return;
        }
      }
    } else if (dx < 0) {
      const column = Math.floor(x);
      for (let row = bottom; row <= top; row++) {
        if (solid(column, row)) {
          x = column + 1.001;
          vx = 0;
          return;
        }
      }
    }
  };

  const moveY = (dy: number) => {
    y += dy;
    onGround = false;
    const first = Math.floor(x + 0.001);
    const last = Math.floor(x + BODY_W - 0.001);
    if (dy <= 0) {
      const row = Math.floor(y);
      for (let column = first; column <= last; column++) {
        if (solid(column, row)) {
          y = row + 1;
          vy = 0;
          onGround = true;
          return;
        }
      }
    } else {
      const row = Math.floor(y + BODY_H);
      // The block nearest the head's middle takes the bump.
      const middle = Math.floor(x + BODY_W / 2);
      const order = [middle, first, last];
      for (const column of order) {
        if (solid(column, row)) {
          if (tiles.has(key(column, row))) hitBlock(column, row);
          y = row - BODY_H - 0.001;
          vy = 0;
          return;
        }
      }
    }
  };

  /** Run right; hop anything the next couple of tiles would trip over. */
  const wantsJump = () => {
    const feet = Math.floor(x + BODY_W);
    const standing = Math.round(y);
    const ahead = [feet + 1, feet + 2];
    const trouble = ahead.some(
      (column) => groundAt(column) === 0 || groundAt(column) > standing,
    );
    const enemyNear = enemies.some(
      (enemy) => enemy.x > x && enemy.x - x < 3 && Math.abs(enemy.y - y) < 1.5,
    );
    return trouble || enemyNear;
  };

  const tick = (ms: number) => {
    const seconds = ms / 1000;
    let move = 0;
    if (player) {
      if (leftHeld && rightHeld) move = lastDir;
      else if (leftHeld) move = -1;
      else if (rightHeld) move = 1;
    } else {
        move = 1;
      if (wantsJump() && (onGround || coyote > 0)) buffered = JUMP_BUFFER_MS;
    }

    if (move !== 0) {
      facing = move > 0 ? 1 : -1;
      const target = move * RUN_SPEED;
      vx += clamp(target - vx, -RUN_ACCEL * seconds, RUN_ACCEL * seconds);
    } else {
      vx -= clamp(vx, -RUN_FRICTION * seconds, RUN_FRICTION * seconds);
    }

    coyote = onGround ? COYOTE_MS : Math.max(0, coyote - ms);
    buffered = Math.max(0, buffered - ms);
    invulnerable = Math.max(0, invulnerable - ms);
    if (buffered > 0 && coyote > 0) {
      vy = JUMP_VELOCITY;
      buffered = 0;
      coyote = 0;
      onGround = false;
    }

    vy = Math.max(-FALL_LIMIT, vy - GRAVITY * seconds);
    moveX(vx * seconds);
    moveY(vy * seconds);

    // The camera only walks right, and it's also the left wall.
    camera = Math.max(camera, x - viewTiles() * CAMERA_LEAD);
    if (x < camera) {
      x = camera;
      vx = Math.max(0, vx);
    }
    buildTo(Math.ceil(camera + viewTiles()) + COLUMNS_AHEAD);
    prune();

    if (player && x > farthest) {
      const before = Math.floor(farthest / TILES_PER_POINT);
      farthest = x;
      score += Math.floor(farthest / TILES_PER_POINT) - before;
    } else if (x > farthest) {
      farthest = x;
    }

    coins = coins.filter((coin) => {
      const near =
        Math.abs(coin.x - (x + BODY_W / 2)) < 0.8 &&
        Math.abs(coin.y - (y + BODY_H / 2)) < 0.9;
      if (near && player) score += COIN_POINTS;
      return !near;
    });

    const viewEnd = camera + viewTiles() + 2;
    for (const enemy of [...enemies]) {
      if (enemy.x > viewEnd) continue;
      enemy.x += enemy.dir * ENEMY_SPEED[mode] * seconds;
      if (enemy.x <= enemy.minX) {
        enemy.x = enemy.minX;
        enemy.dir = 1;
      } else if (enemy.x >= enemy.maxX) {
        enemy.x = enemy.maxX;
        enemy.dir = -1;
      }
      const touching =
        x + BODY_W > enemy.x &&
        x < enemy.x + ENEMY_W &&
        y + BODY_H > enemy.y &&
        y < enemy.y + ENEMY_H;
      if (!touching) continue;
      if (isStomp(vy, y, enemy.y, ENEMY_H)) {
        enemies = enemies.filter((it) => it !== enemy);
        vy = STOMP_BOUNCE;
        if (player) score += STOMP_POINTS;
        chatter.say();
      } else {
        lose();
        return;
      }
    }

    // A pit always counts, or a fall during the grace period would never end.
    if (y < -2) {
      invulnerable = 0;
      lose();
    }
  };

  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

  return {
    resize(nextCols: number, nextRows: number) {
      if (nextCols === cols && nextRows === rows) return;
      const keep = player && cols > 0 && ground.length > 0;
      cols = nextCols;
      rows = nextRows;
      if (keep) buildTo(Math.ceil(camera + viewTiles()) + COLUMNS_AHEAD);
      else boot();
    },

    takeControl() {
      if (player) return;
      player = true;
      boot();
    },

    releaseControl() {
      if (!player) return;
      player = false;
      boot();
    },

    steer(sx: number, sy: number) {
      if (!player || over) return;
      if (sx < 0) {
        leftHeld = true;
        lastDir = -1;
      } else if (sx > 0) {
        rightHeld = true;
        lastDir = 1;
      } else if (sy < 0) {
        press();
      }
    },

    steerEnd(sx: number, sy: number) {
      if (!player) return;
      if (sx < 0) leftHeld = false;
      else if (sx > 0) rightHeld = false;
      else if (sy < 0) release();
    },

    action() {
      if (!player) return;
      if (over) newRun();
      else press();
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
      return score;
    },

    lives() {
      return lives;
    },

    gameOver() {
      return player && over;
    },

    step(dt: number) {
      if (!cols || !rows) return;
      booted += dt;
      chatter.step(dt);
      if (over) return;
      accumulator += Math.min(dt, 120);
      while (accumulator >= STEP_MS && !over) {
        accumulator -= STEP_MS;
        tick(STEP_MS);
      }
    },

    speechBubble(): SpeechBubble | null {
      const size = tileSize();
      return chatter.bubble(
        Math.round((x + BODY_W / 2 - camera) * size),
        Math.round(boardRows() - (y + BODY_H + 0.4) * size),
        bootAlpha(),
      );
    },

    logoPickup(): LogoPickup | null {
      return null;
    },

    sprites(): ArcadeSprite[] {
      const size = tileSize();
      const board = boardRows();
      const blink =
        invulnerable > 0 && Math.floor(invulnerable / 120) % 2 === 0 ? 0.3 : 1;
      const out: ArcadeSprite[] = [
        {
          kind: "ghost",
          cx: (x + BODY_W / 2 - camera) * size - 0.5,
          cy: board - (y + BODY_H / 2) * size - 0.5,
          size: 1.5 * size,
          dx: facing,
          dy: 0,
          alpha: (over ? 0.4 : blink) * bootAlpha(),
          mouth: 0,
          mascot: MASCOT,
          frame: onGround ? "rest" : "talk",
        },
      ];
      const viewEnd = camera + viewTiles() + 1;
      for (const enemy of enemies) {
        if (enemy.x + ENEMY_W < camera || enemy.x > viewEnd) continue;
        out.push({
          kind: "ghost",
          cx: (enemy.x + ENEMY_W / 2 - camera) * size - 0.5,
          cy: board - (enemy.y + ENEMY_H / 2) * size - 0.5,
          size: 1.4 * size,
          dx: enemy.dir,
          dy: 0,
          alpha: bootAlpha(),
          mouth: 0,
          mascot: ENEMY_MASCOT,
          frame: Math.floor(enemy.x * 2) % 2 === 0 ? "rest" : "talk",
        });
      }
      return out;
    },

    fade() {
      return bootAlpha();
    },

    progress() {
      return farthest;
    },

    groundProfile() {
      return ground;
    },

    stamp(out: Float32Array, stampCols: number, stampRows: number) {
      const size = tileSize();
      const board = boardRows();
      const originX = Math.floor(camera * size);

      const paint = (tx: number, ty: number, value: number) => {
        lightRect(
          out,
          stampCols,
          stampRows,
          tx * size - originX,
          board - (ty + 1) * size,
          size,
          size,
          value,
        );
      };

      // Clouds drift at half speed in the empty part of a tall board.
      if (player) {
        const far = Math.floor(camera * size * 0.4);
        for (let i = 0; i < stampCols; i++) {
          const cell = far + i;
          const block = Math.floor(cell / 18);
          const seed = hash(block);
          if (seed % 2) continue;
          const width = 8 + (seed % 7);
          const offset = cell % 18;
          if (offset >= width) continue;
          const y0 = 3 + ((seed >> 4) % Math.max(1, Math.floor(board / 3)));
          const puff = offset > 1 && offset < width - 2 ? 2 : 1;
          lightRect(out, stampCols, stampRows, i, y0 + 2 - puff, 1, puff, CLOUD_VALUE);
        }
      }

      const firstColumn = Math.floor(camera);
      const lastColumn = Math.ceil(camera + stampCols / size);
      for (let column = firstColumn; column <= lastColumn; column++) {
        const height = groundAt(column);
        for (let row = 0; row < height; row++) {
          // Dirt is speckled so the mass doesn't read as one flat slab.
          const seed = hash(column * 31 + row);
          const value =
            row === height - 1
              ? TOP_VALUE
              : DIRT_VALUE * (seed % 3 === 0 ? 0.7 : 1);
          paint(column, row, value);
        }
      }

      for (const [id, tile] of tiles) {
        const [cx, cy] = id.split(",").map(Number) as [number, number];
        if (cx < firstColumn || cx > lastColumn) continue;
        const value =
          tile === "brick"
            ? BRICK_VALUE
            : tile === "question"
              ? QUESTION_VALUE
              : USED_VALUE;
        paint(cx, cy, value);
        if (tile === "question" && size >= 3) {
          // A dark centre so a live block reads differently from a brick.
          const index =
            (board - (cy + 1) * size + Math.floor(size / 2)) * stampCols +
            cx * size -
            originX +
            Math.floor(size / 2);
          const px = cx * size - originX + Math.floor(size / 2);
          if (px >= 0 && px < stampCols && index >= 0 && index < out.length) {
            out[index] = 0.1;
          }
        }
      }

      for (const coin of coins) {
        const px = Math.floor(coin.x * size) - originX;
        const py = board - Math.ceil(coin.y * size);
        const span = Math.max(1, Math.floor(size / 2));
        lightRect(out, stampCols, stampRows, px, py, span, span, COIN_VALUE);
      }

      fadeOut(out, bootAlpha());
    },
  };
}
