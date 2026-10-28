import { expect, it } from "vitest";
import { nextSyncDelay, SYNC_WAIT_MS, syncWaitMs } from "./remoteSync";

const base = { failed: 0, active: false, visible: true, waited: false, elapsedMs: 400 };

it("long-polls only a visible session whose last sync worked", () => {
  expect(syncWaitMs(true, true)).toBe(SYNC_WAIT_MS);
  expect(syncWaitMs(false, true)).toBeUndefined();
  expect(syncWaitMs(true, false)).toBeUndefined();
});

it("polls again at once after the host held the request", () => {
  expect(nextSyncDelay({ ...base, waited: true, elapsedMs: 20_400 })).toBe(200);
  expect(nextSyncDelay({ ...base, waited: true, active: true, elapsedMs: 3_000 })).toBe(200);
});

it("keeps the old delays when an older host answered at once", () => {
  expect(nextSyncDelay({ ...base, waited: true })).toBe(3_000);
  expect(nextSyncDelay({ ...base, waited: true, active: true })).toBe(750);
  expect(nextSyncDelay({ ...base, visible: false })).toBe(10_000);
  // A slow round trip without a hold is not mistaken for one.
  expect(nextSyncDelay({ ...base, elapsedMs: 5_000 })).toBe(3_000);
});

it("backs off after failures, held or not", () => {
  expect(nextSyncDelay({ ...base, failed: 1, waited: true, elapsedMs: 30_000 })).toBe(1_500);
  expect(nextSyncDelay({ ...base, failed: 9 })).toBe(10_000);
});
