import { describe, expect, it } from "vitest";
import {
  CELLS,
  CLUES_FOR,
  arePeers,
  conflicts,
  countSolutions,
  emptyBoard,
  emptyCount,
  erase,
  generate,
  hasNote,
  isSolved,
  place,
  remaining,
  restoreBoard,
  toggleNote,
  type Board,
  type Puzzle,
} from "./sudoku";

const MODES = ["low", "mid", "hard"] as const;

const puzzle = generate(11, "mid");
const blank = puzzle.givens.indexOf(0);
const givenAt = puzzle.givens.findIndex((value) => value !== 0);

function clues(grid: readonly number[]) {
  return grid.filter((value) => value !== 0).length;
}

function solvedBoard(from: Puzzle): Board {
  return { values: from.solution, notes: Array<number>(CELLS).fill(0) };
}

describe("sudoku generator", () => {
  it("gives every mode one solution and the clue count it asks for", () => {
    for (const mode of MODES) {
      for (let seed = 1; seed <= 15; seed++) {
        const { givens, solution } = generate(seed, mode);
        expect(countSolutions(givens)).toBe(1);
        expect(clues(givens)).toBeGreaterThanOrEqual(CLUES_FOR[mode]);
        expect(clues(givens)).toBeLessThanOrEqual(CLUES_FOR[mode] + 2);
        expect(conflicts(solution).size).toBe(0);
        expect(emptyCount(solution)).toBe(0);
        givens.forEach((given, index) => {
          if (given !== 0) {
            expect(solution[index]).toBe(given);
          }
        });
      }
    }
  });

  it("repeats for a seed and changes with it", () => {
    expect(generate(5, "hard")).toEqual(generate(5, "hard"));
    expect(generate(5, "hard").givens).not.toEqual(generate(6, "hard").givens);
  });

  it("removes cells in mirrored pairs while the pairs last", () => {
    const { givens } = generate(3, "low");
    givens.forEach((given, index) => {
      expect(given === 0).toBe(givens[CELLS - 1 - index] === 0);
    });
  });
});

describe("countSolutions", () => {
  it("stops at the limit on an open grid", () => {
    expect(countSolutions(Array<number>(CELLS).fill(0), 2)).toBe(2);
  });

  it("finds none when the clues already clash", () => {
    const grid = Array<number>(CELLS).fill(0);
    grid[0] = 5;
    grid[1] = 5;
    expect(countSolutions(grid)).toBe(0);
  });
});

describe("sudoku moves", () => {
  it("knows which cells share a row, column or box", () => {
    expect(arePeers(0, 8)).toBe(true);
    expect(arePeers(0, 72)).toBe(true);
    expect(arePeers(0, 20)).toBe(true);
    expect(arePeers(0, 21)).toBe(false);
    expect(arePeers(0, 0)).toBe(false);
  });

  it("flags both ends of a clash", () => {
    const values = Array<number>(CELLS).fill(0);
    values[0] = 7;
    values[8] = 7;
    values[40] = 7;
    expect([...conflicts(values)].sort((a, b) => a - b)).toEqual([0, 8]);
  });

  it("places a digit and takes it back with the same digit", () => {
    const start = emptyBoard(puzzle);
    const placed = place(start, puzzle, blank, 4);
    expect(placed.values[blank]).toBe(4);
    expect(start.values[blank]).toBe(0);
    expect(place(placed, puzzle, blank, 4).values[blank]).toBe(0);
    expect(place(placed, puzzle, blank, 6).values[blank]).toBe(6);
  });

  it("never changes a given", () => {
    const start = emptyBoard(puzzle);
    expect(place(start, puzzle, givenAt, 1)).toBe(start);
    expect(erase(start, puzzle, givenAt)).toBe(start);
    expect(toggleNote(start, puzzle, givenAt, 1)).toBe(start);
  });

  it("rubs a placed digit out of the notes it rules out, and only those", () => {
    const empties = puzzle.givens.flatMap((value, index) => (value === 0 ? [index] : []));
    const peer = empties.find((index) => index !== blank && arePeers(index, blank))!;
    const stranger = empties.find((index) => index !== blank && !arePeers(index, blank))!;
    let board = emptyBoard(puzzle);
    for (const index of [blank, peer, stranger]) {
      board = toggleNote(toggleNote(board, puzzle, index, 3), puzzle, index, 8);
    }
    const placed = place(board, puzzle, blank, 3);
    expect(placed.notes[blank]).toBe(0);
    expect(hasNote(placed.notes[peer]!, 3)).toBe(false);
    expect(hasNote(placed.notes[peer]!, 8)).toBe(true);
    expect(hasNote(placed.notes[stranger]!, 3)).toBe(true);
  });

  it("toggles notes only on an empty cell", () => {
    const start = emptyBoard(puzzle);
    const noted = toggleNote(start, puzzle, blank, 2);
    expect(hasNote(noted.notes[blank]!, 2)).toBe(true);
    expect(toggleNote(noted, puzzle, blank, 2).notes[blank]).toBe(0);
    const filled = place(start, puzzle, blank, 2);
    expect(toggleNote(filled, puzzle, blank, 5)).toBe(filled);
  });

  it("erases the digit first, then the notes, then nothing", () => {
    const noted = toggleNote(emptyBoard(puzzle), puzzle, blank, 2);
    expect(erase(noted, puzzle, blank).notes[blank]).toBe(0);
    const filled = place(emptyBoard(puzzle), puzzle, blank, 2);
    expect(erase(filled, puzzle, blank).values[blank]).toBe(0);
    const start = emptyBoard(puzzle);
    expect(erase(start, puzzle, blank)).toBe(start);
  });

  it("counts what is left of each digit", () => {
    const solved = solvedBoard(puzzle);
    expect(remaining(solved.values, 5)).toBe(0);
    expect(emptyCount(solved.values)).toBe(0);
    const values = Array<number>(CELLS).fill(0);
    expect(remaining(values, 5)).toBe(9);
    expect(remaining(Array<number>(CELLS).fill(5), 5)).toBe(0);
  });

  it("is solved only when full with no clash", () => {
    expect(isSolved(emptyBoard(puzzle))).toBe(false);
    expect(isSolved(solvedBoard(puzzle))).toBe(true);
    const clashing = [...puzzle.solution];
    clashing[0] = clashing[1]!;
    expect(isSolved({ values: clashing, notes: solvedBoard(puzzle).notes })).toBe(false);
  });
});

describe("restoreBoard", () => {
  it("reads back a board from a JSON round trip", () => {
    const board = toggleNote(place(emptyBoard(puzzle), puzzle, blank, 4), puzzle, puzzle.givens.lastIndexOf(0), 9);
    expect(restoreBoard(JSON.parse(JSON.stringify(board)), puzzle)).toEqual(board);
  });

  it("refuses anything that doesn't fit the puzzle", () => {
    const good = emptyBoard(puzzle);
    const wrongGiven = [...good.values];
    wrongGiven[givenAt] = (wrongGiven[givenAt]! % 9) + 1;
    for (const saved of [
      null,
      undefined,
      "nope",
      {},
      { values: good.values },
      { values: [1, 2, 3], notes: good.notes },
      { values: wrongGiven, notes: good.notes },
      { values: good.values.map(() => 12), notes: good.notes },
      { values: good.values, notes: good.notes.map(() => 512) },
      { values: good.values, notes: good.notes.map(() => 1.5) },
    ]) {
      expect(restoreBoard(saved, puzzle)).toBeNull();
    }
  });
});
