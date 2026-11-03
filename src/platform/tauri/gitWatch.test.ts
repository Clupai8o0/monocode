// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke, listen, workspace, unlisten, invalidateGitReads } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  workspace: vi.fn(),
  unlisten: vi.fn(),
  invalidateGitReads: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./fs", () => ({
  invalidateGitReads,
  invokeWorkspace: workspace,
  REMOTE_PATH_PREFIX: "remote://",
}));
import { resetGitWatches, watchGitChanges } from "./gitWatch";

let event: (event: { payload: { id: string; failed: boolean } }) => void;
const stops: Array<() => void> = [];
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function subscribe(cwd: string, callback = vi.fn()) {
  const stop = watchGitChanges(cwd, callback);
  stops.push(stop);
  return { callback, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset().mockResolvedValue(undefined);
  workspace.mockReset();
  unlisten.mockReset();
  listen.mockReset().mockImplementation(async (_name, callback) => {
    event = callback;
    return unlisten;
  });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await flush();
  vi.useRealTimers();
});

it("shares a native subscription, stays idle, and scopes events to its watcher", async () => {
  const a = subscribe("/repo");
  const b = subscribe("/repo");
  await flush();
  expect(
    invoke.mock.calls.filter(([command]) => command === "watch_git_changes"),
  ).toHaveLength(1);
  expect(a.callback).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls.filter(([command]) => command === "reset_git_watches")).toHaveLength(1);
  expect(invoke.mock.calls.findIndex(([command]) => command === "reset_git_watches"))
    .toBeLessThan(invoke.mock.calls.findIndex(([command]) => command === "watch_git_changes"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(a.callback).toHaveBeenCalledTimes(1);
  const id = invoke.mock.calls.find(([command]) => command === "watch_git_changes")![1].id;
  event({ payload: { id: "other", failed: false } });
  expect(a.callback).toHaveBeenCalledTimes(1);
  event({ payload: { id, failed: false } });
  expect(a.callback).toHaveBeenCalledTimes(2);
  expect(b.callback).toHaveBeenCalledTimes(2);
  a.stop();
  expect(unlisten).not.toHaveBeenCalled();
  b.stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("unwatch_git_changes", { id });
});

it("releases a watcher that finishes starting after the panel closes", async () => {
  let finish!: () => void;
  invoke.mockImplementation((command) =>
    command === "watch_git_changes"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  const subscription = subscribe("/late");
  await flush();
  subscription.stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
  finish();
  await flush();
  expect(invoke).toHaveBeenLastCalledWith(
    "unwatch_git_changes",
    expect.any(Object),
  );
  expect(subscription.callback).not.toHaveBeenCalled();
});

it("falls back only when native notifications fail and clears that timer", async () => {
  invoke.mockImplementation(command => command === "watch_git_changes"
    ? Promise.reject(new Error("Filesystem does not support notifications"))
    : Promise.resolve());
  const subscription = subscribe("/unsupported");
  await flush();
  expect(subscription.callback).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(subscription.callback).toHaveBeenCalledTimes(2);
  subscription.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(subscription.callback).toHaveBeenCalledTimes(2);
});

it("switches to fallback after a running native watcher reports an error", async () => {
  const subscription = subscribe("/failure");
  await flush();
  const id = invoke.mock.calls.find(([command]) => command === "watch_git_changes")![1].id;
  event({ payload: { id, failed: true } });
  expect(unlisten).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(subscription.callback).toHaveBeenCalledTimes(3);
});

it("waits for remote filesystem events without refreshing on idle connection renewal", async () => {
  let finishWait!: (changed: boolean) => void;
  workspace.mockImplementation((command) =>
    command === "wait_git_changes"
      ? new Promise<boolean>((resolve) => {
          finishWait = resolve;
        })
      : Promise.resolve(),
  );
  const subscription = subscribe("remote://machine/repo");
  await flush();
  expect(listen).not.toHaveBeenCalled();
  expect(subscription.callback).toHaveBeenCalledTimes(1);
  finishWait(false);
  await flush();
  expect(subscription.callback).toHaveBeenCalledTimes(1);
  finishWait(true);
  await flush();
  expect(subscription.callback).toHaveBeenCalledTimes(2);
  subscription.stop();
  expect(workspace).toHaveBeenLastCalledWith(
    "unwatch_git_changes",
    expect.objectContaining({ cwd: "remote://machine/repo" }),
  );
  finishWait(false);
  await flush();
  expect(subscription.callback).toHaveBeenCalledTimes(2);
});

it("shares startup reset and invalidates a checkout before notifying its listeners", async () => {
  await resetGitWatches();
  const callsBefore = invoke.mock.calls.filter(([command]) => command === "reset_git_watches").length;
  const callback = vi.fn(() => expect(invalidateGitReads).toHaveBeenLastCalledWith("/reset-repo"));
  subscribe("/reset-repo", callback);
  await flush();
  expect(callback).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls.filter(([command]) => command === "reset_git_watches")).toHaveLength(callsBefore);
});
