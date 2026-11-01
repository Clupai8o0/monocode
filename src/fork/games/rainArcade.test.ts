import { describe, expect, it } from "vitest";
import {
  CACHE_SCORE,
  CAPACITY,
  FALL_SPEED,
  START_LIVES,
  createRainArcade,
  rainProbe,
} from "./rainArcade";
import { seeded } from "./seeded";

const COLS = 60;
const ROWS = 30;

function start() {
  const arcade = createRainArcade(seeded(5));
  arcade.resize(COLS, ROWS);
  arcade.takeControl();
  const probe = rainProbe(arcade)!;
  // No random rain, so each test controls exactly what falls.
  probe.quiet(true);
  arcade.step(500);
  return { arcade, probe };
}

/** Drops one thing straight over the bucket's centre and lets it land. */
function catchOne(
  { arcade, probe }: ReturnType<typeof start>,
  kind: "token" | "cache" | "error",
) {
  probe.spawn(kind, probe.bucketX() + 2, probe.bucketY() - 4);
  // Stop as soon as the game ends, so the retry delay is still ahead of us.
  for (let t = 0; t < 1000 && !arcade.gameOver(); t += 16) arcade.step(16);
}

describe("token rain", () => {
  it("fills the context window when a token is caught", () => {
    const game = start();
    catchOne(game, "token");
    expect(game.probe.fill()).toBe(1);
    expect(game.arcade.score()).toBe(0);
  });

  it("scores a cache hit without filling context", () => {
    const game = start();
    catchOne(game, "cache");
    expect(game.probe.fill()).toBe(0);
    expect(game.arcade.score()).toBe(CACHE_SCORE);
  });

  it("compacts the fill into score, with a bonus above 75%", () => {
    const low = start();
    low.probe.setFill(10);
    low.arcade.action?.();
    expect(low.arcade.score()).toBe(10);
    expect(low.probe.fill()).toBe(0);

    const high = start();
    high.probe.setFill(Math.floor(CAPACITY * 0.8));
    high.arcade.action?.();
    expect(high.arcade.score()).toBe(Math.floor(CAPACITY * 0.8) * 2);
  });

  it("costs a life and wipes the fill when the window overflows", () => {
    const game = start();
    game.probe.setFill(CAPACITY - 1);
    catchOne(game, "token");
    expect(game.arcade.lives?.()).toBe(START_LIVES - 1);
    expect(game.probe.fill()).toBe(0);
    expect(game.arcade.score()).toBe(0);
  });

  it("costs a life when an error is caught", () => {
    const game = start();
    catchOne(game, "error");
    expect(game.arcade.lives?.()).toBe(START_LIVES - 1);
  });

  it("ends at zero lives and restarts on Space after the retry delay", () => {
    const game = start();
    for (let i = 0; i < START_LIVES; i++) catchOne(game, "error");
    expect(game.arcade.gameOver()).toBe(true);
    game.arcade.action?.();
    expect(game.arcade.gameOver()).toBe(true);
    for (let t = 0; t < 1000; t += 16) game.arcade.step(16);
    game.arcade.action?.();
    expect(game.arcade.gameOver()).toBe(false);
    expect(game.arcade.lives?.()).toBe(START_LIVES);
  });

  it("moves the bucket with the arrows and keeps it on the board", () => {
    const { arcade, probe } = start();
    const before = probe.bucketX();
    arcade.steer(1, 0);
    expect(probe.bucketX()).toBeGreaterThan(before);
    for (let i = 0; i < 100; i++) arcade.steer(-1, 0);
    expect(probe.bucketX()).toBe(0);
  });

  it("falls faster on harder modes", () => {
    expect(FALL_SPEED.low).toBeLessThan(FALL_SPEED.mid);
    expect(FALL_SPEED.mid).toBeLessThan(FALL_SPEED.hard);
  });

  it("plays itself without reporting a score", () => {
    for (const seed of [1, 2, 3]) {
      const arcade = createRainArcade(seeded(seed));
      arcade.resize(COLS, ROWS);
      for (let t = 0; t < 60_000; t += 33) {
        arcade.step(33);
        expect(arcade.score()).toBe(0);
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
