import { describe, expect, it } from "vitest";
import { mergeView, mergeWorthShowing, type MergeStatus } from "./mergeBack";

const status = (over: Partial<MergeStatus> = {}): MergeStatus => ({
  branch: "mc/login-a1b2c3",
  base: "mine",
  baseCheckout: "/repo",
  baseBusy: false,
  ahead: 2,
  behind: 0,
  additions: 42,
  deletions: 7,
  files: 3,
  uncommitted: 0,
  conflicts: [],
  ...over,
});

describe("mergeView", () => {
  it("fast-forwards when the base has not moved", () => {
    const view = mergeView(status());
    expect(view.kind).toBe("fast-forward");
    expect(view.canMerge).toBe(true);
    expect(view.title).toBe("Ready to bring 2 commits into mine");
  });

  it("merges when both sides moved without overlap", () => {
    const view = mergeView(status({ behind: 1 }));
    expect(view.kind).toBe("merge");
    expect(view.canMerge).toBe(true);
    expect(view.detail).toContain("1 commit since");
  });

  it("blocks on conflicts and hands them to the agent by name", () => {
    const view = mergeView(status({ behind: 1, conflicts: ["a.ts", "b.ts"] }));
    expect(view.kind).toBe("conflict");
    expect(view.canMerge).toBe(false);
    expect(view.title).toBe("2 files changed on both sides");
    expect(view.agentPrompt).toContain("a.ts, b.ts");
    expect(view.agentLabel).toBe("Ask the agent to fix");
  });

  it("uncommitted work comes first, since it would be left behind", () => {
    const view = mergeView(status({ uncommitted: 1, conflicts: ["a.ts"] }));
    expect(view.kind).toBe("uncommitted");
    expect(view.canMerge).toBe(false);
    expect(view.title).toBe("1 file not committed yet");
    expect(view.agentLabel).toBe("Ask the agent to commit");
  });

  it("has nothing to do when no commits are ahead", () => {
    const view = mergeView(status({ ahead: 0, behind: 3 }));
    expect(view.kind).toBe("nothing");
    expect(view.canMerge).toBe(false);
  });

  it("waits when the base checkout is mid-merge", () => {
    const view = mergeView(status({ baseBusy: true }));
    expect(view.kind).toBe("base-busy");
    expect(view.canMerge).toBe(false);
    expect(view.agentPrompt).toBeNull();
  });

  it("reports the finished merge over anything else", () => {
    const view = mergeView(status({ ahead: 0 }), true);
    expect(view.kind).toBe("merged");
    expect(view.title).toBe("Merged into mine");
  });
});

describe("mergeWorthShowing", () => {
  it("offers Merge back only when there is work", () => {
    expect(mergeWorthShowing(null)).toBe(false);
    expect(mergeWorthShowing(status({ ahead: 0 }))).toBe(false);
    expect(mergeWorthShowing(status())).toBe(true);
    expect(mergeWorthShowing(status({ ahead: 0, uncommitted: 2 }))).toBe(true);
  });
});
