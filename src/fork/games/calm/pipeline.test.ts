import { describe, expect, it } from "vitest";
import { E, N, S, SIZE_FOR, W, commitCell, flow, generate, isSolved, rotate, turn, type Board, type Mode } from "./pipeline";

const MODES = Object.keys(SIZE_FOR) as Mode[];

function tiny(tiles: number[], cols: number, rows: number, checks: Board["checks"] = []): Board {
  return { cols, rows, tiles, start: 0, end: 0, checks };
}

describe("pipeline", () => {
  for (const mode of MODES) {
    it(`generates ${mode} boards that start unsolved and solve at the solution`, () => {
      const { cols, rows } = SIZE_FOR[mode];
      for (let seed = 1; seed <= 60; seed++) {
        const { board, solution, path } = generate(seed, mode);
        expect(board.tiles).toHaveLength(cols * rows);
        expect(isSolved(board)).toBe(false);
        expect(isSolved(solution)).toBe(true);
        expect(path.length).toBeGreaterThanOrEqual(cols);
        // Every tile is only a turned copy of its solution tile.
        board.tiles.forEach((mask, i) => {
          const options = [0, 1, 2, 3].map((n) => [...Array(n)].reduce((m: number) => turn(m), solution.tiles[i]!));
          expect(options).toContain(mask);
        });
        // Rotating each path tile into place solves it.
        let current: Board = board;
        for (const cell of path) {
          for (let n = 0; n < 4 && current.tiles[cell] !== solution.tiles[cell]; n++) {
            current = rotate(current, cell);
          }
        }
        expect(isSolved(current)).toBe(true);
      }
    });

    it(`puts ${mode} checkpoints on distinct path cells`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const { board, path } = generate(seed, mode);
        const cells = board.checks.map((c) => c.index);
        expect(new Set(cells).size).toBe(cells.length);
        expect(board.checks.length).toBe(mode === "hard" ? 3 : 2);
        for (const cell of cells) {
          expect(path).toContain(cell);
        }
        expect(cells).toEqual([...cells].sort((a, b) => path.indexOf(a) - path.indexOf(b)));
      }
    });
  }

  it("is deterministic per seed", () => {
    expect(generate(7, "mid")).toEqual(generate(7, "mid"));
  });

  it("rotating four times restores the tile and leaves the original board alone", () => {
    const { board } = generate(3, "low");
    let current = board;
    for (let i = 0; i < 4; i++) {
      current = rotate(current, 5);
    }
    expect(current.tiles).toEqual(board.tiles);
    expect(rotate(board, 5)).not.toBe(board);
    expect(turn(N)).toBe(E);
    expect(turn(W)).toBe(N);
  });

  it("flows only through sides open on both tiles", () => {
    // 2x1: commit tile E-W then a tile whose W side is shut.
    const shut = tiny([E | W, N | S], 2, 1);
    expect([...flow(shut)]).toEqual([0]);
    const open = tiny([E | W, E | W], 2, 1);
    expect([...flow(open)].sort()).toEqual([0, 1]);
    expect(isSolved(open)).toBe(true);
  });

  it("needs the commit side open and every checkpoint lit", () => {
    expect(flow(tiny([N | S, E | W], 2, 1)).size).toBe(0);
    const board = tiny([E | W, E | W], 2, 1, [{ index: 1, label: "test" }]);
    expect(isSolved(board)).toBe(true);
    expect(isSolved({ ...board, checks: [{ index: 1, label: "test" }, { index: 0, label: "x" }] })).toBe(true);
    // A branch that misses the checkpoint leaves it unsolved.
    const side = { cols: 2, rows: 2, tiles: [E | W | S, E | W, N, 0], start: 0, end: 0, checks: [{ index: 2, label: "test" }] };
    expect(isSolved(side)).toBe(true);
    expect(isSolved({ ...side, tiles: [E | W, E | W, N, 0] })).toBe(false);
    expect(commitCell(side)).toBe(0);
    void S;
  });
});
