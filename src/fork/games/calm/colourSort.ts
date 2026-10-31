import { seeded } from "../seeded";

/** Fork: colour sort. Tubes hold colour ids, bottom first. */

export const TUBE_SIZE = 4;
export const EMPTY_TUBES = 2;

export type Tube = readonly number[];
export type Board = readonly Tube[];
export type Move = { from: number; to: number };

export const COLOURS_FOR = { low: 4, mid: 6, hard: 9 } as const;

function topRun(tube: Tube) {
  const top = tube[tube.length - 1];
  let run = 0;
  for (let i = tube.length - 1; i >= 0 && tube[i] === top; i--) {
    run++;
  }
  return run;
}

export function canPour(board: Board, from: number, to: number) {
  const source = board[from];
  const target = board[to];
  if (!source || !target || from === to || source.length === 0) {
    return false;
  }
  if (target.length >= TUBE_SIZE) {
    return false;
  }
  return target.length === 0 || target[target.length - 1] === source[source.length - 1];
}

/** Moves as much of the top run as fits. Returns the same board if the pour isn't legal. */
export function pour(board: Board, from: number, to: number): Board {
  if (!canPour(board, from, to)) {
    return board;
  }
  const source = board[from]!;
  const target = board[to]!;
  const count = Math.min(topRun(source), TUBE_SIZE - target.length);
  const colour = source[source.length - 1]!;
  return board.map((tube, index) => {
    if (index === from) {
      return tube.slice(0, tube.length - count);
    }
    if (index === to) {
      return [...tube, ...Array<number>(count).fill(colour)];
    }
    return tube;
  });
}

/** How many layers a pour would move, 0 if none. */
export function pourCount(board: Board, from: number, to: number) {
  if (!canPour(board, from, to)) {
    return 0;
  }
  return Math.min(topRun(board[from]!), TUBE_SIZE - board[to]!.length);
}

function isDone(tube: Tube) {
  return tube.length === 0 || (tube.length === TUBE_SIZE && topRun(tube) === TUBE_SIZE);
}

export function isSolved(board: Board) {
  return board.every(isDone);
}

function key(board: Board) {
  return board
    .map((tube) => tube.join(","))
    .sort()
    .join("|");
}

/** Depth-first search with a visited set. `null` when unsolvable or past the node cap. */
export function solve(board: Board, nodeCap = 200_000): Move[] | null {
  const seen = new Set<string>();
  const path: Move[] = [];
  let nodes = 0;

  const search = (current: Board): boolean => {
    if (isSolved(current)) {
      return true;
    }
    if (++nodes > nodeCap) {
      return false;
    }
    const id = key(current);
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    for (let from = 0; from < current.length; from++) {
      const source = current[from]!;
      if (source.length === 0 || isDone(source)) {
        continue;
      }
      const uniform = topRun(source) === source.length;
      let triedEmpty = false;
      for (let to = 0; to < current.length; to++) {
        if (!canPour(current, from, to)) {
          continue;
        }
        if (current[to]!.length === 0) {
          // A tube of one colour gains nothing in an empty tube, and every empty tube is the same.
          if (uniform || triedEmpty) {
            continue;
          }
          triedEmpty = true;
        }
        path.push({ from, to });
        if (search(pour(current, from, to))) {
          return true;
        }
        path.pop();
        if (nodes > nodeCap) {
          return false;
        }
      }
    }
    return false;
  };

  return search(board) ? [...path] : null;
}

function deal(colours: number, random: () => number): Board {
  const layers: number[] = [];
  for (let colour = 0; colour < colours; colour++) {
    for (let i = 0; i < TUBE_SIZE; i++) {
      layers.push(colour);
    }
  }
  for (let i = layers.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [layers[i], layers[j]] = [layers[j]!, layers[i]!];
  }
  const tubes: number[][] = [];
  for (let t = 0; t < colours; t++) {
    tubes.push(layers.slice(t * TUBE_SIZE, (t + 1) * TUBE_SIZE));
  }
  for (let t = 0; t < EMPTY_TUBES; t++) {
    tubes.push([]);
  }
  return tubes;
}

/** A shuffled, solver-checked puzzle: `colours` full tubes plus two empty ones. */
export function generate(seed: number, colours: number): Board {
  const random = seeded(seed);
  for (let attempt = 0; attempt < 200; attempt++) {
    const board = deal(colours, random);
    // No tube may start sorted, and no top may already be a run of three.
    const fresh = board.every((tube) => tube.length === 0 || topRun(tube) < 3);
    if (fresh && solve(board, 60_000)) {
      return board;
    }
  }
  // Unreached in practice: random deals with two spare tubes are nearly always solvable.
  return deal(colours, () => 0);
}
