import type {
  Obstacle,
  RunnerPose,
  RunnerTrack,
} from "../../features/sessions/model/composerRunner";
import { RUNNER_SIZE } from "../../features/sessions/model/composerRunner";
import {
  DIZZY_STUNS,
  FX_COLORS,
  FX_PATHS,
  HIT_PAD,
  KICK_A_PATH,
  KICK_B_PATH,
  coinTaken as coinTakenModel,
  createPlay,
  cursorMoved,
  eyesPath,
  fxFollows,
  fxPose,
  offLedge,
  playLook,
  playSpeed,
  pressCancel,
  pressDown,
  pressMove,
  pressUp,
  stepPlay,
  type FxKind,
  type StunKind,
} from "./runnerPlay";
import "./runnerPlay.css";

export const FORK_RUNNER_PLAY = import.meta.env.MODE !== "test";

/** The sprite may leave its box while playing; the sink clip is then off. */
export const PLAY_NO_CLIP_PX = -24;
const FX_SIZE = 8;

type LiveFx = {
  kind: FxKind;
  el: HTMLDivElement;
  born: number;
  x: number;
  y: number;
};

export type RunnerPlay = {
  speed: (now: number) => number;
  /** Still in the air or in hand, so the exit waits for it. */
  settling: () => boolean;
  offLedge: () => boolean;
  frame: (
    now: number,
    dt: number,
    pose: RunnerPose,
    track: RunnerTrack,
    obstacle: Obstacle | null,
    busy: boolean,
    stunning: boolean,
  ) => RunnerPose;
  takeLanding: () => { along: number; stun: StunKind | null } | null;
  /** Another round of stars after a shake. */
  staysDizzy: () => boolean;
  coinTaken: (now: number) => boolean;
  placeHit: (left: number, top: number) => void;
  /** The exit has begun, or the runner is hidden: nothing to touch. */
  stop: (now: number) => void;
  destroy: () => void;
};

/** Plays nothing, for tests and when the flag is off. */
export const INERT_RUNNER_PLAY: RunnerPlay = {
  speed: () => 1,
  settling: () => false,
  offLedge: () => false,
  frame: (_now, _dt, pose) => pose,
  takeLanding: () => null,
  staysDizzy: () => false,
  coinTaken: () => false,
  placeHit: () => {},
  stop: () => {},
  destroy: () => {},
};

function svg(path: string, fill: string, className = ""): string {
  return `<svg viewBox="0 0 8 8" width="${FX_SIZE}" height="${FX_SIZE}" shape-rendering="crispEdges" fill="${fill}" aria-hidden="true"><path class="${className}" d="${path}"/></svg>`;
}

export function createRunnerPlay({
  layer,
  body,
  reduced,
  mascotRows,
  color,
}: {
  layer: HTMLElement;
  body: HTMLElement;
  reduced: boolean;
  mascotRows: () => readonly string[];
  color: () => string | undefined;
}): RunnerPlay {
  const state = createPlay(performance.now(), reduced);
  const live: LiveFx[] = [];
  let landing: { along: number; stun: StunKind | null } | null = null;
  let dizzyLeft = 0;
  let spriteLeft = -64;
  let spriteTop = -64;
  let lastClass = "";
  let lastTransform = "";
  let lastOrigin = "";
  let lastFlags = "";
  let eyesFor: readonly string[] | null = null;
  // From a listener: reading these every frame can flush layout in WebKit.
  let viewW = window.innerWidth;
  let viewH = window.innerHeight;

  const fxLayer = document.createElement("div");
  fxLayer.className = "absolute inset-0";
  layer.append(fxLayer);

  // Its own element, not a child of the sprite: the sprite's clip path would
  // clip what it can be touched by too. It stops at the feet so the composer
  // underneath keeps every click.
  const hit = document.createElement("div");
  hit.dataset.runnerHit = "";
  hit.className = "absolute top-0 left-0";
  hit.style.width = `${RUNNER_SIZE + HIT_PAD * 2}px`;
  hit.style.height = `${RUNNER_SIZE + HIT_PAD}px`;
  hit.style.pointerEvents = "auto";
  hit.style.touchAction = "none";
  hit.style.cursor = "grab";
  hit.style.transform = "translate3d(-64px, -64px, 0)";
  layer.append(hit);

  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.setAttribute("viewBox", "0 0 8 8");
  overlay.setAttribute("shape-rendering", "crispEdges");
  overlay.setAttribute("aria-hidden", "true");
  overlay.setAttribute("fill", "currentColor");
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.width = "16px";
  overlay.style.height = "16px";
  overlay.style.overflow = "visible";
  overlay.style.pointerEvents = "none";
  const eyes = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const kickA = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const kickB = document.createElementNS("http://www.w3.org/2000/svg", "path");
  kickA.setAttribute("class", "runner-kick-a");
  kickB.setAttribute("class", "runner-kick-b");
  kickA.setAttribute("d", KICK_A_PATH);
  kickB.setAttribute("d", KICK_B_PATH);
  // Below the 8×8 body, on the same grid.
  kickA.setAttribute("transform", "translate(0 5)");
  kickB.setAttribute("transform", "translate(0 5)");
  overlay.append(eyes, kickA, kickB);
  body.append(overlay);

  const spawn = (kind: FxKind, now: number) => {
    const el = document.createElement("div");
    el.className = "absolute top-0 left-0";
    el.dataset.runnerFx = kind;
    el.style.width = `${FX_SIZE}px`;
    el.style.height = `${FX_SIZE}px`;
    el.style.filter = "drop-shadow(0 1px 0 rgba(0,0,0,0.45))";
    el.style.opacity = "0";
    if (kind === "hand") el.style.color = color() ?? "currentColor";
    el.innerHTML = svg(FX_PATHS[kind], FX_COLORS[kind]);
    fxLayer.append(el);
    live.push({
      kind,
      el,
      born: now,
      x: spriteLeft + RUNNER_SIZE / 2 - FX_SIZE / 2,
      y: spriteTop,
    });
  };

  const drawFx = (now: number) => {
    for (const item of [...live]) {
      const pose = fxPose(item.kind, now - item.born, reduced);
      if (!pose) {
        item.el.remove();
        live.splice(live.indexOf(item), 1);
        continue;
      }
      if (fxFollows(item.kind)) {
        item.x = spriteLeft + RUNNER_SIZE / 2 - FX_SIZE / 2;
        item.y = spriteTop;
      }
      item.el.style.transform = `translate3d(${Math.round(item.x + pose.dx)}px, ${Math.round(item.y + pose.dy)}px, 0)`;
      item.el.style.opacity = String(pose.opacity);
    }
  };

  const drawBody = (now: number) => {
    const look = playLook(state, now);
    const classes = [
      look.still ? `runner-still-${look.still}` : "",
      look.cross ? "runner-cross" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (classes !== lastClass) {
      body.className = classes;
      lastClass = classes;
    }
    const transform = `translateY(${look.dy}px) rotate(${look.spin}deg) scale(${look.scaleX}, ${look.scaleY})`;
    if (transform !== lastTransform) {
      body.style.transform = transform;
      lastTransform = transform;
    }
    const origin =
      look.origin === "center"
        ? "50% 50%"
        : look.origin === "top"
          ? "50% 0%"
          : "50% 100%";
    if (origin !== lastOrigin) {
      body.style.transformOrigin = origin;
      lastOrigin = origin;
    }
    const rows = mascotRows();
    if (rows !== eyesFor) {
      eyes.setAttribute("d", eyesPath(rows));
      eyesFor = rows;
    }
    const held = state.mode === "held";
    const paint = color() ?? "";
    const flags = `${look.eyesClosed}|${look.kicking}|${held}|${paint}`;
    if (flags !== lastFlags) {
      eyes.style.display = look.eyesClosed ? "" : "none";
      kickA.style.display = look.kicking ? "" : "none";
      kickB.style.display = look.kicking ? "" : "none";
      overlay.style.color = paint;
      hit.style.cursor = held ? "grabbing" : "grab";
      lastFlags = flags;
    }
  };

  const drain = (now: number) => {
    for (const event of state.events) {
      if (event.type === "fx") {
        spawn(event.kind, now);
      } else {
        landing = { along: event.along, stun: event.stun };
        dizzyLeft = event.stun === "dizzy" ? DIZZY_STUNS : 0;
      }
    }
    state.events.length = 0;
  };

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    hit.setPointerCapture(event.pointerId);
    pressDown(state, performance.now(), event.clientX, event.clientY);
  };
  const onMove = (event: PointerEvent) => {
    pressMove(state, performance.now(), event.clientX, event.clientY);
  };
  const onUp = () => pressUp(state, performance.now());
  const onCancel = () => pressCancel(state, performance.now());
  // Keep the caret in the composer when the blob is grabbed.
  const onMouseDown = (event: MouseEvent) => event.preventDefault();
  const onCursor = (event: PointerEvent) => {
    cursorMoved(state, performance.now(), event.clientX, event.clientY);
  };

  hit.addEventListener("pointerdown", onDown);
  hit.addEventListener("pointermove", onMove);
  hit.addEventListener("pointerup", onUp);
  hit.addEventListener("pointercancel", onCancel);
  hit.addEventListener("lostpointercapture", onCancel);
  hit.addEventListener("mousedown", onMouseDown);
  window.addEventListener("pointermove", onCursor, { passive: true });
  const onResize = () => {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
  };
  window.addEventListener("resize", onResize);

  return {
    speed: (now) => playSpeed(state, now),
    settling: () => offLedge(state),
    offLedge: () => offLedge(state),
    frame: (now, dt, pose, track, obstacle, busy, stunning) => {
      hit.style.display = "";
      const result = stepPlay(state, now, dt, pose, {
        left: track.left,
        width: track.width,
        ledgeY: track.top + 1,
        viewW,
        viewH,
        obstacle: obstacle
          ? {
              left: track.left + obstacle.left,
              right: track.left + obstacle.right,
            }
          : null,
        busy,
        stunning,
      });
      drain(now);
      drawBody(now);
      drawFx(now);
      return result;
    },
    takeLanding: () => {
      const taken = landing;
      landing = null;
      return taken;
    },
    staysDizzy: () => {
      if (dizzyLeft <= 0) return false;
      dizzyLeft--;
      return true;
    },
    coinTaken: (now) => coinTakenModel(state, now),
    placeHit: (left, top) => {
      spriteLeft = left;
      spriteTop = top;
      hit.style.transform = `translate3d(${left - HIT_PAD}px, ${top - HIT_PAD}px, 0)`;
    },
    stop: (now) => {
      hit.style.display = "none";
      pressCancel(state, now);
      state.mode = "run";
      state.antic = null;
      state.events.length = 0;
      landing = null;
      dizzyLeft = 0;
      drawBody(now);
      drawFx(now);
    },
    destroy: () => {
      window.removeEventListener("pointermove", onCursor);
      window.removeEventListener("resize", onResize);
      hit.remove();
      fxLayer.remove();
      overlay.remove();
    },
  };
}
