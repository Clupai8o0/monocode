import { invoke } from "@tauri-apps/api/core";
import type { Block } from "../../features/sessions/model/session";

/** Fork: what one reply changed, from the snapshots either side of its turn. */
export type TurnFile = {
  relative: string;
  status: string;
  additions: number;
  deletions: number;
};

export type TurnChanges = {
  files: TurnFile[];
  additions: number;
  deletions: number;
};

export type TurnFileDiff = {
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
};

export type RestoreFile = {
  relative: string;
  action: "restore" | "remove";
  editedSince: boolean;
};

export type RestorePreview = {
  files: RestoreFile[];
  blocked: string | null;
  headMoved: boolean;
};

export const loadTurnChanges = (sessionId: string, turnId: string) =>
  invoke<TurnChanges>("fork_turn_changes", { sessionId, turnId });

export const loadTurnFileDiff = (
  sessionId: string,
  turnId: string,
  relative: string,
) => invoke<TurnFileDiff>("fork_turn_file_diff", { sessionId, turnId, relative });

export const loadRestorePreview = (sessionId: string, turnId: string) =>
  invoke<RestorePreview>("fork_turn_restore_preview", { sessionId, turnId });

export const restoreTurn = (sessionId: string, turnId: string) =>
  invoke<RestorePreview>("fork_turn_restore", { sessionId, turnId });

/** Marks the latest sent message with its turn's checkpoint. */
export function withCheckpointTurn(blocks: Block[], turnId: string): Block[] {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role !== "user" || block.draft) continue;
    if (block.checkpointTurnId === turnId) return blocks;
    const next = [...blocks];
    next[index] = { ...block, checkpointTurnId: turnId };
    return next;
  }
  return blocks;
}

/** "3 files +42 -7", or null when the turn changed nothing. */
export function turnChipLabel(changes: TurnChanges): string | null {
  const count = changes.files.length;
  if (count === 0) return null;
  return `${count} ${count === 1 ? "file" : "files"} +${changes.additions} -${changes.deletions}`;
}

/** Separates the files a person should look at closely before restoring. */
export function restoreSummary(preview: RestorePreview) {
  const edited = preview.files.filter((file) => file.editedSince);
  return {
    total: preview.files.length,
    edited: edited.length,
    canRestore: !preview.blocked && preview.files.length > 0,
    nothingToDo: !preview.blocked && preview.files.length === 0,
  };
}

// One turn's changes never change once recorded, so a chip needs one read.
const cache = new Map<string, TurnChanges>();
const MAX_CACHED = 200;

export function cachedTurnChanges(turnId: string): TurnChanges | undefined {
  return cache.get(turnId);
}

export function rememberTurnChanges(turnId: string, changes: TurnChanges) {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(turnId, changes);
}
