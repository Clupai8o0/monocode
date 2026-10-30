/**
 * What the composer runner does when you play with it: clicks, petting, picking
 * it up, throwing it, and the small things it gets up to on a long turn. Pure:
 * the clock and the dice are passed in, and the DOM lives in the controller.
 */

import { mascotPath } from "../../features/projects/model/projectMascots";
import {
  RUNNER_INSET,
  RUNNER_SIZE,
  type RunnerPose,
} from "../../features/sessions/model/composerRunner";

export const HIT_PAD = 6;

export const LONG_PRESS_MS = 420;
export const CLICK_GAP_MS = 380;
export const DRAG_PX = 5;
export const CROSS_CLICKS = 3;
export const CROSS_MS = 3000;
export const CROSS_SPEED = 2.4;
export const LOOK_SPEED = 0.35;
export const HEART_EVERY_MS = 320;

export const HOP_MS = 300;
export const HOP_PEAK = 18;
export const FLIP_MS = 520;
export const FLIP_PEAK = 36;
export const CURSOR_HOP_MS = 420;
export const CURSOR_HOP_PEAK = 30;

export const NEAR_PX = 64;
const CURSOR_HOP_BAND = 14;
const CURSOR_HOP_MIN = 10;
const CURSOR_HOP_MAX = 48;
const CURSOR_JUMP_FRESH_MS = 600;
const CURSOR_LOOK_FRESH_MS = 800;
const CURSOR_PAUSE_FRESH_MS = 1500;

export const GRAVITY_PX = 2200;
export const WALL_BOUNCE = 0.62;
export const THROW_MIN_PX = 220;
export const THROW_MAX_PX = 2600;
const THROW_WINDOW_MS = 90;
const THROW_STALE_MS = 60;
/** Falling faster than this when it meets the ledge stuns it. */
export const HARD_LANDING_PX = 1100;
const SETTLE_BOUNCE_PX = 500;
const SETTLE_BOUNCE = 0.3;
const RELAUNCH_APEX = 40;
export const FLIGHT_MAX_MS = 6000;
export const LOWER_MS = 420;
const LAND_SQUASH_MS = 120;
const LAND_EASE_MS = 180;

const SHAKE_PX = 4;
const SHAKE_GAP_MS = 300;
export const SHAKE_FLIPS = 3;
/** Extra rounds of stars after a shake, on top of the first. */
export const DIZZY_STUNS = 2;

export const ANTIC_GAP_MIN_MS = 20_000;
export const ANTIC_GAP_MAX_MS = 40_000;
export const NAP_AFTER_MS = 120_000;
const NAP_CHANCE = 0.5;
const AFTER_PLAY_QUIET_MS = 8000;
const NAP_Z_EVERY_MS = 1100;
export const EAT_CHANCE = 0.2;
export const BURP_AFTER_MS = 500;

export type AnticKind = "sit" | "wave" | "look" | "dance" | "yawn" | "nap";

const ANTIC_MS: Record<Exclude<AnticKind, "nap">, number> = {
  sit: 2400,
  wave: 1800,
  look: 2200,
  dance: 2400,
  yawn: 1600,
};
const DAY_ANTICS: readonly Exclude<AnticKind, "nap">[] = [
  "sit",
  "wave",
  "look",
  "dance",
  "yawn",
];

export type FxKind =
  | "heart"
  | "bang"
  | "question"
  | "zzz"
  | "drop"
  | "puff"
  | "hand";

export type StunKind = "bonk" | "hard" | "dizzy";

export type PlayEvent =
  | { type: "fx"; kind: FxKind }
  | { type: "land"; along: number; stun: StunKind | null };

export type PlayWorld = {
  /** The track, in viewport pixels. */
  left: number;
  width: number;
  /** Feet height of a sprite standing on the ledge, in viewport pixels. */
  ledgeY: number;
  viewW: number;
  viewH: number;
  /** The chevron, in viewport pixels. */
  obstacle: { left: number; right: number } | null;
  busy: boolean;
  stunning: boolean;
};

export type Flight = {
  x: number;
  feet: number;
  vx: number;
  vy: number;
  impact: number;
  bounced: boolean;
  bonk: boolean;
};

type Sample = { t: number; x: number; y: number };

type Mode = "run" | "press" | "pet" | "held" | "flying" | "lowering" | "antic";

export type PlayState = {
  mode: Mode;
  reduced: boolean;
  random: () => number;
  busy: boolean;
  turnAt: number;
  x: number;
  feet: number;
  pressAt: number;
  pressX: number;
  pressY: number;
  pressMoved: boolean;
  grabDx: number;
  grabDy: number;
  samples: Sample[];
  clickAt: number;
  streak: number;
  hopAt: number;
  hopMs: number;
  hopPeak: number;
  flipAt: number;
  crossUntil: number;
  crossFlag: boolean;
  nextHeartAt: number;
  shakeDir: number;
  shakeAt: number;
  shakes: number;
  dizzy: boolean;
  flight: Flight;
  flightAt: number;
  landedAt: number;
  lowerAt: number;
  lowerX: number;
  lowerFeet: number;
  tilt: number;
  antic: AnticKind | null;
  anticAt: number;
  lastAntic: AnticKind | null;
  nextAnticAt: number;
  nextZAt: number;
  burpAt: number;
  cursorX: number;
  cursorY: number;
  cursorAt: number;
  looking: 1 | -1 | null;
  slow: boolean;
  paused: boolean;
  events: PlayEvent[];
};

export function nextAnticDelay(random: () => number): number {
  return ANTIC_GAP_MIN_MS + random() * (ANTIC_GAP_MAX_MS - ANTIC_GAP_MIN_MS);
}

export function createPlay(
  now: number,
  reduced: boolean,
  random: () => number = Math.random,
): PlayState {
  return {
    mode: "run",
    reduced,
    random,
    busy: true,
    turnAt: now,
    x: 0,
    feet: 0,
    pressAt: 0,
    pressX: 0,
    pressY: 0,
    pressMoved: false,
    grabDx: 0,
    grabDy: 0,
    samples: [],
    clickAt: -Infinity,
    streak: 0,
    hopAt: -Infinity,
    hopMs: HOP_MS,
    hopPeak: HOP_PEAK,
    flipAt: -Infinity,
    crossUntil: -Infinity,
    crossFlag: false,
    nextHeartAt: 0,
    shakeDir: 0,
    shakeAt: -Infinity,
    shakes: 0,
    dizzy: false,
    flight: {
      x: 0,
      feet: 0,
      vx: 0,
      vy: 0,
      impact: 0,
      bounced: false,
      bonk: false,
    },
    flightAt: 0,
    landedAt: -Infinity,
    lowerAt: 0,
    lowerX: 0,
    lowerFeet: 0,
    tilt: 0,
    antic: null,
    anticAt: 0,
    lastAntic: null,
    nextAnticAt: now + nextAnticDelay(random),
    nextZAt: 0,
    burpAt: Infinity,
    cursorX: -Infinity,
    cursorY: -Infinity,
    cursorAt: -Infinity,
    looking: null,
    slow: false,
    paused: false,
    events: [],
  };
}

function fx(state: PlayState, kind: FxKind): void {
  state.events.push({ type: "fx", kind });
}

function hop(state: PlayState, now: number, ms: number, peak: number): void {
  state.hopAt = now;
  state.hopMs = ms;
  state.hopPeak = peak;
}

function arcAt(elapsed: number, ms: number, peak: number): number {
  if (elapsed <= 0 || elapsed >= ms) return 0;
  const t = elapsed / ms;
  return 4 * t * (1 - t) * peak;
}

function quietAntics(state: PlayState, now: number): void {
  state.nextAnticAt = Math.max(state.nextAnticAt, now + AFTER_PLAY_QUIET_MS);
}

function endAntic(state: PlayState, now: number): void {
  state.antic = null;
  state.mode = "run";
  state.nextAnticAt = now + nextAnticDelay(state.random);
}

/** The pointer moved anywhere in the window. */
export function cursorMoved(
  state: PlayState,
  now: number,
  x: number,
  y: number,
): void {
  state.cursorX = x;
  state.cursorY = y;
  state.cursorAt = now;
  if (
    state.mode === "antic" &&
    state.antic === "nap" &&
    Math.hypot(x - state.x, y - (state.feet - RUNNER_SIZE / 2)) < NEAR_PX
  ) {
    endAntic(state, now);
    fx(state, "bang");
  }
}

export function pressDown(
  state: PlayState,
  now: number,
  x: number,
  y: number,
): void {
  if (!state.busy || state.mode === "lowering") return;
  if (state.mode === "antic") {
    const napping = state.antic === "nap";
    endAntic(state, now);
    if (napping) fx(state, "bang");
  }
  // Caught in mid-air: straight into the hand, or it would snap to the ledge.
  state.mode = state.mode === "flying" ? "held" : "press";
  state.pressAt = now;
  state.pressX = x;
  state.pressY = y;
  state.pressMoved = false;
  state.grabDx = state.x - x;
  state.grabDy = state.feet - y;
  state.samples = [{ t: now, x, y }];
  state.shakes = 0;
  state.shakeDir = 0;
  state.dizzy = false;
  quietAntics(state, now);
}

export function pressMove(
  state: PlayState,
  now: number,
  x: number,
  y: number,
): void {
  if (state.mode !== "press" && state.mode !== "pet" && state.mode !== "held") {
    return;
  }
  if (
    state.mode !== "held" &&
    Math.hypot(x - state.pressX, y - state.pressY) >= DRAG_PX
  ) {
    state.pressMoved = true;
    // Reduced motion: no picking it up, so the press just lapses.
    if (!state.reduced) state.mode = "held";
  }
  if (state.mode !== "held") return;

  const last = state.samples[state.samples.length - 1];
  if (last) {
    const dx = x - last.x;
    if (Math.abs(dx) >= SHAKE_PX) {
      const dir = dx > 0 ? 1 : -1;
      if (state.shakeDir !== 0 && dir !== state.shakeDir) {
        state.shakes = now - state.shakeAt <= SHAKE_GAP_MS ? state.shakes + 1 : 1;
        state.shakeAt = now;
        if (state.shakes >= SHAKE_FLIPS && !state.dizzy) {
          state.dizzy = true;
          fx(state, "drop");
        }
      } else if (state.shakeDir === 0) {
        state.shakeAt = now;
      }
      state.shakeDir = dir;
    }
  }
  state.samples.push({ t: now, x, y });
  if (state.samples.length > 12) state.samples.shift();
  state.x = x + state.grabDx;
  state.feet = y + state.grabDy;
}

/** Pointer speed at release: the last moment of the drag, or zero if it paused. */
export function releaseVelocity(
  samples: readonly Sample[],
  now: number,
): { vx: number; vy: number } {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > THROW_STALE_MS) return { vx: 0, vy: 0 };
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > THROW_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0 };
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < THROW_MIN_PX) return { vx: 0, vy: 0 };
  const scale = speed > THROW_MAX_PX ? THROW_MAX_PX / speed : 1;
  return { vx: vx * scale, vy: vy * scale };
}

function startFlight(state: PlayState, now: number): void {
  const { vx, vy } = releaseVelocity(state.samples, now);
  state.mode = "flying";
  state.flightAt = now;
  state.flight = {
    x: state.x,
    feet: state.feet,
    vx,
    vy,
    impact: 0,
    bounced: false,
    bonk: false,
  };
}

function click(state: PlayState, now: number): void {
  state.streak = now - state.clickAt <= CLICK_GAP_MS ? state.streak + 1 : 1;
  state.clickAt = now;
  if (state.streak >= CROSS_CLICKS) {
    state.crossUntil = now + CROSS_MS;
    state.crossFlag = true;
    state.flipAt = -Infinity;
    fx(state, "bang");
    if (!state.reduced) hop(state, now, HOP_MS, HOP_PEAK);
  } else if (state.streak === 2 && !state.reduced) {
    state.hopAt = -Infinity;
    state.flipAt = now;
  } else {
    fx(state, "bang");
    if (!state.reduced) hop(state, now, HOP_MS, HOP_PEAK);
  }
}

export function pressUp(state: PlayState, now: number): void {
  if (state.mode === "press") {
    state.mode = "run";
    if (!state.pressMoved) click(state, now);
  } else if (state.mode === "pet") {
    state.mode = "run";
    if (!state.reduced) hop(state, now, HOP_MS, HOP_PEAK);
  } else if (state.mode === "held") {
    startFlight(state, now);
  }
}

/** The pointer was taken away mid-press: drop it rather than leave it hanging. */
export function pressCancel(state: PlayState, now: number): void {
  if (state.mode === "held") {
    state.samples = [];
    startFlight(state, now);
  } else if (state.mode === "press" || state.mode === "pet") {
    state.mode = "run";
  }
}

/** One step of flight. Walls and the ceiling bounce it; the ledge catches it. */
export function stepFlight(
  flight: Flight,
  dtMs: number,
  world: PlayWorld,
): "flying" | "landed" {
  const dt = dtMs / 1000;
  const prevFeet = flight.feet;
  flight.vy += GRAVITY_PX * dt;
  flight.x += flight.vx * dt;
  flight.feet += flight.vy * dt;

  const half = RUNNER_SIZE / 2;
  if (flight.x < half) {
    flight.x = half;
    flight.vx = Math.abs(flight.vx) * WALL_BOUNCE;
  } else if (flight.x > world.viewW - half) {
    flight.x = world.viewW - half;
    flight.vx = -Math.abs(flight.vx) * WALL_BOUNCE;
  }
  if (flight.feet < RUNNER_SIZE) {
    flight.feet = RUNNER_SIZE;
    flight.vy = Math.abs(flight.vy) * WALL_BOUNCE;
  }

  const onTrack =
    flight.x >= world.left + RUNNER_INSET &&
    flight.x <= world.left + world.width - RUNNER_INSET;
  if (
    flight.vy > 0 &&
    prevFeet <= world.ledgeY &&
    flight.feet >= world.ledgeY &&
    onTrack
  ) {
    flight.impact = Math.max(flight.impact, flight.vy);
    if (
      world.obstacle &&
      flight.x + half >= world.obstacle.left &&
      flight.x - half <= world.obstacle.right
    ) {
      flight.bonk = true;
    }
    flight.feet = world.ledgeY;
    if (!flight.bounced && flight.vy >= SETTLE_BOUNCE_PX) {
      flight.bounced = true;
      flight.vy = -flight.vy * SETTLE_BOUNCE;
      return "flying";
    }
    return "landed";
  }

  if (flight.feet >= world.viewH) {
    // Missed the ledge and hit the window's floor: bounce up onto the track.
    flight.impact = Math.max(flight.impact, flight.vy);
    flight.feet = world.viewH;
    const lift = Math.max(flight.feet - world.ledgeY, 0) + RELAUNCH_APEX;
    flight.vy = -Math.sqrt(2 * GRAVITY_PX * lift);
    const up = -flight.vy / GRAVITY_PX;
    const down = Math.sqrt((2 * RELAUNCH_APEX) / GRAVITY_PX);
    const target = Math.min(
      world.left + world.width - RUNNER_INSET,
      Math.max(world.left + RUNNER_INSET, flight.x),
    );
    flight.vx = (target - flight.x) / (up + down);
  }
  return "flying";
}

function clampToWorld(world: PlayWorld, along: number): number {
  const track = Math.max(0, world.width - RUNNER_INSET * 2);
  return Math.min(track, Math.max(0, along));
}

function land(state: PlayState, now: number, world: PlayWorld): void {
  const flight = state.flight;
  state.x = flight.x;
  state.feet = world.ledgeY;
  state.mode = "run";
  state.landedAt = now;
  const stun: StunKind | null = state.dizzy
    ? "dizzy"
    : flight.bonk
      ? "bonk"
      : flight.impact >= HARD_LANDING_PX
        ? "hard"
        : null;
  state.dizzy = false;
  state.events.push({
    type: "land",
    along: clampToWorld(world, flight.x - world.left - RUNNER_INSET),
    stun,
  });
}

function pickAntic(state: PlayState, now: number): AnticKind {
  if (
    state.lastAntic !== "nap" &&
    now - state.turnAt >= NAP_AFTER_MS &&
    state.random() < NAP_CHANCE
  ) {
    return "nap";
  }
  const options = DAY_ANTICS.filter((kind) => kind !== state.lastAntic);
  return options[Math.floor(state.random() * options.length)] ?? "sit";
}

function startAntic(state: PlayState, now: number): void {
  const kind = pickAntic(state, now);
  state.mode = "antic";
  state.antic = kind;
  state.anticAt = now;
  state.lastAntic = kind;
  state.nextZAt = now + 300;
  if (kind === "wave") fx(state, "hand");
  if (kind === "look") fx(state, "question");
}

function anticFacing(
  state: PlayState,
  now: number,
  facing: 1 | -1,
): 1 | -1 {
  const elapsed = now - state.anticAt;
  if (state.antic === "look") {
    return Math.floor(elapsed / 700) % 2 === 0 ? facing : (-facing as 1 | -1);
  }
  if (state.antic === "dance") {
    return Math.floor(elapsed / 240) % 2 === 0 ? 1 : -1;
  }
  return facing;
}

function watchCursor(
  state: PlayState,
  now: number,
  ledge: RunnerPose,
  world: PlayWorld,
): void {
  state.looking = null;
  state.slow = false;
  state.paused = false;
  const age = now - state.cursorAt;
  if (age > CURSOR_PAUSE_FRESH_MS || now < state.crossUntil) return;

  const dx = state.cursorX - state.x;
  const headY = state.feet - RUNNER_SIZE / 2;
  const onSprite =
    Math.abs(dx) <= RUNNER_SIZE / 2 + HIT_PAD &&
    state.cursorY >= state.feet - RUNNER_SIZE - HIT_PAD &&
    state.cursorY <= state.feet;
  if (onSprite && ledge.y <= 0.5) {
    state.paused = true;
    state.looking = dx >= 0 ? 1 : -1;
    return;
  }

  const ahead = dx * ledge.facing;
  if (
    age <= CURSOR_JUMP_FRESH_MS &&
    Math.abs(state.cursorY - world.ledgeY) <= CURSOR_HOP_BAND &&
    ahead > CURSOR_HOP_MIN &&
    ahead < CURSOR_HOP_MAX
  ) {
    if (now - state.hopAt >= state.hopMs && ledge.y <= 0.5) {
      hop(state, now, CURSOR_HOP_MS, CURSOR_HOP_PEAK);
    }
    return;
  }
  if (
    age <= CURSOR_LOOK_FRESH_MS &&
    Math.hypot(dx, state.cursorY - headY) < NEAR_PX
  ) {
    state.looking = dx >= 0 ? 1 : -1;
    state.slow = true;
  }
}

/** The pose this frame, in the runner's box coordinates. */
export function stepPlay(
  state: PlayState,
  now: number,
  dtMs: number,
  ledge: RunnerPose,
  world: PlayWorld,
): RunnerPose {
  if (world.busy && !state.busy) {
    state.turnAt = now;
    state.nextAnticAt = now + nextAnticDelay(state.random);
  }
  state.busy = world.busy;

  if (now >= state.burpAt) {
    state.burpAt = Infinity;
    if (world.busy) fx(state, "puff");
  }
  if (state.crossFlag && now >= state.crossUntil) {
    state.crossFlag = false;
    fx(state, "drop");
  }

  if (!world.busy) {
    if (state.mode === "press" || state.mode === "pet") state.mode = "run";
    if (state.mode === "antic") endAntic(state, now);
    if (state.mode === "held") {
      state.mode = "lowering";
      state.lowerAt = now;
      state.lowerX = state.x;
      state.lowerFeet = state.feet;
    }
  }

  if (
    state.mode === "press" &&
    !state.pressMoved &&
    now - state.pressAt >= LONG_PRESS_MS
  ) {
    state.mode = "pet";
    state.nextHeartAt = now;
  }
  if (state.mode === "pet" && now >= state.nextHeartAt) {
    state.nextHeartAt = now + HEART_EVERY_MS;
    fx(state, "heart");
  }

  if (state.mode === "held") {
    const last = state.samples[state.samples.length - 1];
    const prev = state.samples[state.samples.length - 2];
    const rate =
      last && prev && last.t > prev.t && now - last.t < 120
        ? (last.x - prev.x) / (last.t - prev.t)
        : 0;
    state.tilt = Math.max(-30, Math.min(30, Math.round(-rate * 8) * 15));
    state.x = Math.min(
      world.viewW - RUNNER_SIZE / 2,
      Math.max(RUNNER_SIZE / 2, state.x),
    );
    state.feet = Math.min(world.viewH, Math.max(RUNNER_SIZE, state.feet));
  } else if (state.mode === "flying") {
    const result =
      now - state.flightAt >= FLIGHT_MAX_MS
        ? forceLanding(state.flight, world)
        : stepFlight(state.flight, dtMs, world);
    state.x = state.flight.x;
    state.feet = state.flight.feet;
    if (result === "landed") {
      land(state, now, world);
      return landedPose(state, ledge, world);
    }
  } else if (state.mode === "lowering") {
    const t = Math.min(1, (now - state.lowerAt) / LOWER_MS);
    const eased = 1 - (1 - t) * (1 - t);
    const targetX = Math.min(
      world.left + world.width - RUNNER_INSET,
      Math.max(world.left + RUNNER_INSET, state.lowerX),
    );
    state.x = state.lowerX + (targetX - state.lowerX) * eased;
    state.feet = state.lowerFeet + (world.ledgeY - state.lowerFeet) * eased;
    if (t >= 1) {
      state.flight = {
        x: targetX,
        feet: world.ledgeY,
        vx: 0,
        vy: 0,
        impact: 0,
        bounced: true,
        bonk: false,
      };
      state.dizzy = false;
      land(state, now, world);
      return landedPose(state, ledge, world);
    }
  } else if (state.mode === "antic") {
    const kind = state.antic;
    if (kind === "nap") {
      if (now >= state.nextZAt) {
        state.nextZAt = now + NAP_Z_EVERY_MS;
        fx(state, "zzz");
      }
    } else if (kind && now - state.anticAt >= ANTIC_MS[kind]) {
      endAntic(state, now);
    }
  }

  if (state.mode === "held" || state.mode === "flying" || state.mode === "lowering") {
    state.looking = null;
    state.slow = false;
    state.paused = false;
    const y = world.ledgeY - state.feet;
    return {
      x: state.x - world.left,
      y,
      facing: ledge.facing,
      airborne: y > 0.5,
    };
  }

  if (
    state.mode === "run" &&
    !state.reduced &&
    world.busy &&
    !world.stunning &&
    now >= state.nextAnticAt &&
    now >= state.crossUntil &&
    ledge.y <= 0.5
  ) {
    startAntic(state, now);
  }

  if (state.mode === "run" && world.busy) {
    watchCursor(state, now, ledge, world);
  } else {
    state.looking = null;
    state.slow = false;
    state.paused = false;
  }

  let y = ledge.y;
  const hopY = state.reduced ? 0 : arcAt(now - state.hopAt, state.hopMs, state.hopPeak);
  const flipY = state.reduced ? 0 : arcAt(now - state.flipAt, FLIP_MS, FLIP_PEAK);
  y = Math.max(y, hopY, flipY);
  // Coming down inside a jump arc: ease into it instead of snapping up.
  const sinceLanding = now - state.landedAt;
  if (sinceLanding < LAND_EASE_MS) y *= sinceLanding / LAND_EASE_MS;

  state.x = world.left + ledge.x;
  state.feet = world.ledgeY - y;
  const facing =
    state.mode === "antic"
      ? anticFacing(state, now, ledge.facing)
      : (state.looking ?? ledge.facing);
  return { x: ledge.x, y, facing, airborne: y > 0.5 };
}

/** The ledge pose is still at the old spot until the runner takes the landing. */
function landedPose(
  state: PlayState,
  ledge: RunnerPose,
  world: PlayWorld,
): RunnerPose {
  return { x: state.x - world.left, y: 0, facing: ledge.facing, airborne: false };
}

function forceLanding(flight: Flight, world: PlayWorld): "landed" {
  flight.x = Math.min(
    world.left + world.width - RUNNER_INSET,
    Math.max(world.left + RUNNER_INSET, flight.x),
  );
  flight.feet = world.ledgeY;
  flight.vx = 0;
  flight.vy = 0;
  return "landed";
}

/** How fast the runner may walk now, as a share of its usual speed. */
export function playSpeed(state: PlayState, now: number): number {
  if (state.mode !== "run" || state.paused) return 0;
  if (now < state.crossUntil) return CROSS_SPEED;
  return state.slow ? LOOK_SPEED : 1;
}

/** Off the ledge, so nothing on the ledge applies to it. */
export function offLedge(state: PlayState): boolean {
  return (
    state.mode === "held" ||
    state.mode === "flying" ||
    state.mode === "lowering"
  );
}

/** Now and then a coin goes down the hatch. True when this one was eaten. */
export function coinTaken(state: PlayState, now: number): boolean {
  if (state.reduced || state.random() >= EAT_CHANCE) return false;
  state.burpAt = now + BURP_AFTER_MS;
  return true;
}

export type PlayLook = {
  spin: number;
  scaleX: number;
  scaleY: number;
  dy: number;
  origin: "bottom" | "center" | "top";
  /** Hold one mascot frame instead of cycling. */
  still: "rest" | "talk" | null;
  eyesClosed: boolean;
  kicking: boolean;
  cross: boolean;
};

function stepped(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** How the body looks this frame: rotated in 45° steps, like an arcade sprite. */
export function playLook(state: PlayState, now: number): PlayLook {
  const look: PlayLook = {
    spin: 0,
    scaleX: 1,
    scaleY: 1,
    dy: 0,
    origin: "bottom",
    still: null,
    eyesClosed: false,
    kicking: false,
    cross: now < state.crossUntil,
  };
  if (state.reduced) {
    look.eyesClosed = state.mode === "pet";
    return look;
  }

  if (state.mode === "held" || state.mode === "lowering") {
    look.origin = "top";
    look.spin = state.mode === "held" ? state.tilt : 0;
    look.kicking = true;
    return look;
  }
  if (state.mode === "flying") {
    const moving = Math.hypot(state.flight.vx, state.flight.vy) >= THROW_MIN_PX;
    if (moving) {
      const dir = state.flight.vx < 0 ? -1 : 1;
      look.spin = stepped(((now - state.flightAt) / 70) * 45 * dir, 45);
      look.origin = "center";
    }
    look.kicking = true;
    return look;
  }
  if (state.mode === "pet") {
    look.eyesClosed = true;
    look.still = "rest";
    return look;
  }
  if (state.mode === "antic") {
    const elapsed = now - state.anticAt;
    if (state.antic === "sit" || state.antic === "nap") {
      look.scaleY = 0.75;
      look.still = "rest";
      look.eyesClosed = state.antic === "nap";
    } else if (state.antic === "yawn") {
      const t = Math.min(1, elapsed / ANTIC_MS.yawn);
      look.scaleY = 1 + stepped(Math.sin(t * Math.PI) * 0.25, 0.125);
      look.still = "talk";
      look.eyesClosed = t > 0.2 && t < 0.8;
    } else if (state.antic === "dance") {
      look.dy = Math.floor(elapsed / 120) % 2 === 0 ? 0 : -2;
    } else if (state.antic === "wave") {
      look.still = "rest";
    } else if (state.antic === "look") {
      look.still = "rest";
    }
    return look;
  }

  const flipElapsed = now - state.flipAt;
  if (flipElapsed >= 0 && flipElapsed < FLIP_MS) {
    look.spin = stepped((flipElapsed / FLIP_MS) * -360, 45);
    look.origin = "center";
    return look;
  }
  if (now - state.landedAt < LAND_SQUASH_MS) {
    look.scaleY = 0.75;
    look.scaleX = 1.125;
    return look;
  }
  if (state.burpAt !== Infinity && state.burpAt - now < BURP_AFTER_MS) {
    look.scaleY = 0.875;
    look.scaleX = 1.125;
  }
  return look;
}

/** Cells that are holes in the face: filled, they read as closed eyes. */
export function eyeRows(rows: readonly string[]): string[] {
  const blank = "........";
  const out = rows.map(() => blank);
  for (let r = 1; r < Math.min(rows.length - 1, 5); r++) {
    const row = rows[r] ?? "";
    let cells = "";
    let found = false;
    for (let c = 0; c < row.length; c++) {
      const hole =
        row[c] === "." &&
        row.slice(0, c).includes("#") &&
        row.slice(c + 1).includes("#") &&
        rows[r - 1]?.[c] === "#";
      cells += hole ? "#" : ".";
      found ||= hole;
    }
    if (found) {
      out[r] = cells;
      break;
    }
  }
  return out;
}

export function eyesPath(rows: readonly string[]): string {
  return mascotPath(eyeRows(rows));
}

/** Two little feet below the body, swapped on a loop to kick. */
export const KICK_A_PATH = mascotPath([
  "........",
  "........",
  "..#..#..",
  "..#.....",
  "........",
  "........",
  "........",
  "........",
]);

export const KICK_B_PATH = mascotPath([
  "........",
  "........",
  "..#..#..",
  ".....#..",
  "........",
  "........",
  "........",
  "........",
]);

const FX_ROWS: Record<FxKind, readonly string[]> = {
  heart: [
    "........",
    ".##..##.",
    "########",
    "########",
    ".######.",
    "..####..",
    "...##...",
    "........",
  ],
  bang: [
    "...##...",
    "...##...",
    "...##...",
    "...##...",
    "...##...",
    "........",
    "...##...",
    "...##...",
  ],
  question: [
    "..####..",
    ".##..##.",
    ".....##.",
    "....##..",
    "...##...",
    "........",
    "...##...",
    "...##...",
  ],
  zzz: [
    "........",
    ".######.",
    ".....##.",
    "....##..",
    "...##...",
    "..##....",
    ".######.",
    "........",
  ],
  drop: [
    "...##...",
    "...##...",
    "..####..",
    ".######.",
    ".######.",
    ".######.",
    "..####..",
    "........",
  ],
  puff: [
    "........",
    "..###...",
    ".#...#..",
    ".#...###",
    ".#...#.#",
    "..###..#",
    ".....##.",
    "........",
  ],
  hand: [
    "........",
    "#..#..#.",
    "#..#..#.",
    "#######.",
    "#######.",
    ".#####..",
    "..###...",
    "........",
  ],
};

export const FX_PATHS: Record<FxKind, string> = {
  heart: mascotPath(FX_ROWS.heart),
  bang: mascotPath(FX_ROWS.bang),
  question: mascotPath(FX_ROWS.question),
  zzz: mascotPath(FX_ROWS.zzz),
  drop: mascotPath(FX_ROWS.drop),
  puff: mascotPath(FX_ROWS.puff),
  hand: mascotPath(FX_ROWS.hand),
};

export const FX_COLORS: Record<FxKind, string> = {
  heart: "#ff5a6e",
  bang: "#f4e27a",
  question: "#f4e27a",
  zzz: "#9db7ff",
  drop: "#6ec6ff",
  puff: "#b9ae92",
  hand: "currentColor",
};

export const FX_LIFE_MS: Record<FxKind, number> = {
  heart: 900,
  bang: 480,
  question: 1000,
  zzz: 1400,
  drop: 620,
  puff: 620,
  hand: ANTIC_MS.wave,
};

/** Effects that stay with the sprite as it moves; the rest stay where they began. */
export function fxFollows(kind: FxKind): boolean {
  return kind === "bang" || kind === "question" || kind === "hand";
}

/** Where an effect sits at this age, from the top centre of the sprite. */
export function fxPose(
  kind: FxKind,
  ageMs: number,
  reduced: boolean,
): { dx: number; dy: number; opacity: number } | null {
  const life = FX_LIFE_MS[kind];
  if (ageMs < 0 || ageMs >= life) return null;
  const t = ageMs / life;
  const fade = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
  if (reduced) return { dx: 0, dy: -8, opacity: fade };
  switch (kind) {
    case "heart":
      return {
        dx: stepped(Math.sin(t * Math.PI * 3) * 4, 2),
        dy: -stepped(4 + t * 26, 2),
        opacity: fade,
      };
    case "bang":
      return { dx: 0, dy: -stepped(4 + Math.min(1, t * 4) * 8, 2), opacity: fade };
    case "question":
      return { dx: 0, dy: -10, opacity: fade };
    case "zzz":
      return {
        dx: stepped(4 + t * 12, 2),
        dy: -stepped(2 + t * 22, 2),
        opacity: fade,
      };
    case "drop":
      return { dx: 8, dy: stepped(-6 + t * 14, 2), opacity: fade };
    case "puff":
      return { dx: 6, dy: -stepped(2 + t * 14, 2), opacity: fade };
    case "hand":
      return {
        dx: 12,
        dy: Math.floor(ageMs / 180) % 2 === 0 ? 0 : -2,
        opacity: 1,
      };
  }
}
