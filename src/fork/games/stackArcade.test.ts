import { describe, expect, it } from "vitest";
import {
  MOVER_VALUE,
  PERFECT_BONUS,
  SLIDE_SPEED,
  createStackArcade,
} from "./stackArcade";
import { seeded } from "./seeded";

const COLS = 60;
const ROWS = 30;

function mover(arcade: ReturnType<typeof createStackArcade>) {
  const out = new Float32Array(COLS * ROWS);
  arcade.stamp(out, COLS, ROWS);
  let left = Infinity;
  let right = -1;
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i]! - MOVER_VALUE) < 1e-6) {
      const x = i % COLS;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return right < 0 ? null : { x: left, w: right - left + 1 };
}

function start() {
  const arcade = createStackArcade(seeded(3));
  arcade.resize(COLS, ROWS);
  arcade.takeControl();
  // Let the boot fade finish so the stamp is at full brightness.
  arcade.step(500);
  return arcade;
}

/** Steps until the sliding block sits at `x`, then drops it. */
function dropAt(arcade: ReturnType<typeof createStackArcade>, x: number) {
  for (let i = 0; i < 2000; i++) {
    const m = mover(arcade);
    if (m && m.x === x) {
      arcade.action?.();
      return;
    }
    arcade.step(16);
  }
  throw new Error(`block never reached ${x}`);
}

describe("stack tower", () => {
  it("cuts the overhang so the next block is as wide as what landed", () => {
    const arcade = start();
    const first = mover(arcade)!;
    // The base is centred; land the block 4 cells to its right.
    const base = Math.floor((COLS - first.w) / 2);
    dropAt(arcade, base + 4);
    expect(mover(arcade)!.w).toBe(first.w - 4);
    expect(arcade.score()).toBe(1);
  });

  it("keeps the width and scores a bonus on a perfect drop", () => {
    const arcade = start();
    const first = mover(arcade)!;
    const base = Math.floor((COLS - first.w) / 2);
    dropAt(arcade, base + 1);
    expect(mover(arcade)!.w).toBe(first.w);
    expect(arcade.score()).toBe(1 + PERFECT_BONUS);
  });

  it("ends the game when a block misses entirely, and Space retries after a delay", () => {
    const arcade = start();
    const first = mover(arcade)!;
    const base = Math.floor((COLS - first.w) / 2);
    dropAt(arcade, base + first.w + 2);
    expect(arcade.gameOver()).toBe(true);
    // Too soon to retry.
    arcade.action?.();
    expect(arcade.gameOver()).toBe(true);
    for (let t = 0; t < 1000; t += 16) arcade.step(16);
    arcade.action?.();
    expect(arcade.gameOver()).toBe(false);
    expect(arcade.score()).toBe(0);
  });

  it("drops on the down key too", () => {
    const arcade = start();
    arcade.steer(0, 1);
    expect(arcade.gameOver() || arcade.score() > 0).toBe(true);
  });

  it("slides faster on harder modes", () => {
    expect(SLIDE_SPEED.low).toBeLessThan(SLIDE_SPEED.mid);
    expect(SLIDE_SPEED.mid).toBeLessThan(SLIDE_SPEED.hard);
  });

  it("idles without ending and stays inside the band's top rows", () => {
    for (const seed of [1, 2, 3, 4]) {
      const arcade = createStackArcade(seeded(seed));
      arcade.resize(COLS, ROWS);
      for (let t = 0; t < 90_000; t += 33) {
        arcade.step(33);
        expect(arcade.gameOver()).toBe(false);
      }
      const out = new Float32Array(COLS * ROWS);
      arcade.stamp(out, COLS, ROWS);
      const lowest = Math.max(
        ...Array.from(out, (v, i) => (v > 0 ? Math.floor(i / COLS) : -1)),
      );
      expect(lowest).toBeLessThan(Math.floor(ROWS * 0.62));
    }
  });
});
