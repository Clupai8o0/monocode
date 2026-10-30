import { describe, expect, it } from "vitest";
import {
  WELL_HEIGHT,
  WELL_WIDTH,
  bestPlacement,
  collides,
  createBlocksArcade,
  createWell,
  hardDrop,
  landingY,
  lockPiece,
  movePiece,
  rotatePiece,
} from "./blocksArcade";
import { seeded } from "./seeded";

function play(arcade: ReturnType<typeof createBlocksArcade>, ms: number) {
  for (let t = 0; t < ms; t += 33) arcade.step(33);
}

describe("blocks well", () => {
  it("deals every shape once per bag", () => {
    const random = seeded(1);
    const well = createWell(10, 20, random);
    const kinds = [well.piece.kind];
    for (let i = 0; i < 6; i++) {
      kinds.push(well.next);
      hardDrop(well, random);
      well.cells.fill(0);
    }
    expect(new Set(kinds).size).toBe(7);
  });

  it("stops a piece at the walls and the floor", () => {
    const well = createWell(10, 20, seeded(2));
    while (movePiece(well, -1, 0));
    expect(collides(well, { ...well.piece, x: well.piece.x - 1 })).toBe(true);
    well.piece = { ...well.piece, y: landingY(well) };
    expect(movePiece(well, 0, 1)).toBe(false);
  });

  it("kicks off a wall rather than refusing to turn", () => {
    const well = createWell(10, 20, seeded(3));
    well.piece = { kind: 0, turn: 1, x: -2, y: 4 };
    expect(collides(well, well.piece)).toBe(false);
    expect(rotatePiece(well)).toBe(true);
    expect(collides(well, well.piece)).toBe(false);
  });

  it("clears a full row and drops what was above it", () => {
    const random = seeded(4);
    const well = createWell(4, 6, random);
    // A row short of an O block, and a marker sitting above it.
    well.cells.fill(1, 5 * 4, 6 * 4);
    well.cells[5 * 4 + 1] = 0;
    well.cells[5 * 4 + 2] = 0;
    well.cells[4 * 4] = 1;
    well.piece = { kind: 1, turn: 0, x: 1, y: 4 };
    expect(lockPiece(well, random)).toBe(1);
    expect(well.cells[5 * 4]).toBe(1);
    expect(well.cells[4 * 4]).toBe(0);
    expect(well.lines).toBe(1);
  });

  it("tops out when the stack blocks the spawn", () => {
    const random = seeded(5);
    const well = createWell(10, 20, random);
    let guard = 0;
    while (!well.over && guard++ < 200) hardDrop(well, random);
    expect(well.over).toBe(true);
  });

  it("keeps a brain alive for a good while on a band-height well", () => {
    const random = seeded(6);
    const well = createWell(10, 17, random);
    let pieces = 0;
    while (!well.over && pieces < 300) {
      const target = bestPlacement(well);
      expect(target).not.toBeNull();
      well.piece = { ...well.piece, turn: target!.turn, x: target!.x };
      hardDrop(well, random);
      pieces += 1;
    }
    expect(pieces).toBeGreaterThan(60);
    expect(well.lines).toBeGreaterThan(20);
  });
});

describe("blocks arcade", () => {
  it("drops on its own, faster on hard", () => {
    const fall = (mode: "low" | "hard") => {
      const arcade = createBlocksArcade(seeded(7));
      arcade.resize(86, 68);
      arcade.setMode(mode);
      arcade.takeControl();
      const out = new Float32Array(86 * 68);
      const top = () => {
        out.fill(0);
        arcade.stamp(out, 86, 68);
        for (let i = 0; i < out.length; i++) {
          // Past the boot fade the active piece is the brightest thing there.
          if (out[i]! > 0.9) return Math.floor(i / 86);
        }
        return -1;
      };
      play(arcade, 500);
      const before = top();
      play(arcade, 1000);
      return top() - before;
    };
    expect(fall("hard")).toBeGreaterThan(fall("low"));
  });

  it("scores a hard drop line and retries after topping out", () => {
    const arcade = createBlocksArcade(seeded(8));
    arcade.resize(86, 68);
    arcade.takeControl();
    expect(arcade.gameOver()).toBe(false);
    let guard = 0;
    while (!arcade.gameOver() && guard++ < 200) arcade.action?.();
    expect(arcade.gameOver()).toBe(true);
    arcade.action?.();
    expect(arcade.gameOver()).toBe(false);
    expect(arcade.score()).toBe(0);
  });

  it("takes one turn per held key repeat window, but any fresh tap", () => {
    const arcade = createBlocksArcade(seeded(9));
    arcade.resize(86, 68);
    arcade.takeControl();
    const snapshot = () => {
      const out = new Float32Array(86 * 68);
      arcade.stamp(out, 86, 68);
      return out.join();
    };
    play(arcade, 500);
    arcade.steer(0, -1);
    const turned = snapshot();
    arcade.steer(0, -1);
    expect(snapshot()).toBe(turned);
    arcade.steerEnd?.(0, -1);
    arcade.steer(0, -1);
    expect(snapshot()).not.toBe(turned);
  });

  it("fits idle wells to the band without touching a player's well", () => {
    const arcade = createBlocksArcade(seeded(10));
    arcade.resize(172, 28);
    play(arcade, 2000);
    const out = new Float32Array(172 * 28);
    arcade.stamp(out, 172, 28);
    expect(out.some((value) => value > 0.5)).toBe(true);
    // Nothing below the band's visible part.
    const lowest = Math.floor(28 * 0.62);
    expect(out.slice(lowest * 172).some((value) => value > 0)).toBe(false);
    expect(WELL_WIDTH * 2).toBe(WELL_HEIGHT);
  });
});
