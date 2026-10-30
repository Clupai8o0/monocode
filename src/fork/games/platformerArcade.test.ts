import { describe, expect, it } from "vitest";
import {
  MAX_GAP,
  MAX_STEP,
  createPlatformerArcade,
  isStomp,
  isTerrain,
  jumpHeight,
} from "./platformerArcade";
import { seeded } from "./seeded";

describe("mono bros level", () => {
  it("never builds a gap or a step beyond what a jump can do", () => {
    expect(jumpHeight()).toBeGreaterThan(MAX_STEP + 1);
    for (const seed of [1, 2, 3, 4, 5]) {
      const arcade = createPlatformerArcade(seeded(seed));
      arcade.resize(172, 28);
      for (let t = 0; t < 30_000; t += 33) arcade.step(33);
      const profile = arcade.groundProfile();
      let gap = 0;
      let last = profile[0] ?? 1;
      for (const height of profile) {
        if (height === 0) {
          gap += 1;
          expect(gap).toBeLessThanOrEqual(MAX_GAP);
          continue;
        }
        gap = 0;
        expect(Math.abs(height - last)).toBeLessThanOrEqual(MAX_STEP);
        last = height;
      }
    }
  });
});

describe("mono bros arcade", () => {
  it("has no floor under a pit", () => {
    expect(isTerrain(0, -1)).toBe(false);
    expect(isTerrain(0, 0)).toBe(false);
    expect(isTerrain(2, 1)).toBe(true);
    expect(isTerrain(2, -1)).toBe(true);
    expect(isTerrain(2, 2)).toBe(false);
  });

  it("idle brain makes real headway over a minute", () => {
    for (const seed of [11, 12, 13]) {
      const arcade = createPlatformerArcade(seeded(seed));
      arcade.resize(172, 28);
      for (let t = 0; t < 60_000; t += 33) arcade.step(33);
      expect(arcade.progress(), `seed ${seed}`).toBeGreaterThan(150);
    }
  });

  it("runs while a key is held and stops when it comes up", () => {
    const arcade = createPlatformerArcade(seeded(14));
    arcade.resize(86, 68);
    arcade.takeControl();
    const startX = arcade.sprites()[0]!.cx;
    arcade.steer(1, 0);
    for (let t = 0; t < 500; t += 16) arcade.step(16);
    const moved = arcade.sprites()[0]!.cx;
    expect(moved).toBeGreaterThan(startX);
    arcade.steerEnd?.(1, 0);
    for (let t = 0; t < 400; t += 16) arcade.step(16);
    const rest = arcade.progress();
    for (let t = 0; t < 400; t += 16) arcade.step(16);
    expect(arcade.progress()).toBe(rest);
  });

  it("jumps once per press, not on held-key repeats", () => {
    const arcade = createPlatformerArcade(seeded(15));
    arcade.resize(86, 68);
    arcade.takeControl();
    for (let t = 0; t < 100; t += 16) arcade.step(16);
    const ground = arcade.sprites()[0]!.cy;
    arcade.steer(0, -1);
    let airborne = 0;
    for (let t = 0; t < 2000; t += 16) {
      arcade.steer(0, -1);
      arcade.step(16);
      if (t > 1000 && arcade.sprites()[0]!.cy < ground - 0.5) airborne += 1;
    }
    expect(airborne).toBe(0);
    arcade.steerEnd?.(0, -1);
    arcade.steer(0, -1);
    arcade.step(32);
    arcade.step(32);
    expect(arcade.sprites()[0]!.cy).toBeLessThan(ground);
  });

  it("spends three lives, ends, and starts over on Space", () => {
    const arcade = createPlatformerArcade(seeded(16));
    arcade.resize(86, 68);
    arcade.takeControl();
    expect(arcade.lives()).toBe(3);
    arcade.steer(1, 0);
    const seen = new Set<number>();
    // Hops a step it's stuck against, but never looks out for a pit.
    let last = 0;
    let stuck = 0;
    for (let t = 0; t < 240_000 && !arcade.gameOver(); t += 16) {
      arcade.step(16);
      seen.add(arcade.lives());
      stuck = arcade.progress() > last ? 0 : stuck + 16;
      last = arcade.progress();
      // Long enough for the last jump to finish: letting go early cuts it short.
      if (stuck > 900) {
        arcade.steerEnd?.(0, -1);
        arcade.steer(0, -1);
        stuck = 0;
      }
    }
    expect(arcade.gameOver()).toBe(true);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    arcade.action?.();
    expect(arcade.gameOver()).toBe(false);
    expect(arcade.lives()).toBe(3);
    expect(arcade.score()).toBe(0);
  });

  it("only counts coming down on top as a stomp", () => {
    expect(isStomp(-5, 1.5, 1, 0.8)).toBe(true);
    expect(isStomp(-5, 1.1, 1, 0.8)).toBe(false);
    expect(isStomp(3, 1.5, 1, 0.8)).toBe(false);
  });
});
