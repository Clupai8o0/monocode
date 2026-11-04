import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listSessionsByProject = vi.fn();
vi.mock("../../features/sessions/data/sessionStore", () => ({
  listSessionsByProject,
}));

const {
  SCAN_GAP_MS,
  cachedCleanupRows,
  forgetCleanupRows,
  requestCleanupScan,
  resetCleanupRows,
  restoreCleanupRows,
} = await import("./cleanupRows");

const row = (id: string) => ({ id }) as never;

/** Lets a running scan's awaits finish without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  resetCleanupRows();
  listSessionsByProject.mockReset();
  listSessionsByProject.mockImplementation(async (cwd: string) => [row(`${cwd}#1`)]);
});

afterEach(() => {
  vi.useRealTimers();
});

it("reads every project and keeps the rows", async () => {
  requestCleanupScan(["/a", "/b"]);
  await settle();
  expect(cachedCleanupRows(["/a", "/b"]).map((r) => r.id)).toEqual(["/a#1", "/b#1"]);
  expect(cachedCleanupRows(["/b"]).map((r) => r.id)).toEqual(["/b#1"]);
});

it("keeps the old rows when a project stops reading", async () => {
  requestCleanupScan(["/a"]);
  await settle();
  listSessionsByProject.mockRejectedValue(new Error("no"));
  requestCleanupScan(["/a"], { now: true });
  await settle();
  expect(cachedCleanupRows(["/a"]).map((r) => r.id)).toEqual(["/a#1"]);
});

it("waits out the gap, and a burst of asks costs one scan", async () => {
  requestCleanupScan(["/a"]);
  await settle();
  listSessionsByProject.mockClear();
  requestCleanupScan(["/a"]);
  requestCleanupScan(["/a"]);
  requestCleanupScan(["/a"]);
  await settle();
  expect(listSessionsByProject).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(SCAN_GAP_MS);
  expect(listSessionsByProject).toHaveBeenCalledTimes(1);
});

it("an ask for now skips the gap", async () => {
  requestCleanupScan(["/a"]);
  await settle();
  listSessionsByProject.mockClear();
  requestCleanupScan(["/a"], { now: true });
  await settle();
  expect(listSessionsByProject).toHaveBeenCalledTimes(1);
});

it("an ask during a scan runs after it, and stays urgent", async () => {
  let finish = () => {};
  listSessionsByProject.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([row("first")]);
      }),
  );
  requestCleanupScan(["/a"]);
  await settle();
  requestCleanupScan(["/a"], { now: true });
  requestCleanupScan(["/a"]);
  expect(listSessionsByProject).toHaveBeenCalledTimes(1);
  finish();
  await settle();
  expect(listSessionsByProject).toHaveBeenCalledTimes(2);
  expect(cachedCleanupRows(["/a"]).map((r) => r.id)).toEqual(["/a#1"]);
});

it("forgets removed sessions straight away", async () => {
  requestCleanupScan(["/a", "/b"]);
  await settle();
  forgetCleanupRows(["/a#1"]);
  expect(cachedCleanupRows(["/a", "/b"]).map((r) => r.id)).toEqual(["/b#1"]);
});

it("a read that began before a removal does not bring the session back", async () => {
  requestCleanupScan(["/a"]);
  await settle();
  let finish = () => {};
  listSessionsByProject.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([row("/a#1")]);
      }),
  );
  requestCleanupScan(["/a"], { now: true });
  await settle();
  forgetCleanupRows(["/a#1"]);
  finish();
  await settle();
  expect(cachedCleanupRows(["/a"])).toEqual([]);
});

it("puts a restored session back, once", async () => {
  requestCleanupScan(["/a"]);
  await settle();
  const restored = { id: "/a#1", cwd: "/a" } as never;
  forgetCleanupRows(["/a#1"]);
  restoreCleanupRows([restored]);
  restoreCleanupRows([restored]);
  expect(cachedCleanupRows(["/a"]).map((r) => r.id)).toEqual(["/a#1"]);
});
