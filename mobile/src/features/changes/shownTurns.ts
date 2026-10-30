import type { ChangedFile } from "@/features/workspace/types";

export type TurnChanges = {
  files: ChangedFile[];
  additions: number;
  deletions: number;
};

// A route's params can't carry whole diffs, as in shownDiffs.
const turns = new Map<string, TurnChanges>();
let next = 0;

export function keepTurn(changes: TurnChanges): string {
  const id = String(++next);
  turns.set(id, changes);
  for (const old of turns.keys()) {
    if (turns.size <= 4) break;
    turns.delete(old);
  }
  return id;
}

export function shownTurn(id: string): TurnChanges | undefined {
  return turns.get(id);
}
