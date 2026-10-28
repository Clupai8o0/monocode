/** How long a host may hold `sessions.sync` while nothing changed. Hosts
 * that predate the param ignore it and answer at once. */
export const SYNC_WAIT_MS = 20_000;
/** The desktop's request timeout for a held sync: above the hold, so a
 * quiet session is never cut off as a failure. */
export const SYNC_WAIT_TIMEOUT_MS = 35_000;
/** A sync slower than this was held by the host, not just a round trip. */
const HELD_AFTER_MS = 2_000;
/** Floor between held syncs, so a host that answers held requests early
 * cannot spin the loop. */
const HELD_REPOLL_MS = 200;

/** Ask the host to hold the sync only while the session is on screen and the
 * link is known to work; a failing link keeps today's short requests. */
export const syncWaitMs = (visible: boolean, lastSyncOk: boolean) =>
  visible && lastSyncOk ? SYNC_WAIT_MS : undefined;

/** The pause before the next sync. A held sync already waited on the host,
 * so the next one goes at once; everything else keeps the old delays, which
 * is also exactly how an older host that ignores the hold behaves. */
export function nextSyncDelay({
  failed,
  active,
  visible,
  waited,
  elapsedMs,
}: {
  failed: number;
  active: boolean;
  visible: boolean;
  /** Whether the request asked the host to hold it. */
  waited: boolean;
  elapsedMs: number;
}): number {
  if (failed) return Math.min(10_000, 750 * 2 ** Math.min(failed, 4));
  if (waited && elapsedMs > HELD_AFTER_MS) return HELD_REPOLL_MS;
  return active ? 750 : visible ? 3_000 : 10_000;
}
