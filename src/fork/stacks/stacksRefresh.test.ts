// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const snapshot = { stacks: [], devices: [], loose: [] };

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  invoke.mockResolvedValue(snapshot);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("queues one forced refresh behind a pending cached read", async () => {
  const first = deferred();
  invoke.mockReturnValueOnce(first.promise);
  const { refreshStacks } = await import("./StacksButton");
  const poll = refreshStacks();
  const manual = refreshStacks(true);
  expect(refreshStacks(true)).toBe(manual);
  expect(invoke).toHaveBeenCalledTimes(1);
  first.resolve(snapshot);
  await Promise.all([poll, manual]);
  expect(invoke.mock.calls).toEqual([
    ["fork_stacks_list", { force: false }],
    ["fork_stacks_list", { force: true }],
  ]);
});

it("shares an already forced refresh without adding another helper read", async () => {
  const first = deferred();
  invoke.mockReturnValueOnce(first.promise);
  const { refreshStacks } = await import("./StacksButton");
  const manual = refreshStacks(true);
  expect(refreshStacks(true)).toBe(manual);
  expect(refreshStacks()).toBe(manual);
  first.resolve(snapshot);
  await manual;
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("runs the queued refresh even when the active read fails", async () => {
  const first = deferred();
  invoke.mockReturnValueOnce(first.promise);
  const { refreshStacks } = await import("./StacksButton");
  const poll = refreshStacks();
  const manual = refreshStacks(true);
  first.reject(new Error("read failed"));
  await Promise.all([poll, manual]);
  expect(invoke).toHaveBeenLastCalledWith("fork_stacks_list", { force: true });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("keeps the manual refresh promise pending until the fresh read completes", async () => {
  const first = deferred();
  const second = deferred();
  invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { refreshStacks } = await import("./StacksButton");
  const poll = refreshStacks();
  const manual = refreshStacks(true);
  let finished = false;
  void manual.then(() => {
    finished = true;
  });
  first.resolve(snapshot);
  await poll;
  await Promise.resolve();
  expect(finished).toBe(false);
  second.resolve(snapshot);
  await manual;
  expect(finished).toBe(true);
});

it("does not restart polling when a queued refresh finishes after unmount", async () => {
  vi.stubEnv("MODE", "development");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const first = deferred();
  invoke.mockReturnValueOnce(first.promise);
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { refreshStacks, StacksButton } = await import("./StacksButton");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(StacksButton)));
  expect(vi.getTimerCount()).toBe(1);
  const manual = refreshStacks(true);
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  first.resolve(snapshot);
  await manual;
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(container.childElementCount).toBe(0);
});
