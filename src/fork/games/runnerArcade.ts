import { HARNESSES, type HarnessId } from "../../features/sessions/model/session";
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
  light,
  lightRect,
  type Random,
} from "./kit";

/**
 * Fork: "agent run". A mascot sprints along broken ground, jumping what the
 * build throws at it and grabbing provider logos on the way past. Everything
 * here is in world cells, which the board draws at `scale` grid cells each.
 */

export const GRAVITY = 170;
export const JUMP_VELOCITY = 50;
/** Letting go early cuts the climb to this much of its speed. */
const RELEASE_CUT = 0.45;
const FAST_FALL = 70;
const JUMP_BUFFER_MS = 110;
/** The side of the runner's square hitbox. */
export const HITBOX = 4;
const MASCOT = "robot";
const SPRITE_CELLS = 6;

export const SPEED: Record<ArcadeMode, number> = { low: 24, mid: 32, hard: 42 };
export const SPEED_GROWTH = 1.9;
const GROWTH_MS = 120_000;
const IDLE_SPEED = 26;

const STEP_MS = 16;
/** Time to spot the next obstacle after landing, on top of the jump itself. */
const REACTION_S = 0.22;
const GAP_SPREAD_S = 0.75;

const PICKUP_CELLS = 5;
const PICKUP_VALUE = 5;
const PICKUP_CHANCE = 0.35;
const PICKUP_FADE_MS = 200;
const CELLS_PER_POINT = 12;
const OVER_RESTART_MS = 1400;

const OBSTACLE_VALUE = 0.72;
const OBSTACLE_TOP_VALUE = 0.92;
const GROUND_VALUE = 0.3;
const SKYLINE_VALUE = 0.07;

const CHATTER = [
  "TOKENS!",
  "CONTEXT ACQUIRED",
  "ONE MORE TOOL CALL",
  "TESTS PASS, PROBABLY",
  "I'LL ADD A HANDOFF",
  "LGTM",
  "SHIP IT",
  "NO BUGS, ONLY JUMPS",
  "RUNNING IN BACKGROUND",
  "RATE LIMIT WHO",
];

export type Obstacle = { x: number; width: number; height: number };

type Pickup = { harness: HarnessId; x: number; lift: number; age: number };

/** Every shape the spawner may build: tall ones are thin, wide ones are low. */
export const OBSTACLE_SHAPES: readonly { width: number; height: number }[] =
  (() => {
    const shapes: { width: number; height: number }[] = [];
    for (let width = 1; width <= 5; width++) {
      for (let height = 1; height <= 5; height++) {
        if (height > 3 && width > 3) continue;
        if (width + height < 3) continue;
        shapes.push({ width, height });
      }
    }
    return shapes;
  })();

/**
 * Whether a full jump gets the whole hitbox over a shape. The runner is above
 * `height` only between the two roots of its arc; the obstacle has to pass
 * underneath inside that window.
 */
export function canClear(width: number, height: number, speed: number) {
  const roots = JUMP_VELOCITY * JUMP_VELOCITY - 2 * GRAVITY * height;
  if (roots <= 0) return false;
  const window = (2 * Math.sqrt(roots)) / GRAVITY;
  return (width + HITBOX) / speed < window;
}

/** Empty ground needed after an obstacle: land, look up, take off again. */
export function minimumGap(speed: number) {
  const air = (2 * JUMP_VELOCITY) / GRAVITY;
  return Math.ceil(speed * (air + REACTION_S)) + HITBOX;
}

export function createRunnerArcade(random: Random = Math.random): GridArcade {
  let cols = 0;
  let rows = 0;
  let player = false;
  let mode: ArcadeMode = "mid";
  let booted = 0;

  let scroll = 0;
  let elapsed = 0;
  let bonus = 0;
  let over = false;
  let overFor = 0;
  let accumulator = 0;
  let height = 0;
  let velocity = 0;
  let jumpHeld = false;
  let buffered = 0;
  let spawnAt = 0;
  let obstacles: Obstacle[] = [];
  let pickup: Pickup | null = null;
  const chatter = createChatter(CHATTER, random);

  const boardRows = () =>
    player ? rows : Math.max(8, Math.floor(rows * IDLE_ROWS));

  const scale = () =>
    Math.max(1, Math.floor(Math.min(boardRows() / 22, cols / 70)));

  /** Where the feet land, in grid rows: a third up a tall board, low on a band. */
  const groundRow = () => {
    const board = boardRows();
    return player ? Math.floor(board * 0.68) : board - 3;
  };

  const runnerX = () => Math.min(14, Math.floor(cols / scale() / 5));

  const speed = () => {
    if (!player) return IDLE_SPEED;
    const growth = Math.min(1, elapsed / GROWTH_MS);
    return SPEED[mode] * (1 + (SPEED_GROWTH - 1) * growth);
  };

  const reset = () => {
    booted = 0;
    scroll = 0;
    elapsed = 0;
    bonus = 0;
    over = false;
    overFor = 0;
    accumulator = 0;
    height = 0;
    velocity = 0;
    jumpHeld = false;
    buffered = 0;
    spawnAt = cols / scale() + 10;
    obstacles = [];
    pickup = null;
    chatter.clear();
  };

  const spawn = () => {
    const shape =
      OBSTACLE_SHAPES[Math.floor(random() * OBSTACLE_SHAPES.length)];
    if (!shape) return;
    const pace = speed();
    const front = scroll + cols / scale() + 2;
    obstacles.push({ x: front, width: shape.width, height: shape.height });
    const gap = minimumGap(pace) + Math.ceil(random() * pace * GAP_SPREAD_S);
    spawnAt = front + shape.width + gap;
    // A logo rides the middle of the gap, up where only a jump reaches it.
    if (!pickup && random() < PICKUP_CHANCE) {
      const harness = HARNESSES[Math.floor(random() * HARNESSES.length)];
      if (harness) {
        pickup = {
          harness,
          x: front + shape.width + gap / 2 - PICKUP_CELLS / 2,
          lift: HITBOX + 1 + Math.floor(random() * 2),
          age: 0,
        };
      }
    }
  };

  const jump = () => {
    if (height > 0) return;
    velocity = JUMP_VELOCITY;
    buffered = 0;
  };

  const press = () => {
    if (jumpHeld) return;
    jumpHeld = true;
    buffered = JUMP_BUFFER_MS;
    jump();
  };

  const release = () => {
    jumpHeld = false;
    if (velocity > 0) velocity *= RELEASE_CUT;
  };

  const think = () => {
    const next = obstacles.find(
      (it) => it.x + it.width > scroll + runnerX(),
    );
    if (!next || height > 0) return;
    // Take off so the top of the arc sits over the obstacle's middle.
    const middle = next.x + next.width / 2 - (scroll + runnerX() + HITBOX / 2);
    const apex = JUMP_VELOCITY / GRAVITY;
    if (middle <= speed() * apex) jump();
  };

  const tick = (ms: number) => {
    const seconds = ms / 1000;
    elapsed += ms;
    scroll += speed() * seconds;

    if (!player) think();

    if (height > 0 || velocity > 0) {
      velocity -= GRAVITY * seconds;
      height += velocity * seconds;
      if (height <= 0) {
        height = 0;
        velocity = 0;
        if (buffered > 0) jump();
      }
    }
    buffered = Math.max(0, buffered - ms);

    while (scroll + cols / scale() + 2 >= spawnAt) spawn();
    const behind = scroll - SPRITE_CELLS;
    obstacles = obstacles.filter((it) => it.x + it.width > behind);

    const left = scroll + runnerX();
    const right = left + HITBOX;
    for (const it of obstacles) {
      if (right > it.x && left < it.x + it.width && height < it.height) {
        over = true;
        overFor = 0;
        return;
      }
    }

    if (pickup) {
      pickup.age += ms;
      const top = height + HITBOX;
      if (
        right > pickup.x &&
        left < pickup.x + PICKUP_CELLS &&
        top > pickup.lift &&
        height < pickup.lift + PICKUP_CELLS
      ) {
        bonus += PICKUP_VALUE;
        pickup = null;
        chatter.say();
      } else if (pickup.x + PICKUP_CELLS < behind) {
        pickup = null;
      }
    }
  };

  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

  const score = () => Math.floor(scroll / CELLS_PER_POINT) + bonus;

  return {
    resize(nextCols: number, nextRows: number) {
      if (nextCols === cols && nextRows === rows) return;
      cols = nextCols;
      rows = nextRows;
      if (!player) {
        reset();
        return;
      }
      // Keep the run; just make sure there's something coming on a wider board.
      spawnAt = Math.max(spawnAt, scroll + 4);
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
      if (!player || over || x !== 0) return;
      if (y < 0) press();
      else if (y > 0 && height > 0) velocity = Math.min(velocity, -FAST_FALL);
    },

    steerEnd(_x: number, y: number) {
      if (player && y < 0) release();
    },

    action() {
      if (!player) return;
      if (over) reset();
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
      chatter.step(dt);
      if (over) {
        overFor += dt;
        if (!player && overFor >= OVER_RESTART_MS) reset();
        return;
      }
      accumulator += Math.min(dt, 120);
      while (accumulator >= STEP_MS && !over) {
        accumulator -= STEP_MS;
        tick(STEP_MS);
      }
    },

    speechBubble(): SpeechBubble | null {
      const size = scale();
      return chatter.bubble(
        (runnerX() + HITBOX / 2) * size,
        groundRow() - (height + HITBOX + 1) * size,
        bootAlpha(),
      );
    },

    logoPickup(): LogoPickup | null {
      if (!pickup) return null;
      const size = scale();
      return {
        harness: pickup.harness,
        x: (pickup.x - scroll) * size,
        y: groundRow() - (pickup.lift + PICKUP_CELLS) * size,
        cells: PICKUP_CELLS * size,
        alpha: Math.min(1, pickup.age / PICKUP_FADE_MS) * bootAlpha(),
      };
    },

    sprites(): ArcadeSprite[] {
      const size = scale();
      return [
        {
          kind: "ghost",
          cx: (runnerX() + HITBOX / 2) * size - 0.5,
          cy: groundRow() - (height + HITBOX / 2) * size - 0.5,
          size: SPRITE_CELLS * size,
          dx: 1,
          dy: 0,
          alpha: (over ? 0.45 : 1) * bootAlpha(),
          mouth: 0,
          mascot: MASCOT,
          frame: height > 0 || over ? "talk" : "rest",
        },
      ];
    },

    fade() {
      return bootAlpha();
    },

    stamp(out: Float32Array, stampCols: number, stampRows: number) {
      const size = scale();
      const ground = groundRow();
      const world = Math.floor(stampCols / size) + 1;

      // Far skyline, slow and faint: a tall board has a lot of empty sky.
      if (player) {
        const far = Math.floor(scroll * 0.25);
        for (let i = 0; i < stampCols; i++) {
          const column = far + i;
          const block = Math.floor(column / 7);
          const tall = 4 + (hash(block) % 14);
          const edge = hash(block + 991) % 3;
          if (column % 7 < edge) continue;
          for (let y = ground - tall; y < ground; y++) {
            light(out, stampCols, stampRows, i, y, SKYLINE_VALUE);
          }
        }
      }

      // Broken specks instead of a ground line.
      const first = Math.floor(scroll);
      for (let i = 0; i < world; i++) {
        const seed = hash(first + i);
        const x = i * size - Math.floor((scroll - first) * size);
        if (seed % 3 !== 0) {
          lightRect(
            out,
            stampCols,
            stampRows,
            x,
            ground + size - 1,
            size,
            size,
            GROUND_VALUE,
          );
        }
        if (seed % 7 === 0) {
          light(
            out,
            stampCols,
            stampRows,
            x,
            ground + size * 2 + (seed % 3),
            GROUND_VALUE * 0.6,
          );
        }
      }

      for (const it of obstacles) {
        const left = Math.floor((it.x - scroll) * size);
        const top = ground - it.height * size;
        lightRect(
          out,
          stampCols,
          stampRows,
          left,
          top,
          it.width * size,
          it.height * size,
          OBSTACLE_VALUE,
        );
        lightRect(
          out,
          stampCols,
          stampRows,
          left,
          top,
          it.width * size,
          size,
          OBSTACLE_TOP_VALUE,
        );
      }

      fadeOut(out, clamp(bootAlpha(), 0, 1));
    },
  };
}
