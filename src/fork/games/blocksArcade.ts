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
 * Fork: falling blocks. A player gets one 10×20 well, scaled up to fit. Idle,
 * a row of wells plays itself across the band, each with its own little brain.
 */

export const WELL_WIDTH = 10;
export const WELL_HEIGHT = 20;

const SHAPES: readonly (readonly (readonly number[])[])[] = [
  [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  [
    [1, 1],
    [1, 1],
  ],
  [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
];

type Cell = { x: number; y: number };

/** Each shape's filled cells at each of its four rotations. */
const ROTATIONS: readonly (readonly (readonly Cell[])[])[] = SHAPES.map(
  (shape) => {
    const size = shape.length;
    const turns: Cell[][] = [];
    let grid = shape.map((row) => [...row]);
    for (let turn = 0; turn < 4; turn++) {
      const cells: Cell[] = [];
      grid.forEach((row, y) =>
        row.forEach((filled, x) => {
          if (filled) cells.push({ x, y });
        }),
      );
      turns.push(cells);
      grid = grid.map((row, y) =>
        row.map((_, x) => grid[size - 1 - x]?.[y] ?? 0),
      );
    }
    return turns;
  },
);

/** Tried in order when a rotation hits a wall, the floor, or the stack. */
const KICKS: readonly Cell[] = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: -2, y: 0 },
  { x: 2, y: 0 },
];

const LINE_SCORE = [0, 1, 3, 5, 8];
const LINES_PER_LEVEL = 10;
const GRAVITY_MS: Record<ArcadeMode, number> = { low: 800, mid: 520, hard: 280 };
const GRAVITY_LEVEL = 0.88;
const GRAVITY_FLOOR_MS = 40;
/** How long a landed piece can still be moved, and how often that restarts. */
const LOCK_MS = 320;
const LOCK_RESETS = 12;
/** Holding up repeats the key; turning at that rate would just spin. */
const ROTATE_COOLDOWN_MS = 140;

const IDLE_TICK_MS = 95;
const IDLE_WELL_GAP = 4;
const IDLE_WELLS_MAX = 12;
const IDLE_REST_MS = 900;

const TONES = [0.72, 0.56, 0.64, 0.5, 0.6, 0.68, 0.54];
const ACTIVE_VALUE = 0.95;
const GHOST_VALUE = 0.2;
const FLOOR_VALUE = 0.07;
const PREVIEW_VALUE = 0.5;

export type Piece = { kind: number; turn: number; x: number; y: number };

export type Well = {
  width: number;
  height: number;
  /** 0 empty, otherwise the kind + 1 that locked there. */
  cells: Uint8Array;
  piece: Piece;
  next: number;
  bag: number[];
  lines: number;
  over: boolean;
};

function pieceCells(piece: Piece) {
  return ROTATIONS[piece.kind]?.[piece.turn] ?? [];
}

export function collides(well: Well, piece: Piece) {
  for (const cell of pieceCells(piece)) {
    const x = piece.x + cell.x;
    const y = piece.y + cell.y;
    if (x < 0 || x >= well.width || y >= well.height) return true;
    if (y >= 0 && well.cells[y * well.width + x]) return true;
  }
  return false;
}

/** The fair bag: every shape once before any shape comes round again. */
function drawKind(bag: number[], random: Random) {
  if (bag.length === 0) {
    bag.push(...SHAPES.map((_, kind) => kind));
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [bag[i], bag[j]] = [bag[j]!, bag[i]!];
    }
  }
  return bag.pop() ?? 0;
}

function spawnPiece(well: Well, kind: number): Piece {
  const cells = ROTATIONS[kind]?.[0] ?? [];
  const size = SHAPES[kind]?.length ?? 3;
  const top = Math.min(...cells.map((cell) => cell.y));
  return {
    kind,
    turn: 0,
    x: Math.floor((well.width - size) / 2),
    y: -top,
  };
}

export function createWell(
  width: number,
  height: number,
  random: Random,
): Well {
  const bag: number[] = [];
  const well: Well = {
    width,
    height,
    cells: new Uint8Array(width * height),
    piece: { kind: 0, turn: 0, x: 0, y: 0 },
    next: 0,
    bag,
    lines: 0,
    over: false,
  };
  well.piece = spawnPiece(well, drawKind(bag, random));
  well.next = drawKind(bag, random);
  return well;
}

export function movePiece(well: Well, dx: number, dy: number) {
  const moved = { ...well.piece, x: well.piece.x + dx, y: well.piece.y + dy };
  if (collides(well, moved)) return false;
  well.piece = moved;
  return true;
}

export function rotatePiece(well: Well) {
  const turned = { ...well.piece, turn: (well.piece.turn + 1) % 4 };
  for (const kick of KICKS) {
    const moved = { ...turned, x: turned.x + kick.x, y: turned.y + kick.y };
    if (!collides(well, moved)) {
      well.piece = moved;
      return true;
    }
  }
  return false;
}

/** Where the piece would land if dropped straight down from here. */
export function landingY(well: Well, piece: Piece = well.piece) {
  let y = piece.y;
  while (!collides(well, { ...piece, y: y + 1 })) y += 1;
  return y;
}

function clearFull(cells: Uint8Array, width: number, height: number) {
  let cleared = 0;
  for (let y = height - 1; y >= 0; y--) {
    let full = true;
    for (let x = 0; x < width; x++) {
      if (!cells[y * width + x]) {
        full = false;
        break;
      }
    }
    if (!full) continue;
    cells.copyWithin(width, 0, y * width);
    cells.fill(0, 0, width);
    cleared += 1;
    y += 1;
  }
  return cleared;
}

/** Sets the piece into the stack, clears lines, deals the next. Returns lines. */
export function lockPiece(well: Well, random: Random) {
  let above = false;
  for (const cell of pieceCells(well.piece)) {
    const x = well.piece.x + cell.x;
    const y = well.piece.y + cell.y;
    if (y < 0) above = true;
    else well.cells[y * well.width + x] = well.piece.kind + 1;
  }
  const cleared = clearFull(well.cells, well.width, well.height);
  well.lines += cleared;
  well.piece = spawnPiece(well, well.next);
  well.next = drawKind(well.bag, random);
  if (above || collides(well, well.piece)) well.over = true;
  return cleared;
}

export function hardDrop(well: Well, random: Random) {
  well.piece = { ...well.piece, y: landingY(well) };
  return lockPiece(well, random);
}

/**
 * The classic four-term score: tall stacks, holes and bumps are bad, lines are
 * good. Good enough to keep a well going for a long while without being a bot
 * anyone would mistake for a person.
 */
function boardScore(cells: Uint8Array, width: number, height: number) {
  const before = cells.slice();
  const lines = clearFull(before, width, height);
  let total = 0;
  let holes = 0;
  let bumps = 0;
  let previous = -1;
  for (let x = 0; x < width; x++) {
    let column = 0;
    for (let y = 0; y < height; y++) {
      if (before[y * width + x]) {
        if (!column) column = height - y;
      } else if (column) {
        holes += 1;
      }
    }
    total += column;
    if (previous >= 0) bumps += Math.abs(column - previous);
    previous = column;
  }
  return -0.51 * total + 0.76 * lines - 0.36 * holes - 0.18 * bumps;
}

export function bestPlacement(well: Well) {
  const { width, height, cells } = well;
  const work = new Uint8Array(cells.length);
  let best: { turn: number; x: number } | null = null;
  let bestScore = -Infinity;
  for (let turn = 0; turn < 4; turn++) {
    for (let x = -3; x < width; x++) {
      const piece = { ...well.piece, turn, x };
      if (collides(well, piece)) continue;
      const y = landingY(well, piece);
      work.set(cells);
      for (const cell of pieceCells(piece)) {
        const py = y + cell.y;
        if (py >= 0) work[py * width + x + cell.x] = 1;
      }
      const score = boardScore(work, width, height);
      if (score > bestScore) {
        bestScore = score;
        best = { turn, x };
      }
    }
  }
  return best;
}

type IdleWell = {
  well: Well;
  target: { turn: number; x: number } | null;
  tick: number;
  rest: number;
};

export function createBlocksArcade(random: Random = Math.random): GridArcade {
  let cols = 0;
  let rows = 0;
  let player = false;
  let mode: ArcadeMode = "mid";
  let booted = 0;
  let score = 0;

  let own = createWell(WELL_WIDTH, WELL_HEIGHT, random);
  let gravity = 0;
  let grounded = 0;
  let lockResets = 0;
  let clock = 0;
  let rotatedAt = -Infinity;

  let idle: IdleWell[] = [];

  const idleRows = () => Math.max(8, Math.floor(rows * IDLE_ROWS));

  const buildIdle = () => {
    const height = idleRows();
    const count = clamp(
      Math.floor((cols + IDLE_WELL_GAP) / (WELL_WIDTH + IDLE_WELL_GAP)),
      1,
      IDLE_WELLS_MAX,
    );
    idle = Array.from({ length: count }, () => {
      const well = createWell(WELL_WIDTH, height, random);
      return {
        well,
        target: bestPlacement(well),
        tick: random() * IDLE_TICK_MS,
        rest: 0,
      };
    });
  };

  const newGame = () => {
    own = createWell(WELL_WIDTH, WELL_HEIGHT, random);
    score = 0;
    gravity = 0;
    grounded = 0;
    lockResets = 0;
  };

  const boot = () => {
    booted = 0;
    newGame();
    if (!player && cols > 0) buildIdle();
  };

  /** A piece that moved gets a fresh lock timer, but only so many times. */
  const nudged = () => {
    if (grounded > 0 && lockResets < LOCK_RESETS) {
      grounded = 0;
      lockResets += 1;
    }
  };

  const settle = (cleared: number) => {
    score += LINE_SCORE[cleared] ?? 0;
    gravity = 0;
    grounded = 0;
    lockResets = 0;
  };

  const gravityMs = () => {
    const level = Math.floor(own.lines / LINES_PER_LEVEL);
    return Math.max(
      GRAVITY_FLOOR_MS,
      GRAVITY_MS[mode] * Math.pow(GRAVITY_LEVEL, level),
    );
  };

  const stepPlayer = (dt: number) => {
    if (own.over) return;
    if (collides(own, { ...own.piece, y: own.piece.y + 1 })) {
      gravity = 0;
      grounded += dt;
      if (grounded >= LOCK_MS) settle(lockPiece(own, random));
      return;
    }
    grounded = 0;
    gravity += dt;
    const tick = gravityMs();
    while (gravity >= tick) {
      gravity -= tick;
      if (!movePiece(own, 0, 1)) break;
    }
  };

  const stepIdle = (entry: IdleWell, dt: number) => {
    if (entry.well.over) {
      entry.rest += dt;
      if (entry.rest >= IDLE_REST_MS) {
        entry.well = createWell(WELL_WIDTH, entry.well.height, random);
        entry.target = bestPlacement(entry.well);
        entry.rest = 0;
      }
      return;
    }
    entry.tick += dt;
    while (entry.tick >= IDLE_TICK_MS) {
      entry.tick -= IDLE_TICK_MS;
      const { well, target } = entry;
      let busy = false;
      if (target && well.piece.turn !== target.turn) {
        busy = rotatePiece(well);
      }
      if (target && !busy && well.piece.x !== target.x) {
        busy = movePiece(well, Math.sign(target.x - well.piece.x), 0);
      }
      if (!busy && !movePiece(well, 0, 1)) {
        lockPiece(well, random);
        entry.target = well.over ? null : bestPlacement(well);
        return;
      }
    }
  };

  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

  const stampWell = (
    out: Float32Array,
    stampCols: number,
    stampRows: number,
    well: Well,
    left: number,
    top: number,
    scale: number,
    ghost: boolean,
  ) => {
    const paint = (x: number, y: number, value: number) => {
      lightRect(
        out,
        stampCols,
        stampRows,
        left + x * scale,
        top + y * scale,
        scale,
        scale,
        value,
      );
    };
    lightRect(
      out,
      stampCols,
      stampRows,
      left,
      top,
      well.width * scale,
      well.height * scale,
      FLOOR_VALUE,
    );
    for (let y = 0; y < well.height; y++) {
      for (let x = 0; x < well.width; x++) {
        const kind = well.cells[y * well.width + x] ?? 0;
        if (kind) paint(x, y, TONES[kind - 1] ?? 0.6);
      }
    }
    if (well.over) return;
    if (ghost) {
      const landed = landingY(well);
      for (const cell of pieceCells(well.piece)) {
        paint(well.piece.x + cell.x, landed + cell.y, GHOST_VALUE);
      }
    }
    for (const cell of pieceCells(well.piece)) {
      paint(well.piece.x + cell.x, well.piece.y + cell.y, ACTIVE_VALUE);
    }
  };

  const stampPlayer = (
    out: Float32Array,
    stampCols: number,
    stampRows: number,
  ) => {
    const scale = Math.max(
      1,
      Math.floor(
        Math.min(stampRows / WELL_HEIGHT, stampCols / WELL_WIDTH),
      ),
    );
    const left = Math.floor((stampCols - WELL_WIDTH * scale) / 2);
    const top = Math.floor((stampRows - WELL_HEIGHT * scale) / 2);
    stampWell(out, stampCols, stampRows, own, left, top, scale, true);

    // The next piece sits beside the well, when there's room to spare.
    const room = left - 2;
    const size = Math.min(scale, Math.floor(room / 5));
    if (size < 1 || own.over) return;
    const previewLeft = left + WELL_WIDTH * scale + 2 * size;
    for (const cell of ROTATIONS[own.next]?.[0] ?? []) {
      lightRect(
        out,
        stampCols,
        stampRows,
        previewLeft + cell.x * size,
        top + cell.y * size,
        size,
        size,
        PREVIEW_VALUE,
      );
    }
  };

  return {
    resize(nextCols: number, nextRows: number) {
      if (nextCols === cols && nextRows === rows) return;
      cols = nextCols;
      rows = nextRows;
      // A player's well doesn't care what size it's drawn at.
      if (!player) boot();
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

    steer(x: number, y: number) {
      if (!player || own.over) return;
      if (x !== 0) {
        if (movePiece(own, Math.sign(x), 0)) nudged();
      } else if (y > 0) {
        if (movePiece(own, 0, 1)) gravity = 0;
      } else if (y < 0 && clock - rotatedAt >= ROTATE_COOLDOWN_MS) {
        rotatedAt = clock;
        if (rotatePiece(own)) nudged();
      }
    },

    /** Letting go of up means the next tap is a real one, however quick. */
    steerEnd(_x: number, y: number) {
      if (y < 0) rotatedAt = -Infinity;
    },

    action() {
      if (!player) return;
      if (own.over) {
        newGame();
        return;
      }
      settle(hardDrop(own, random));
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
      return 0;
    },

    gameOver() {
      return player && own.over;
    },

    step(dt: number) {
      if (!cols || !rows) return;
      booted += dt;
      clock += dt;
      if (player) {
        stepPlayer(dt);
        return;
      }
      for (const entry of idle) stepIdle(entry, dt);
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
      if (player) {
        stampPlayer(out, stampCols, stampRows);
      } else {
        const spare = stampCols - idle.length * WELL_WIDTH;
        const gap = spare / (idle.length + 1);
        idle.forEach((entry, i) => {
          const left = Math.floor(gap + i * (WELL_WIDTH + gap));
          stampWell(out, stampCols, stampRows, entry.well, left, 0, 1, false);
        });
      }
      fadeOut(out, bootAlpha());
    },
  };
}

