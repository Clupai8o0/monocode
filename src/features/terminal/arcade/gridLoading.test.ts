// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GridGameHost } from "../ui/TerminalGridBackground";

const games = vi.hoisted(() => {
  const arcades = ["first", "second"].map(() => ({
    resize: vi.fn(), takeControl: vi.fn(), releaseControl: vi.fn(), setMode: vi.fn(),
    mode: () => "mid", controlled: () => true, score: () => 7, lives: () => 3,
    gameOver: () => false, step: vi.fn(), stamp: vi.fn(), fade: () => 0,
    sprites: () => [], logoPickup: () => null, speechBubble: () => null,
  }));
  const factories = arcades.map((arcade) => vi.fn(() => arcade));
  const loads = factories.map((create) => vi.fn(() => Promise.resolve(create)));
  return { arcades, factories, loads };
});
vi.mock("./gridGames", () => ({
  GRID_GAMES: games.factories.map((create, i) => ({
    id: i ? "second" : "first", label: "test", playLabel: "test", idleDim: 1,
    create, load: games.loads[i],
  })),
  SLIDE_HOLD_MS: 16_000,
  stepSlider: () => ({ index: 1, dir: 1 }),
}));
import { TerminalGridBackground } from "../ui/TerminalGridBackground";

let root: Root;
let container: HTMLDivElement;
let resize: () => void;
let width: number;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const host: GridGameHost = {
  gameId: "first", mode: "mid", runId: 0, paused: true, active: true,
  onStats: vi.fn(), onExit: vi.fn(), onFocusChange: vi.fn(), onInput: vi.fn(),
};

async function render(next = host)
{
  await act(async () => root.render(createElement(TerminalGridBackground, { host: next })));
}

async function frame(time = 1000)
{
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach((callback) => callback(time)));
}

beforeEach(() => {
  vi.clearAllMocks();
  games.loads.forEach((load, index) => load.mockImplementation(() => Promise.resolve(games.factories[index]!)));
  width = 600;
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    width, height: 400, top: 0, left: 0, right: width, bottom: 400, x: 0, y: 0,
    toJSON() {},
  }));
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    setTransform() {}, strokeRect() {}, clearRect() {}, fillRect() {}, drawImage() {},
  }) as never);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

it("only creates the shown board and retains it when parked", async () => {
  await render();
  await frame();
  await frame(1040);
  expect(games.factories[0]).toHaveBeenCalledTimes(1);
  expect(games.factories[1]).not.toHaveBeenCalled();
  expect(container.querySelectorAll("canvas")).toHaveLength(1);
  await render({ ...host, gameId: "second" });
  await frame(1100);
  await frame(1140);
  expect(games.factories[1]).toHaveBeenCalledTimes(1);
  await render();
  await frame(1200);
  expect(games.factories[0]).toHaveBeenCalledTimes(1);
  expect(games.arcades[0]!.releaseControl).not.toHaveBeenCalled();
  expect(games.arcades[0]!.takeControl).toHaveBeenCalledTimes(1);
});

it("does no board work while a table or hidden panel is shown", async () => {
  await render({ ...host, active: false });
  await frame();
  expect(games.factories[0]).not.toHaveBeenCalled();
  expect(container.querySelectorAll("canvas")).toHaveLength(0);
});

it("coalesces resize ticks and leaves the parked board untouched", async () => {
  await render();
  await frame();
  await frame(1040);
  await render({ ...host, gameId: "second" });
  await frame(1100);
  await frame(1140);
  vi.clearAllMocks();
  width = 700;
  resize();
  width = 710;
  resize();
  width = 720;
  resize();
  expect(games.arcades[1]!.resize).not.toHaveBeenCalled();
  await frame(1200);
  expect(games.arcades[0]!.resize).not.toHaveBeenCalled();
  expect(games.arcades[1]!.resize).toHaveBeenCalledTimes(1);
  expect(games.arcades[1]!.resize).toHaveBeenCalledWith(Math.ceil(720 / 7), Math.ceil(400 / 7));
});

it("does not create a board if the panel hides while its import is pending", async () => {
  let resolve!: (create: typeof games.factories[0]) => void;
  games.loads[0]!.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render();
  await frame();
  await render({ ...host, active: false });
  await act(async () => resolve(games.factories[0]));
  expect(games.factories[0]).not.toHaveBeenCalled();
  await render();
  await frame(1100);
  await frame(1140);
  expect(games.factories[0]).toHaveBeenCalledTimes(1);
});

it("starts a delayed board with the latest mode and resets only a new run", async () => {
  let resolve!: (create: typeof games.factories[0]) => void;
  games.loads[0]!.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render();
  await frame();
  await render({ ...host, mode: "hard", runId: 1 });
  await act(async () => resolve(games.factories[0]));
  await frame(1100);
  expect(games.arcades[0]!.setMode).toHaveBeenLastCalledWith("hard");
  expect(games.arcades[0]!.takeControl).toHaveBeenCalledTimes(1);
  await render({ ...host, mode: "hard", runId: 2 });
  expect(games.arcades[0]!.releaseControl).toHaveBeenCalledTimes(1);
  expect(games.arcades[0]!.takeControl).toHaveBeenCalledTimes(2);
});

it("keeps cell opacity within one alpha byte and reuses equal fill styles", async () => {
  const styles: string[] = [];
  const alphas: number[] = [];
  let style = "";
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => ({
    setTransform() {}, strokeRect() {}, clearRect() {}, drawImage() {},
    set fillStyle(value: string) { style = value; styles.push(value); },
    fillRect() { alphas.push(Number(style.match(/, ([\d.]+)\)$/)![1])); },
  }) as never);
  games.arcades[0]!.stamp.mockImplementation((out: Float32Array) => out.set([0.01, 0.3, 0.3, 0.5, 1]));
  await render();
  await frame();
  await frame(1040);
  expect(alphas).toHaveLength(4);
  expect(styles).toHaveLength(3);
  [0.3, 0.3, 0.5, 1].forEach((value, index) => {
    expect(Math.abs(alphas[index]! - value * 0.72) * 255).toBeLessThan(1);
  });
  games.arcades[0]!.stamp.mockReset();
});

it("loads the next idle slide on demand and can take control of it", async () => {
  await act(async () => root.render(createElement(TerminalGridBackground)));
  await frame();
  await frame(1040);
  expect(games.factories[0]).toHaveBeenCalledTimes(1);
  expect(games.factories[1]).not.toHaveBeenCalled();
  const dots = container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]");
  await act(async () => dots[1]!.click());
  await frame(1100);
  await frame(1140);
  expect(games.factories[1]).toHaveBeenCalledTimes(1);
  const takeControl = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("take control"))!;
  await act(async () => takeControl.click());
  await frame(1200);
  expect(games.arcades[1]!.takeControl).toHaveBeenCalled();
});

it("keeps elapsed game time accurate during resize", async () => {
  await render({ ...host, paused: false });
  await frame();
  await frame(1040);
  games.arcades[0]!.step.mockClear();
  width = 700;
  resize();
  await frame(1056);
  expect(games.arcades[0]!.step).toHaveBeenCalledWith(16);
});

it("clears the whole cached grid on a theme change below DPR 1", async () => {
  vi.stubGlobal("devicePixelRatio", 0.75);
  let color = "rgb(235, 238, 241)";
  vi.stubGlobal("getComputedStyle", () => ({ color, backgroundColor: "rgb(20, 22, 25)" }));
  const contexts: { scale: number; cleared: number }[] = [];
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => {
    const state = { scale: 1, cleared: 0 };
    contexts.push(state);
    return {
      setTransform(scale: number) { state.scale = scale; },
      clearRect(_x: number, _y: number, span: number) { state.cleared = span * state.scale; },
      strokeRect() {}, fillRect() {}, drawImage() {},
    } as never;
  });
  await render();
  await frame();
  await frame(1040);
  color = "rgb(10, 20, 30)";
  await act(async () => document.documentElement.classList.add("grid-test-theme"));
  await frame(1100);
  expect(contexts[1]!.cleared).toBeGreaterThanOrEqual(600 * 0.75);
  document.documentElement.classList.remove("grid-test-theme");
});

it("does not count hidden-tab time when a queued animation frame is suspended", async () => {
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  await render({ ...host, paused: false });
  await frame();
  await frame(1040);
  games.arcades[0]!.step.mockClear();
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await frame(10_000);
  expect(games.arcades[0]!.step).toHaveBeenCalledWith(33);
});
