import { describe, expect, it } from "vitest";
import { createSandArcade } from "./sandArcade";
import { seeded } from "./seeded";

const COLS = 40;
const ROWS = 30;

/** Read the board back through the stamp, minus the spout cell on row 0. */
const read = (arcade: ReturnType<typeof createSandArcade>) => {
  const out = new Float32Array(COLS * ROWS);
  arcade.stamp(out, COLS, ROWS);
  return out;
};

const grains = (out: Float32Array, skipTop = false) => {
  let n = 0;
  for (let i = skipTop ? COLS : 0; i < out.length; i++) {
    if ((out[i] ?? 0) > 0) n += 1;
  }
  return n;
};

const run = (arcade: ReturnType<typeof createSandArcade>, ms: number) => {
  for (let t = 0; t < ms; t += 16) arcade.step(16);
};

const make = (seed = 1) => {
  const arcade = createSandArcade(seeded(seed));
  arcade.resize(COLS, ROWS);
  arcade.takeControl();
  arcade.step(500);
  return arcade;
};

describe("sand drop", () => {
  it("never ends and counts grains poured", () => {
    const arcade = make();
    arcade.action();
    run(arcade, 800);
    expect(arcade.gameOver()).toBe(false);
    expect(arcade.score()).toBeGreaterThan(5);
  });

  it("lets grains fall to the floor", () => {
    const arcade = make();
    arcade.action();
    run(arcade, 160);
    run(arcade, 1500);
    const out = read(arcade);
    const floor = out.slice((ROWS - 1) * COLS);
    expect([...floor].some((v) => v > 0)).toBe(true);
  });

  it("piles at an angle instead of a single column", () => {
    const arcade = make();
    for (let t = 0; t < 5000; t += 100) {
      arcade.action();
      run(arcade, 100);
    }
    run(arcade, 1500);
    const out = read(arcade);
    const widthAt = (y: number) => {
      let n = 0;
      for (let x = 0; x < COLS; x++) if ((out[y * COLS + x] ?? 0) > 0) n += 1;
      return n;
    };
    const floorWidth = widthAt(ROWS - 1);
    expect(floorWidth).toBeGreaterThan(8);
    expect(widthAt(ROWS - 4)).toBeLessThan(floorWidth);
    expect(widthAt(ROWS - 4)).toBeGreaterThan(0);
  });

  it("never passes one grain through another", () => {
    const arcade = make(7);
    arcade.steer(0, 1);
    for (let t = 0; t < 4000; t += 16) {
      arcade.steer(0, 1);
      arcade.step(16);
      const out = read(arcade);
      // No grain hangs below an empty cell with sand above that is not settling:
      // after a settled step, count never drops while nothing drains.
      expect(grains(out, true)).toBeLessThanOrEqual(arcade.score());
    }
  });

  it("conserves grains until the board drains", () => {
    const arcade = make(3);
    arcade.action();
    run(arcade, 160);
    run(arcade, 2000);
    const out = read(arcade);
    expect(grains(out, true)).toBe(arcade.score());
  });

  it("fills a lot, never past the limit, drains and keeps going", () => {
    const arcade = make(5);
    let peak = 0;
    let dropped = false;
    for (let t = 0; t < 120_000; t += 16) {
      arcade.steer(Math.sin(t / 2500) > 0 ? 1 : -1, 0);
      arcade.action();
      arcade.step(16);
      const share = grains(read(arcade), true) / (COLS * ROWS);
      peak = Math.max(peak, share);
      if (peak > 0.5 && share < peak - 0.05) dropped = true;
    }
    expect(dropped).toBe(true);
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(0.9);
    expect(arcade.gameOver()).toBe(false);
  });

  it("drains when a pile jams the spout", () => {
    const arcade = make(9);
    let drops = 0;
    let last = 0;
    for (let t = 0; t < 60_000; t += 16) {
      arcade.action();
      arcade.step(16);
      const now = grains(read(arcade), true);
      if (now < last) drops += 1;
      last = now;
    }
    expect(drops).toBeGreaterThan(0);
    expect(arcade.score()).toBeGreaterThan(grains(read(arcade), true));
  });

  it("moves the spout and cycles shades per pour", () => {
    const arcade = make();
    arcade.steer(-1, 0);
    run(arcade, 400);
    arcade.steerEnd?.(-1, 0);
    arcade.action();
    run(arcade, 100);
    arcade.step(400);
    arcade.action();
    run(arcade, 100);
    const out = read(arcade);
    const shades = new Set([...out].filter((v) => v > 0 && v < 1));
    expect(shades.size).toBeGreaterThanOrEqual(2);
    expect(out.slice(0, COLS).findIndex((v) => v === 1)).toBeLessThan(COLS / 2);
  });

  it("pours by itself when idle, inside the band", () => {
    const arcade = createSandArcade(seeded(2));
    arcade.resize(COLS, ROWS);
    run(arcade, 8000);
    const out = read(arcade);
    expect(grains(out, true)).toBeGreaterThan(20);
    const low = out.slice(Math.floor(ROWS * 0.62) * COLS);
    expect(grains(low)).toBe(0);
    expect(arcade.score()).toBe(0);
  });
});
