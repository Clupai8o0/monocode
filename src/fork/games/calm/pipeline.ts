import { seeded } from "../seeded";

/** Fork: pipeline. Turn pipe tiles until the commit reaches deploy through every checkpoint. */

export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

export const SIZE_FOR = {
  low: { cols: 5, rows: 4 },
  mid: { cols: 6, rows: 5 },
  hard: { cols: 8, rows: 6 },
} as const;

export type Mode = keyof typeof SIZE_FOR;
export type Checkpoint = { index: number; label: string };

/** Plain immutable data. A tile is a 4-bit mask of open sides (N, E, S, W). */
export type Board = {
  readonly cols: number;
  readonly rows: number;
  readonly tiles: readonly number[];
  /** Row where commit enters the left edge, and where deploy leaves the right edge. */
  readonly start: number;
  readonly end: number;
  readonly checks: readonly Checkpoint[];
};

export type Generated = { board: Board; solution: Board; path: readonly number[] };

const LABELS: Record<Mode, string[]> = {
  low: ["test", "review"],
  mid: ["test", "review"],
  hard: ["build", "test", "review"],
};

export type Kind = "empty" | "straight" | "bend" | "tee" | "cross";

export function kindOf(mask: number): Kind {
  const open = [N, E, S, W].filter((bit) => mask & bit).length;
  if (open === 0) {
    return "empty";
  }
  if (open === 4) {
    return "cross";
  }
  if (open === 3) {
    return "tee";
  }
  if (open === 2) {
    return mask === (N | S) || mask === (E | W) ? "straight" : "bend";
  }
  return "bend"; // a lone stub never appears, but keep the type total
}

/** One 90 degree turn clockwise: N->E->S->W->N. */
export function turn(mask: number) {
  return ((mask << 1) | (mask >> 3)) & 15;
}

export function rotate(board: Board, index: number): Board {
  if (index < 0 || index >= board.tiles.length) {
    return board;
  }
  return { ...board, tiles: board.tiles.map((mask, i) => (i === index ? turn(mask) : mask)) };
}

export function commitCell(board: Board) {
  return board.start * board.cols;
}

export function deployCell(board: Board) {
  return board.end * board.cols + board.cols - 1;
}

/** Cells fed by the commit entry, following sides that are open on both tiles. */
export function flow(board: Board): Set<number> {
  const lit = new Set<number>();
  const first = commitCell(board);
  if (!(board.tiles[first]! & W)) {
    return lit;
  }
  lit.add(first);
  const queue = [first];
  const { cols, rows, tiles } = board;
  while (queue.length > 0) {
    const at = queue.pop()!;
    const x = at % cols;
    const y = Math.floor(at / cols);
    const mask = tiles[at]!;
    const steps: [number, number, number, boolean][] = [
      [N, S, at - cols, y > 0],
      [E, W, at + 1, x < cols - 1],
      [S, N, at + cols, y < rows - 1],
      [W, E, at - 1, x > 0],
    ];
    for (const [out, back, to, inside] of steps) {
      if (inside && mask & out && tiles[to]! & back && !lit.has(to)) {
        lit.add(to);
        queue.push(to);
      }
    }
  }
  return lit;
}

export function deployReached(board: Board, lit: Set<number> = flow(board)) {
  const exit = deployCell(board);
  return lit.has(exit) && (board.tiles[exit]! & E) !== 0;
}

export function isSolved(board: Board) {
  const lit = flow(board);
  return deployReached(board, lit) && board.checks.every((check) => lit.has(check.index));
}

type Random = () => number;

function shuffle<T>(items: T[], random: Random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Random self-avoiding walk from the commit cell to the deploy cell, favouring turns. */
function carve(cols: number, rows: number, start: number, end: number, minLength: number, random: Random) {
  const from = start * cols;
  const to = end * cols + cols - 1;
  const seen = new Set<number>([from]);
  const path = [from];
  let budget = 40_000;

  const step = (at: number, heading: number): boolean => {
    if (at === to) {
      return path.length >= minLength;
    }
    if (budget-- <= 0) {
      return false;
    }
    const x = at % cols;
    const y = Math.floor(at / cols);
    const options: [number, number][] = [];
    if (y > 0) {
      options.push([at - cols, N]);
    }
    if (x < cols - 1) {
      options.push([at + 1, E]);
    }
    if (y < rows - 1) {
      options.push([at + cols, S]);
    }
    if (x > 0) {
      options.push([at - 1, W]);
    }
    shuffle(options, random);
    // Turns first, so the route winds instead of running straight across.
    options.sort((a, b) => Number(a[1] === heading) - Number(b[1] === heading));
    for (const [next, dir] of options) {
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      path.push(next);
      if (step(next, dir)) {
        return true;
      }
      path.pop();
      seen.delete(next);
    }
    return false;
  };

  if (step(from, E)) {
    return path;
  }
  // Out of budget: take any simple route, down the start column then along the end row.
  const route: number[] = [];
  for (let y = start; y !== end; y += Math.sign(end - start)) {
    route.push(y * cols);
  }
  for (let x = 0; x < cols; x++) {
    route.push(end * cols + x);
  }
  return route;
}

function decoy(random: Random) {
  const roll = random();
  const base = roll < 0.28 ? N | S : roll < 0.62 ? N | E : roll < 0.85 ? N | E | S : roll < 0.9 ? 15 : 0;
  return base;
}

function scramble(mask: number, random: Random) {
  let out = mask;
  for (let i = Math.floor(random() * 4); i > 0; i--) {
    out = turn(out);
  }
  return out;
}

export function generate(seed: number, mode: Mode): Generated {
  const random = seeded(seed);
  const { cols, rows } = SIZE_FOR[mode];
  const start = Math.floor(random() * rows);
  const end = Math.floor(random() * rows);
  const path = carve(cols, rows, start, end, Math.ceil(cols * 1.5), random);

  const tiles = Array<number>(cols * rows).fill(0);
  path.forEach((cell, i) => {
    const prev = i === 0 ? cell - 1 : path[i - 1]!;
    const next = i === path.length - 1 ? cell + 1 : path[i + 1]!;
    let mask = 0;
    for (const other of [prev, next]) {
      const d = other - cell;
      mask |= d === -cols ? N : d === cols ? S : d === 1 ? E : W;
    }
    // The end cells open onto the board edge (prev/next sit one column outside): W for commit, E for deploy.
    tiles[cell] = mask;
  });
  const onPath = new Set(path);
  tiles.forEach((_, i) => {
    if (!onPath.has(i)) {
      tiles[i] = decoy(random);
    }
  });

  // Checkpoints sit on distinct inner path cells, in path order.
  const labels = LABELS[mode];
  const inner = path.map((_, i) => i).slice(1, path.length - 1);
  const pool = inner.length >= labels.length ? inner : path.map((_, i) => i);
  const picks = shuffle([...pool], random)
    .slice(0, labels.length)
    .sort((a, b) => a - b);
  const checks = picks.map((p, i) => ({ index: path[p]!, label: labels[i]! }));

  const solution: Board = { cols, rows, tiles, start, end, checks };
  let board = solution;
  for (let tries = 0; tries < 50; tries++) {
    board = { ...solution, tiles: tiles.map((mask) => scramble(mask, random)) };
    if (!isSolved(board)) {
      return { board, solution, path };
    }
  }
  // Practically unreachable; turning the commit tile breaks a solved board.
  board = rotate(solution, commitCell(solution));
  return { board: isSolved(board) ? rotate(board, commitCell(board)) : board, solution, path };
}
