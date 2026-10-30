import { describe, expect, it } from "vitest";
import type { Block } from "../../features/sessions/model/session";
import {
  cachedTurnChanges,
  rememberTurnChanges,
  restoreSummary,
  turnChipLabel,
  withCheckpointTurn,
} from "./turnDiff";

const block = (over: Partial<Block>): Block =>
  ({ id: "x", role: "user", text: "", ...over }) as Block;

describe("withCheckpointTurn", () => {
  it("marks the latest sent message, not a reply or a draft", () => {
    const blocks = [
      block({ id: "u1" }),
      block({ id: "u2" }),
      block({ id: "d", draft: true }),
      block({ id: "a", role: "assistant" }),
    ];
    const next = withCheckpointTurn(blocks, "t1");
    expect(next[1].checkpointTurnId).toBe("t1");
    expect(next[0].checkpointTurnId).toBeUndefined();
    expect(next[2].checkpointTurnId).toBeUndefined();
  });

  it("returns the same array when there is nothing to change", () => {
    const marked = [block({ checkpointTurnId: "t1" })];
    expect(withCheckpointTurn(marked, "t1")).toBe(marked);
    const none = [block({ role: "assistant" })];
    expect(withCheckpointTurn(none, "t1")).toBe(none);
  });
});

describe("turnChipLabel", () => {
  const file = { relative: "a", status: "modified", additions: 1, deletions: 0 };

  it("reads like a sentence, singular and plural", () => {
    expect(
      turnChipLabel({ files: [file], additions: 1, deletions: 0 }),
    ).toBe("1 file +1 -0");
    expect(
      turnChipLabel({ files: [file, file, file], additions: 42, deletions: 7 }),
    ).toBe("3 files +42 -7");
  });

  it("has no chip for a turn that changed nothing", () => {
    expect(turnChipLabel({ files: [], additions: 0, deletions: 0 })).toBeNull();
  });
});

describe("restoreSummary", () => {
  const file = (editedSince: boolean) => ({
    relative: "a",
    action: "restore" as const,
    editedSince,
  });

  it("counts files edited since", () => {
    const summary = restoreSummary({
      files: [file(true), file(false)],
      blocked: null,
      headMoved: false,
    });
    expect(summary).toEqual({
      total: 2,
      edited: 1,
      canRestore: true,
      nothingToDo: false,
    });
  });

  it("refuses when blocked, and says when it's already restored", () => {
    expect(
      restoreSummary({ files: [file(false)], blocked: "busy", headMoved: false })
        .canRestore,
    ).toBe(false);
    expect(
      restoreSummary({ files: [], blocked: null, headMoved: false }).nothingToDo,
    ).toBe(true);
  });
});

describe("the cache", () => {
  it("keeps a bounded number of turns, dropping the oldest", () => {
    const changes = { files: [], additions: 0, deletions: 0 };
    for (let index = 0; index < 205; index++) {
      rememberTurnChanges(`t${index}`, changes);
    }
    expect(cachedTurnChanges("t0")).toBeUndefined();
    expect(cachedTurnChanges("t204")).toBe(changes);
  });
});
