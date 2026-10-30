import { describe, expect, it } from "vitest";
import {
  OBSTACLE_SHAPES,
  SPEED,
  SPEED_GROWTH,
  canClear,
  createRunnerArcade,
  minimumGap,
} from "./runnerArcade";
import { seeded } from "./seeded";

describe("agent run fairness", () => {
  it("keeps tall ones thin and wide ones low", () => {
    for (const { width, height } of OBSTACLE_SHAPES) {
      if (width > 3) expect(height).toBeLessThanOrEqual(3);
      if (height > 3) expect(width).toBeLessThanOrEqual(3);
      expect(height).toBeLessThanOrEqual(5);
      expect(width).toBeLessThanOrEqual(5);
    }
  });

  it("can clear every shape at every speed the game reaches", () => {
    const low = SPEED.low;
    const high = SPEED.hard * SPEED_GROWTH;
    for (const { width, height } of OBSTACLE_SHAPES) {
      for (let speed = low; speed <= high; speed += 1) {
        expect(canClear(width, height, speed), `${width}x${height}@${speed}`).toBe(
          true,
        );
      }
    }
  });

  it("leaves room to land and take off again", () => {
    for (let speed = SPEED.low; speed <= SPEED.hard * SPEED_GROWTH; speed += 4) {
      // Air time at speed, plus the hitbox's own width.
      expect(minimumGap(speed)).toBeGreaterThan(speed * (100 / 170) + 4);
    }
  });
});

describe("agent run arcade", () => {
  const steps = (arcade: ReturnType<typeof createRunnerArcade>, ms: number) => {
    for (let t = 0; t < ms && !arcade.gameOver(); t += 33) arcade.step(33);
  };

  it("idles without dying for a minute", () => {
    for (const seed of [1, 2, 3, 4]) {
      const arcade = createRunnerArcade(seeded(seed));
      arcade.resize(172, 28);
      const sprite = () => arcade.sprites()[0]!;
      let deaths = 0;
      for (let t = 0; t < 60_000; t += 33) {
        arcade.step(33);
        if (sprite().alpha < 0.5 && t > 1000) deaths += 1;
      }
      expect(deaths, `seed ${seed}`).toBe(0);
    }
  });

  it("ends a run on an obstacle, scores distance, and retries on Space", () => {
    const arcade = createRunnerArcade(seeded(5));
    arcade.resize(86, 68);
    arcade.takeControl();
    steps(arcade, 40_000);
    expect(arcade.gameOver()).toBe(true);
    expect(arcade.score()).toBeGreaterThan(0);
    arcade.action?.();
    expect(arcade.gameOver()).toBe(false);
    expect(arcade.score()).toBe(0);
  });

  it("jumps higher the longer the key is held", () => {
    const peak = (holdMs: number) => {
      const arcade = createRunnerArcade(seeded(6));
      arcade.resize(86, 68);
      arcade.takeControl();
      arcade.action?.();
      const start = arcade.sprites()[0]!.cy;
      let highest = start;
      for (let t = 0; t < 700; t += 16) {
        if (t >= holdMs) arcade.steerEnd?.(0, -1);
        arcade.step(16);
        highest = Math.min(highest, arcade.sprites()[0]!.cy);
      }
      return start - highest;
    };
    expect(peak(40)).toBeLessThan(peak(400));
  });

  it("ignores a held key's repeats", () => {
    const arcade = createRunnerArcade(seeded(7));
    arcade.resize(86, 68);
    arcade.takeControl();
    arcade.steer(0, -1);
    for (let t = 0; t < 2000 && !arcade.gameOver(); t += 16) {
      arcade.steer(0, -1);
      arcade.step(16);
    }
    // One jump, then down and staying down until the key comes back up.
    expect(arcade.sprites()[0]!.frame).toBe("rest");
  });
});
