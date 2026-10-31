import { describe, expect, it } from "vitest";
import { COLOURS_FOR, TUBE_SIZE, canPour, generate, isSolved, pour, pourCount, solve, type Board } from "./colourSort";

function play(board: Board, moves: { from: number; to: number }[]) {
  return moves.reduce((current, { from, to }) => {
    expect(canPour(current, from, to)).toBe(true);
    return pour(current, from, to);
  }, board);
}

describe("colour sort", () => {
  for (const colours of Object.values(COLOURS_FOR)) {
    it(`generates solvable ${colours}-colour puzzles`, () => {
      const count = colours === 9 ? 15 : 40;
      for (let seed = 1; seed <= count; seed++) {
        const board = generate(seed, colours);
        expect(board).toHaveLength(colours + 2);
        expect(board.flat()).toHaveLength(colours * TUBE_SIZE);
        expect(isSolved(board)).toBe(false);
        const moves = solve(board);
        expect(moves).not.toBeNull();
        expect(isSolved(play(board, moves!))).toBe(true);
      }
    });
  }

  it("is the same puzzle for the same seed", () => {
    expect(generate(7, 6)).toEqual(generate(7, 6));
  });

  it("pours the top run onto an empty tube", () => {
    const board: Board = [[0, 1, 1], []];
    expect(pourCount(board, 0, 1)).toBe(2);
    expect(pour(board, 0, 1)).toEqual([[0], [1, 1]]);
  });

  it("pours onto the same colour only as far as there is room", () => {
    const board: Board = [[2, 1, 1, 1], [0, 0, 1]];
    expect(pour(board, 0, 1)).toEqual([[2, 1, 1], [0, 0, 1, 1]]);
  });

  it("refuses a different colour, a full tube, an empty source and itself", () => {
    const board: Board = [[0, 1], [0, 2], [3, 3, 3, 3], []];
    expect(canPour(board, 0, 1)).toBe(false);
    expect(canPour(board, 0, 2)).toBe(false);
    expect(canPour(board, 3, 0)).toBe(false);
    expect(canPour(board, 0, 0)).toBe(false);
    expect(pour(board, 0, 1)).toBe(board);
  });

  it("knows when it is solved", () => {
    expect(isSolved([[0, 0, 0, 0], [], [1, 1, 1, 1]])).toBe(true);
    expect(isSolved([[0, 0, 0], [0], [1, 1, 1, 1]])).toBe(false);
    expect(isSolved([[0, 0, 1, 1], [], []])).toBe(false);
  });

  it("finds no answer for a stuck board", () => {
    expect(solve([[0, 1, 0, 1], [1, 0, 1, 0]])).toBeNull();
  });
});
