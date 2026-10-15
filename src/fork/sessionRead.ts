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

const reads = new Map<
  string,
  { updatedAt: number; done: number | null; promise: Promise<SessionRecord> }
>();

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
  const entry = {
    updatedAt,
    done: null as number | null,
    promise: invoke<SessionRecord>("session_get", { sessionId }),
  };
  reads.set(sessionId, entry);
  entry.promise.then(
    () => {
      entry.done = Date.now();
    },
    () => {
      // A failed read is not reused: the next ask tries again.
      if (reads.get(sessionId) === entry) {
        reads.delete(sessionId);
      }
    },
  );
  return entry.promise;
}
