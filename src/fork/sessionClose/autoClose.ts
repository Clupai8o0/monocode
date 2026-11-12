import type { Block } from "../../features/sessions/model/session";

/**
 * Fork feature: a session whose last reply says "Safe to close" closes on its
 * own (it is archived, so it stays restorable) once that reply has been on
 * screen for a little while. "Keep open" stops it for that reply.
 */

/** Seconds the close offer must be in view before the session closes. */
export const AUTO_CLOSE_AFTER_S = 20;

/**
 * The reply a close offer belongs to: the session plus its last block. A new
 * message or reply gives a new key, so "Keep open" lasts for one reply only.
 */
export function autoCloseKey(
  sessionId: string,
  blocks: readonly Pick<Block, "id">[],
): string {
  return `${sessionId}@${blocks[blocks.length - 1]?.id ?? ""}`;
}

// Replies the person chose to keep open this run.
const keptOpen = new Set<string>();

export function keepOpen(key: string) {
  keptOpen.add(key);
}

export function isKeptOpen(key: string): boolean {
  return keptOpen.has(key);
}

/** The person can see the offer: window focused and the offer on screen. */
export type Seen = { windowActive: boolean; inView: boolean };

/**
 * One second of the countdown. It only runs while the offer is seen, so a
 * reply in a background tab or scrolled away waits until it is read.
 */
export function tickCountdown(remaining: number, seen: Seen): number {
  if (!seen.windowActive || !seen.inView) {
    return remaining;
  }
  return Math.max(0, remaining - 1);
}
