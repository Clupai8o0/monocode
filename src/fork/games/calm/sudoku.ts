import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { seeded } from "../seeded";

/** Fork: sudoku. A grid is 81 digits, row by row, with 0 for an empty cell. */

export const CELLS = 81;
const ALL_NOTES = 0b111_111_111;

export type Grid = readonly number[];
export type Puzzle = { givens: Grid; solution: Grid };
/** `notes` holds one bit per pencilled digit: bit 0 is 1, bit 8 is 9. */
export type Board = { values: Grid; notes: readonly number[] };

/** How many digits a level starts with. Fewer clues means less to go on. */
export const CLUES_FOR: Record<ArcadeMode, number> = { low: 40, mid: 32, hard: 26 };

function boxOf(index: number) {
  const row = Math.floor(index / 9);
  const col = index % 9;
  return Math.floor(row / 3) * 3 + Math.floor(col / 3);
}

/** For each cell, the 20 others it shares a row, column or box with. */
const PEERS: readonly (readonly number[])[] = Array.from({ length: CELLS }, (_, index) =>
  Array.from({ length: CELLS }, (_, other) => other).filter(
    (other) =>
      other !== index &&
      (Math.floor(other / 9) === Math.floor(index / 9) || other % 9 === index % 9 || boxOf(other) === boxOf(index)),
  ),
);

export function arePeers(a: number, b: number) {
  return PEERS[a]!.includes(b);
}

export function emptyBoard(puzzle: Puzzle): Board {
  return { values: puzzle.givens, notes: Array<number>(CELLS).fill(0) };
}

/** Every cell whose digit also sits in its row, column or box. */
export function conflicts(values: Grid): Set<number> {
  const found = new Set<number>();
  values.forEach((value, index) => {
    if (value !== 0 && PEERS[index]!.some((peer) => values[peer] === value)) {
      found.add(index);
    }
  });
  return found;
}

/**
 * Puts a digit in a cell and rubs that digit out of the notes it now rules out.
 * The same digit again takes it back out. Givens never change.
 */
export function place(board: Board, puzzle: Puzzle, index: number, digit: number): Board {
  if (puzzle.givens[index] !== 0) {
    return board;
  }
  if (board.values[index] === digit) {
    return erase(board, puzzle, index);
  }
  const bit = 1 << (digit - 1);
  const values = [...board.values];
  values[index] = digit;
  const notes = [...board.notes];
  notes[index] = 0;
  for (const peer of PEERS[index]!) {
    notes[peer] = notes[peer]! & ~bit;
  }
  return { values, notes };
}

/** Clears a cell's digit, or its notes if it has no digit. */
export function erase(board: Board, puzzle: Puzzle, index: number): Board {
  if (puzzle.givens[index] !== 0 || (board.values[index] === 0 && board.notes[index] === 0)) {
    return board;
  }
  const values = [...board.values];
  const notes = [...board.notes];
  if (values[index] !== 0) {
    values[index] = 0;
  } else {
    notes[index] = 0;
  }
  return { values, notes };
}

/** Pencils a digit in or out of an empty cell. */
export function toggleNote(board: Board, puzzle: Puzzle, index: number, digit: number): Board {
  if (puzzle.givens[index] !== 0 || board.values[index] !== 0) {
    return board;
  }
  const notes = [...board.notes];
  notes[index] = notes[index]! ^ (1 << (digit - 1));
  return { values: board.values, notes };
}

export function hasNote(mask: number, digit: number) {
  return (mask & (1 << (digit - 1))) !== 0;
}

export function emptyCount(values: Grid) {
  return values.filter((value) => value === 0).length;
}

/** How many of a digit are still to place; never below zero when one is overused. */
export function remaining(values: Grid, digit: number) {
  return Math.max(0, 9 - values.filter((value) => value === digit).length);
}

export function isSolved(board: Board) {
  return emptyCount(board.values) === 0 && conflicts(board.values).size === 0;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Backtracks over the empty cells, always the one with the fewest digits left,
 * and stops at `limit` completions. `onSolution` sees each completed grid, and
 * `random` shuffles the order digits are tried in.
 */
function search(grid: Grid, limit: number, onSolution?: (solved: number[]) => void, random?: () => number) {
  const cells = [...grid];
  const rows = Array<number>(9).fill(0);
  const cols = Array<number>(9).fill(0);
  const boxes = Array<number>(9).fill(0);
  const empties: number[] = [];
  let valid = true;
  cells.forEach((value, index) => {
    if (value === 0) {
      empties.push(index);
      return;
    }
    const bit = 1 << (value - 1);
    const row = Math.floor(index / 9);
    const col = index % 9;
    const box = boxOf(index);
    if ((rows[row]! | cols[col]! | boxes[box]!) & bit) {
      valid = false;
    }
    rows[row]! |= bit;
    cols[col]! |= bit;
    boxes[box]! |= bit;
  });
  if (!valid) {
    return 0;
  }

  let found = 0;
  const step = (left: number): void => {
    if (left === 0) {
      found++;
      onSolution?.(cells);
      return;
    }
    let bestAt = -1;
    let bestOpen = 0;
    let bestCount = 10;
    for (let i = 0; i < left; i++) {
      const index = empties[i]!;
      const row = Math.floor(index / 9);
      const col = index % 9;
      const open = ALL_NOTES & ~(rows[row]! | cols[col]! | boxes[boxOf(index)]!);
      let count = 0;
      for (let bits = open; bits !== 0; bits &= bits - 1) {
        count++;
      }
      if (count < bestCount) {
        bestAt = i;
        bestOpen = open;
        bestCount = count;
        if (count <= 1) {
          break;
        }
      }
    }
    if (bestCount === 0) {
      return;
    }
    const index = empties[bestAt]!;
    empties[bestAt] = empties[left - 1]!;
    empties[left - 1] = index;
    const row = Math.floor(index / 9);
    const col = index % 9;
    const box = boxOf(index);
    for (const digit of random ? shuffled(DIGITS, random) : DIGITS) {
      const bit = 1 << (digit - 1);
      if ((bestOpen & bit) === 0) {
        continue;
      }
      cells[index] = digit;
      rows[row]! |= bit;
      cols[col]! |= bit;
      boxes[box]! |= bit;
      step(left - 1);
      rows[row]! &= ~bit;
      cols[col]! &= ~bit;
      boxes[box]! &= ~bit;
      cells[index] = 0;
      if (found >= limit) {
        break;
      }
    }
  };
  step(empties.length);
  return found;
}

/** Counts completions of a grid, stopping at `limit`. A grid that breaks the rules has none. */
export function countSolutions(grid: Grid, limit = 2) {
  return search(grid, limit);
}

function fullGrid(random: () => number): number[] {
  let result: number[] = [];
  search(Array<number>(CELLS).fill(0), 1, (solved) => {
    result = [...solved];
  }, random);
  return result;
}

/**
 * A seeded puzzle with exactly one solution. Cells come out in mirrored pairs
 * for the look of it, then one at a time if the pairs stall above the mode's
 * clue count, stopping once no more can go without a second solution.
 */
export function generate(seed: number, mode: ArcadeMode): Puzzle {
  const random = seeded(seed);
  const solution = fullGrid(random);
  const givens = [...solution];
  const target = CLUES_FOR[mode];
  let clues = CELLS;

  const tryRemoving = (group: readonly number[]) => {
    if (clues - group.length < target || group.some((index) => givens[index] === 0)) {
      return;
    }
    const held = group.map((index) => givens[index]!);
    group.forEach((index) => {
      givens[index] = 0;
    });
    if (countSolutions(givens) === 1) {
      clues -= group.length;
    } else {
      group.forEach((index, i) => {
        givens[index] = held[i]!;
      });
    }
  };

  const order = shuffled(Array.from({ length: CELLS }, (_, index) => index), random);
  for (const index of order) {
    const mirror = CELLS - 1 - index;
    tryRemoving(index === mirror ? [index] : [index, mirror]);
  }
  for (const index of order) {
    tryRemoving([index]);
  }
  return { givens, solution };
}

function isDigits(value: unknown, max: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === CELLS &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= max)
  );
}

/** Reads a saved board back, or `null` if it doesn't belong to this puzzle. */
export function restoreBoard(saved: unknown, puzzle: Puzzle): Board | null {
  const { values, notes } = (saved ?? {}) as { values?: unknown; notes?: unknown };
  if (!isDigits(values, 9) || !isDigits(notes, ALL_NOTES)) {
    return null;
  }
  const matches = puzzle.givens.every((given, index) => given === 0 || values[index] === given);
  return matches ? { values, notes } : null;
}
