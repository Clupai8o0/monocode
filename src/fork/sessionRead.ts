import { invoke } from "@tauri-apps/api/core";
import type { Block } from "../features/sessions/model/session";

/**
 * Fork: one `session_get` per session save, shared by the card badges (close
 * state, messages) that each read the saved transcript. A direct row read:
 * getSession may write repairs.
 */

export type SessionRecord = {
  blocks?: Block[];
  title?: string;
  cwd?: string;
} | null;

/** How long a finished read is reused by a badge asking a moment later. */
const KEEP_MS = 10_000;
/** A sidebar can visit hundreds of sessions; don't retain all their blocks. */
const MAX_COMPLETED_READS = 32;

type Read = {
  updatedAt: number;
  done: number | null;
  promise: Promise<SessionRecord>;
  timer?: ReturnType<typeof setTimeout>;
};

const reads = new Map<string, Read>();

function remove(sessionId: string, entry: Read): void {
  if (entry.timer !== undefined) {
    clearTimeout(entry.timer);
  }
  if (reads.get(sessionId) === entry) {
    reads.delete(sessionId);
  }
}

function trim(): void {
  const completed = [...reads].filter(([, entry]) => entry.done !== null);
  for (const [sessionId, entry] of completed.slice(
    0,
    Math.max(0, completed.length - MAX_COMPLETED_READS),
  )) {
    remove(sessionId, entry);
  }
}

export function readSession(
  sessionId: string,
  updatedAt: number,
): Promise<SessionRecord> {
  const hit = reads.get(sessionId);
  if (
    hit &&
    hit.updatedAt === updatedAt &&
    (hit.done === null || Date.now() - hit.done < KEEP_MS)
  ) {
    return hit.promise;
  }
  if (hit) {
    remove(sessionId, hit);
  }
  const entry: Read = {
    updatedAt,
    done: null,
    promise: invoke<SessionRecord>("session_get", { sessionId }),
  };
  reads.set(sessionId, entry);
  entry.promise.then(
    () => {
      if (reads.get(sessionId) !== entry) {
        return;
      }
      entry.done = Date.now();
      // Expire without waiting for another read: resolved promises retain the
      // complete transcript even when all its sidebar badges have unmounted.
      entry.timer = setTimeout(() => remove(sessionId, entry), KEEP_MS);
      trim();
    },
    () => {
      // A failed read is not reused: the next ask tries again.
      remove(sessionId, entry);
    },
  );
  return entry.promise;
}
