import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockResolvedValue({ blocks: [] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("shares an in-flight read and a recently completed read between badges", async () => {
  const { readSession } = await import("./sessionRead");
  const first = readSession("s1", 1);
  expect(readSession("s1", 1)).toBe(first);
  await first;
  expect(readSession("s1", 1)).toBe(first);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("releases a completed transcript after ten seconds without another read", async () => {
  const { readSession } = await import("./sessionRead");
  const now = Date.now();
  await readSession("s1", 1);
  await vi.advanceTimersByTimeAsync(10_000);
  // Turning the wall clock back distinguishes actual eviction from a stale
  // timestamp check that leaves the full transcript retained indefinitely.
  vi.setSystemTime(now);
  await readSession("s1", 1);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("bounds retained transcripts when a long sidebar loads many sessions", async () => {
  const { readSession } = await import("./sessionRead");
  for (let i = 0; i < 80; i += 1) {
    await readSession(`s${i}`, 1);
  }
  await readSession("s0", 1);
  expect(invoke).toHaveBeenCalledTimes(81);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(32);
});

it("keeps sharing pending reads even when many sessions load together", async () => {
  const pending: Array<(value: null) => void> = [];
  invoke.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const { readSession } = await import("./sessionRead");
  const reads = Array.from({ length: 80 }, (_, i) => readSession(`s${i}`, 1));
  expect(readSession("s0", 1)).toBe(reads[0]);
  expect(invoke).toHaveBeenCalledTimes(80);
  pending.forEach((finish) => finish(null));
  await Promise.all(reads);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(32);
});

it("does not let an old version's completion evict a newer read", async () => {
  let finishOld!: (value: null) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const { readSession } = await import("./sessionRead");
  const old = readSession("s1", 1);
  const next = readSession("s1", 2);
  await next;
  finishOld(null);
  await old;
  expect(readSession("s1", 2)).toBe(next);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});

it("retries failed reads instead of retaining the rejected promise", async () => {
  invoke.mockRejectedValueOnce(new Error("read failed"));
  const { readSession } = await import("./sessionRead");
  await expect(readSession("s1", 1)).rejects.toThrow("read failed");
  await readSession("s1", 1);
  expect(invoke).toHaveBeenCalledTimes(2);
});
