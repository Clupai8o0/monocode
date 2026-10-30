import { describe, expect, it } from "vitest";
import {
  ANTIC_GAP_MAX_MS,
  ANTIC_GAP_MIN_MS,
  CLICK_GAP_MS,
  CROSS_SPEED,
  DRAG_PX,
  FLIGHT_MAX_MS,
  HARD_LANDING_PX,
  HOP_MS,
  LONG_PRESS_MS,
  LOWER_MS,
  NAP_AFTER_MS,
  THROW_MAX_PX,
  WALL_BOUNCE,
  coinTaken,
  createPlay,
  cursorMoved,
  eyeRows,
  fxPose,
  nextAnticDelay,
  offLedge,
  playLook,
  playSpeed,
  pressCancel,
  pressDown,
  pressMove,
  pressUp,
  releaseVelocity,
  stepFlight,
  stepPlay,
  type Flight,
  type PlayEvent,
  type PlayState,
  type PlayWorld,
} from "./runnerPlay";
import { RUNNER_INSET, type RunnerPose } from "../../features/sessions/model/composerRunner";

const WORLD: PlayWorld = {
  left: 100,
  width: 600,
  ledgeY: 600,
  viewW: 1000,
  viewH: 800,
  obstacle: null,
  busy: true,
  stunning: false,
};

const LEDGE: RunnerPose = { x: 200, y: 0, facing: 1, airborne: false };

function flight(over: Partial<Flight> = {}): Flight {
  return {
    x: 400,
    feet: 300,
    vx: 0,
    vy: 0,
    impact: 0,
    bounced: false,
    bonk: false,
    ...over,
  };
}

function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function fly(f: Flight, world = WORLD, maxMs = 8000): number {
  for (let t = 0; t < maxMs; t += 16) {
    if (stepFlight(f, 16, world) === "landed") return t;
  }
  throw new Error("never landed");
}

function run(state: PlayState, from: number, to: number, world = WORLD): RunnerPose {
  let pose = LEDGE;
  for (let t = from; t <= to; t += 16) pose = stepPlay(state, t, 16, LEDGE, world);
  return pose;
}

function fxKinds(events: readonly PlayEvent[]): string[] {
  return events.flatMap((event) => (event.type === "fx" ? [event.kind] : []));
}

function ready(now = 0, reduced = false): PlayState {
  const state = createPlay(now, reduced, seeded());
  stepPlay(state, now, 16, LEDGE, WORLD);
  return state;
}

function clickAt(state: PlayState, now: number): void {
  pressDown(state, now, 300, 590);
  pressUp(state, now + 20);
}

describe("throw", () => {
  it("falls straight onto the ledge when dropped", () => {
    const f = flight();
    fly(f);
    expect(f.feet).toBe(WORLD.ledgeY);
    expect(f.x).toBe(400);
  });

  it("bounces off the side walls, losing speed", () => {
    const f = flight({ vx: 2000, feet: 100, vy: -300 });
    let bounced = false;
    for (let i = 0; i < 40 && !bounced; i++) {
      stepFlight(f, 16, WORLD);
      bounced = f.vx < 0;
    }
    expect(bounced).toBe(true);
    expect(f.vx).toBeCloseTo(-2000 * WALL_BOUNCE, 5);
  });

  it("bounces off the ceiling", () => {
    const f = flight({ feet: 40, vy: -2000 });
    stepFlight(f, 16, WORLD);
    stepFlight(f, 16, WORLD);
    expect(f.vy).toBeGreaterThan(0);
    expect(f.feet).toBeGreaterThanOrEqual(16);
  });

  it("settles with one small bounce and keeps the hardest hit", () => {
    const f = flight({ feet: 590, vy: 1500 });
    const first = stepFlight(f, 16, WORLD);
    expect(first).toBe("flying");
    expect(f.vy).toBeLessThan(0);
    fly(f);
    expect(f.impact).toBeGreaterThanOrEqual(1500);
  });

  it("gets back onto the track after missing it", () => {
    const f = flight({ x: 30, feet: 500 });
    fly(f);
    expect(f.feet).toBe(WORLD.ledgeY);
    expect(f.x).toBeGreaterThanOrEqual(WORLD.left + RUNNER_INSET);
    expect(f.x).toBeLessThanOrEqual(WORLD.left + WORLD.width - RUNNER_INSET);
  });

  it("dropped below the ledge, it bounces up and lands on top", () => {
    const f = flight({ feet: 700 });
    fly(f);
    expect(f.feet).toBe(WORLD.ledgeY);
  });

  it("stays inside a shrunken window", () => {
    const small = { ...WORLD, viewW: 300, viewH: 500, ledgeY: 400, width: 200 };
    const f = flight({ x: 900, feet: 750, vx: 500 });
    stepFlight(f, 16, small);
    expect(f.x).toBeLessThanOrEqual(300 - 8);
    expect(f.feet).toBeLessThanOrEqual(500);
  });

  it("reads the throw from the end of the drag only", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 200, x: 0, y: 0 },
      { t: 240, x: 40, y: 0 },
      { t: 280, x: 80, y: 0 },
    ];
    expect(releaseVelocity(samples, 290).vx).toBeCloseTo(1000, 5);
    // Paused before letting go: a drop, not a throw.
    expect(releaseVelocity(samples, 400)).toEqual({ vx: 0, vy: 0 });
  });

  it("caps a wild throw", () => {
    const { vx } = releaseVelocity(
      [
        { t: 0, x: 0, y: 0 },
        { t: 10, x: 900, y: 0 },
      ],
      12,
    );
    expect(vx).toBe(THROW_MAX_PX);
  });
});

describe("landing", () => {
  function dropFrom(feet: number, world = WORLD): PlayEvent | undefined {
    const state = ready();
    stepPlay(state, 0, 16, LEDGE, world);
    pressDown(state, 10, 300, 590);
    pressMove(state, 30, 300, feet);
    pressUp(state, 500);
    state.events.length = 0;
    run(state, 500, 4000, world);
    return state.events.find((event) => event.type === "land");
  }

  it("a short drop lands softly", () => {
    const event = dropFrom(520);
    expect(event).toMatchObject({ type: "land", stun: null });
  });

  it("a long drop stuns it", () => {
    const fall = (HARD_LANDING_PX * HARD_LANDING_PX) / (2 * 2200);
    const event = dropFrom(600 - fall - 40);
    expect(event).toMatchObject({ type: "land", stun: "hard" });
  });

  it("dropping it on the chevron is a bonk", () => {
    const event = dropFrom(520, {
      ...WORLD,
      obstacle: { left: 280, right: 320 },
    });
    expect(event).toMatchObject({ type: "land", stun: "bonk" });
  });

  it("gives the runner its new place on the track", () => {
    const state = ready();
    pressDown(state, 10, 300, 590);
    pressMove(state, 30, 500, 520);
    pressUp(state, 500);
    state.events.length = 0;
    run(state, 500, 4000);
    const event = state.events.find((e) => e.type === "land");
    expect(event).toMatchObject({ along: 300 - 100 + 200 - RUNNER_INSET });
    expect(offLedge(state)).toBe(false);
  });

  it("never lets a flight hang", () => {
    const stuck = { ...WORLD, ledgeY: 5000 };
    const state = ready();
    pressDown(state, 10, 300, 590);
    pressMove(state, 30, 300, 100);
    pressUp(state, 500);
    run(state, 500, 500 + FLIGHT_MAX_MS + 100, stuck);
    expect(state.mode).toBe("run");
  });
});

describe("clicks", () => {
  it("one click hops with a !", () => {
    const state = ready();
    clickAt(state, 100);
    expect(fxKinds(state.events)).toEqual(["bang"]);
    const pose = stepPlay(state, 120 + HOP_MS / 2, 16, LEDGE, WORLD);
    expect(pose.y).toBeGreaterThan(10);
  });

  it("two quick clicks backflip", () => {
    const state = ready();
    clickAt(state, 100);
    clickAt(state, 100 + CLICK_GAP_MS - 30);
    const now = 100 + CLICK_GAP_MS + 200;
    stepPlay(state, now, 16, LEDGE, WORLD);
    expect(playLook(state, now).spin).not.toBe(0);
  });

  it("two slow clicks are two hops", () => {
    const state = ready();
    clickAt(state, 100);
    clickAt(state, 100 + CLICK_GAP_MS + 200);
    expect(state.streak).toBe(1);
  });

  it("a few quick clicks make it cross, then it sprints and tires", () => {
    const state = ready();
    clickAt(state, 100);
    clickAt(state, 300);
    clickAt(state, 500);
    stepPlay(state, 600, 16, LEDGE, WORLD);
    expect(playLook(state, 600).cross).toBe(true);
    expect(playSpeed(state, 600)).toBe(CROSS_SPEED);
    state.events.length = 0;
    stepPlay(state, 3600, 16, LEDGE, WORLD);
    expect(playLook(state, 3600).cross).toBe(false);
    expect(playSpeed(state, 3600)).toBe(1);
    expect(fxKinds(state.events)).toContain("drop");
  });
});

describe("press and drag", () => {
  it("a long press pets it: eyes closed, hearts, no walking", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    run(state, 110, 100 + LONG_PRESS_MS + 700);
    expect(state.mode).toBe("pet");
    expect(fxKinds(state.events).filter((k) => k === "heart").length).toBeGreaterThan(1);
    const now = 100 + LONG_PRESS_MS + 720;
    expect(playLook(state, now).eyesClosed).toBe(true);
    expect(playSpeed(state, now)).toBe(0);
  });

  it("a quick press is a click, not a pet", () => {
    const state = ready();
    clickAt(state, 100);
    run(state, 130, 100 + LONG_PRESS_MS + 100);
    expect(state.mode).toBe("run");
  });

  it("dragging picks it up and it kicks", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 300 + DRAG_PX, 590);
    expect(state.mode).toBe("held");
    const pose = stepPlay(state, 120, 16, LEDGE, WORLD);
    expect(pose.x).toBeCloseTo(state.x - WORLD.left, 5);
    expect(playLook(state, 120).kicking).toBe(true);
    expect(playSpeed(state, 120)).toBe(0);
  });

  it("a small wobble while pressing stays a press", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 301, 591);
    expect(state.mode).toBe("press");
  });

  it("holds onto where you grabbed it", () => {
    const state = ready();
    const grabX = state.x + 5;
    pressDown(state, 100, grabX, 590);
    pressMove(state, 110, grabX + 100, 500);
    expect(state.x).toBeCloseTo(WORLD.left + LEDGE.x + 100, 5);
  });

  it("can't be carried out of the window", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, -500, -500);
    stepPlay(state, 120, 16, LEDGE, WORLD);
    expect(state.x).toBeGreaterThanOrEqual(8);
    expect(state.feet).toBeGreaterThanOrEqual(16);
  });

  it("shaking it leaves it dizzy on landing", () => {
    const state = ready();
    pressDown(state, 100, 300, 500);
    let t = 110;
    let x = 300;
    for (let i = 0; i < 6; i++) {
      x += i % 2 === 0 ? 40 : -40;
      pressMove(state, t, x, 500);
      t += 40;
    }
    expect(state.dizzy).toBe(true);
    pressUp(state, t + 200);
    state.events.length = 0;
    run(state, t + 200, t + 4000);
    expect(state.events.find((e) => e.type === "land")).toMatchObject({
      stun: "dizzy",
    });
  });

  it("slow side-to-side moves are not a shake", () => {
    const state = ready();
    pressDown(state, 100, 300, 500);
    let t = 110;
    let x = 300;
    for (let i = 0; i < 6; i++) {
      x += i % 2 === 0 ? 40 : -40;
      pressMove(state, t, x, 500);
      t += 500;
    }
    expect(state.dizzy).toBe(false);
  });

  it("can be caught in mid-air without snapping back to the ledge", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 300, 200);
    pressUp(state, 400);
    stepPlay(state, 416, 16, LEDGE, WORLD);
    expect(state.mode).toBe("flying");
    const x = state.x;
    pressDown(state, 420, x, state.feet - 8);
    expect(state.mode).toBe("held");
    const pose = stepPlay(state, 436, 16, LEDGE, WORLD);
    expect(pose.y).toBeGreaterThan(100);
  });

  it("a lost pointer drops it instead of leaving it hanging", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 300, 400);
    pressCancel(state, 120);
    expect(state.mode).toBe("flying");
    expect(state.flight.vx).toBe(0);
    expect(state.flight.vy).toBe(0);
  });
});

describe("the turn ending", () => {
  const ended = { ...WORLD, busy: false };

  it("lets it down gently when you're holding it", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 300, 200);
    expect(offLedge(state)).toBe(true);
    stepPlay(state, 120, 16, LEDGE, ended);
    expect(state.mode).toBe("lowering");
    const mid = stepPlay(state, 120 + LOWER_MS / 2, 16, LEDGE, ended);
    expect(mid.y).toBeGreaterThan(0);
    state.events.length = 0;
    stepPlay(state, 120 + LOWER_MS, 16, LEDGE, ended);
    expect(offLedge(state)).toBe(false);
    expect(state.events.find((e) => e.type === "land")).toMatchObject({
      stun: null,
    });
  });

  it("finishes a throw before exiting", () => {
    const state = ready();
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 300, 200);
    pressUp(state, 400);
    stepPlay(state, 416, 16, LEDGE, ended);
    expect(offLedge(state)).toBe(true);
    run(state, 432, 4000, ended);
    expect(offLedge(state)).toBe(false);
  });

  it("can't be grabbed once it's over", () => {
    const state = ready();
    stepPlay(state, 100, 16, LEDGE, ended);
    pressDown(state, 110, 300, 590);
    expect(state.mode).toBe("run");
  });
});

describe("cursor", () => {
  it("looks at a nearby cursor and slows down", () => {
    const state = ready();
    cursorMoved(state, 100, 280, 540);
    const pose = stepPlay(state, 110, 16, LEDGE, WORLD);
    expect(pose.facing).toBe(-1);
    expect(playSpeed(state, 110)).toBeLessThan(1);
  });

  it("stops looking when the cursor goes still", () => {
    const state = ready();
    cursorMoved(state, 100, 280, 540);
    const pose = stepPlay(state, 2000, 16, LEDGE, WORLD);
    expect(pose.facing).toBe(1);
    expect(playSpeed(state, 2000)).toBe(1);
  });

  it("jumps over a cursor on the ledge in front of it", () => {
    const state = ready();
    cursorMoved(state, 100, 330, WORLD.ledgeY);
    stepPlay(state, 110, 16, LEDGE, WORLD);
    const pose = stepPlay(state, 310, 16, LEDGE, WORLD);
    expect(pose.y).toBeGreaterThan(20);
  });

  it("does not jump a cursor behind it", () => {
    const state = ready();
    cursorMoved(state, 100, 270, WORLD.ledgeY);
    stepPlay(state, 110, 16, LEDGE, WORLD);
    const pose = stepPlay(state, 310, 16, LEDGE, WORLD);
    expect(pose.y).toBe(0);
  });

  it("waits while the cursor is on it, so it can be clicked", () => {
    const state = ready();
    cursorMoved(state, 100, 300, 595);
    stepPlay(state, 110, 16, LEDGE, WORLD);
    expect(playSpeed(state, 110)).toBe(0);
  });
});

describe("idle antics", () => {
  it("spaces them 20 to 40 seconds apart", () => {
    const random = seeded(7);
    for (let i = 0; i < 200; i++) {
      const delay = nextAnticDelay(random);
      expect(delay).toBeGreaterThanOrEqual(ANTIC_GAP_MIN_MS);
      expect(delay).toBeLessThanOrEqual(ANTIC_GAP_MAX_MS);
    }
  });

  function untilAntic(state: PlayState, from: number, kinds: string[], to: number): void {
    for (let t = from; t < to; t += 50) {
      stepPlay(state, t, 16, LEDGE, WORLD);
      if (state.mode === "antic" && state.antic && kinds[kinds.length - 1] !== state.antic) {
        kinds.push(state.antic);
      }
    }
  }

  it("runs them on a seeded clock, never twice running, and no naps early", () => {
    const state = createPlay(0, false, seeded(3));
    const kinds: string[] = [];
    untilAntic(state, 0, kinds, NAP_AFTER_MS - 1);
    expect(kinds.length).toBeGreaterThanOrEqual(2);
    expect(kinds).not.toContain("nap");
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
  });

  it("is the same every time for the same seed", () => {
    const pick = () => {
      const state = createPlay(0, false, seeded(11));
      const kinds: string[] = [];
      untilAntic(state, 0, kinds, 100_000);
      return kinds;
    };
    expect(pick()).toEqual(pick());
  });

  it("naps on a long turn, with Zzz, until the cursor comes near", () => {
    const state = createPlay(0, false, seeded(5));
    let t = 0;
    while (t < 600_000 && state.antic !== "nap") {
      stepPlay(state, t, 16, LEDGE, WORLD);
      t += 50;
    }
    expect(state.antic).toBe("nap");
    expect(t).toBeGreaterThanOrEqual(NAP_AFTER_MS);
    state.events.length = 0;
    run(state, t, t + 3000);
    expect(state.mode).toBe("antic");
    expect(fxKinds(state.events)).toContain("zzz");
    expect(playLook(state, t + 3000).eyesClosed).toBe(true);
    cursorMoved(state, t + 3100, state.x + 10, state.feet - 8);
    expect(state.mode).toBe("run");
  });

  it("doesn't start one in the air, or while stunned or held", () => {
    const state = createPlay(0, false, seeded(5));
    const later = ANTIC_GAP_MAX_MS + 1;
    stepPlay(state, later, 16, { ...LEDGE, y: 20, airborne: true }, WORLD);
    expect(state.mode).toBe("run");
    stepPlay(state, later, 16, LEDGE, { ...WORLD, stunning: true });
    expect(state.mode).toBe("run");
    stepPlay(state, later, 16, LEDGE, WORLD);
    expect(state.mode).toBe("antic");
  });

  it("stops at the end of the turn", () => {
    const state = createPlay(0, false, seeded(5));
    stepPlay(state, ANTIC_GAP_MAX_MS + 1, 16, LEDGE, WORLD);
    expect(state.mode).toBe("antic");
    stepPlay(state, ANTIC_GAP_MAX_MS + 20, 16, LEDGE, { ...WORLD, busy: false });
    expect(state.mode).toBe("run");
  });

  it("eats some coins and burps a little later", () => {
    const state = ready();
    state.random = () => 0;
    expect(coinTaken(state, 100)).toBe(true);
    state.events.length = 0;
    run(state, 110, 700);
    expect(fxKinds(state.events)).toContain("puff");
    state.random = () => 0.9;
    expect(coinTaken(state, 800)).toBe(false);
  });
});

describe("reduced motion", () => {
  it("has no throw and no pick-up", () => {
    const state = ready(0, true);
    pressDown(state, 100, 300, 590);
    pressMove(state, 110, 500, 300);
    expect(state.mode).toBe("press");
    pressUp(state, 120);
    expect(state.mode).toBe("run");
    expect(offLedge(state)).toBe(false);
  });

  it("still answers a click and a pet, without moving", () => {
    const state = ready(0, true);
    clickAt(state, 100);
    expect(fxKinds(state.events)).toEqual(["bang"]);
    expect(stepPlay(state, 200, 16, LEDGE, WORLD).y).toBe(0);
    pressDown(state, 1000, 300, 590);
    stepPlay(state, 1000 + LONG_PRESS_MS + 10, 16, LEDGE, WORLD);
    expect(state.mode).toBe("pet");
    expect(playLook(state, 1500).eyesClosed).toBe(true);
    expect(playLook(state, 1500).spin).toBe(0);
  });

  it("gets no antics, and eats no coins", () => {
    const state = createPlay(0, true, () => 0);
    run(state, 0, ANTIC_GAP_MAX_MS + 100);
    expect(state.mode).toBe("run");
    expect(coinTaken(state, 100)).toBe(false);
  });

  it("holds effects still", () => {
    expect(fxPose("heart", 100, true)?.dx).toBe(0);
    expect(fxPose("heart", 100, true)?.dy).toBe(fxPose("heart", 500, true)?.dy);
  });
});

describe("sprites", () => {
  it("closes the eyes it finds: the holes in the face", () => {
    const rows = eyeRows([
      "..####..",
      ".######.",
      "##.##.##",
      "########",
      "########",
      "########",
      "########",
      "#.##.##.",
    ]);
    expect(rows[2]).toBe("..#..#..");
    expect(rows.filter((row) => row.includes("#"))).toHaveLength(1);
  });

  it("finds nothing on a sprite with no eyes", () => {
    const rows = eyeRows([
      "..####..",
      ".######.",
      "########",
      "########",
      "########",
      "########",
      ".######.",
      "..####..",
    ]);
    expect(rows.every((row) => !row.includes("#"))).toBe(true);
  });

  it("ends every effect", () => {
    expect(fxPose("bang", 10_000, false)).toBeNull();
    expect(fxPose("zzz", 10_000, false)).toBeNull();
  });
});
