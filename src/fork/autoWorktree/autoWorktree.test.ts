// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoPickReason,
  checkoutDirty,
  coachSeen,
  decideAutoWorktree,
  loadAutoWorktreePolicy,
  markCoachSeen,
  noteAutoPick,
  noteUserWorkspaceChoice,
  otherSessionBusy,
  publishBusySessions,
  renamedWorktreeBranch,
  resetAutoWorktreeForTests,
  saveAutoWorktreePolicy,
  sessionWorktreeBranchName,
  subscribeBusySessions,
  userChoseWorkspace,
} from "./autoWorktree";

beforeEach(() => {
  localStorage.clear();
  resetAutoWorktreeForTests();
});

describe("decideAutoWorktree", () => {
  it("never makes one under never, whatever else is going on", () => {
    expect(
      decideAutoWorktree({ policy: "never", otherSessionBusy: true, dirty: true }),
    ).toBeNull();
  });

  it("always makes one under always, even on a quiet clean checkout", () => {
    expect(
      decideAutoWorktree({ policy: "always", otherSessionBusy: false, dirty: false }),
    ).toBe("always");
  });

  it("smart makes one when another session is busy", () => {
    expect(
      decideAutoWorktree({ policy: "smart", otherSessionBusy: true, dirty: false }),
    ).toBe("busy");
  });

  it("smart makes one when the tree has uncommitted changes", () => {
    expect(
      decideAutoWorktree({ policy: "smart", otherSessionBusy: false, dirty: true }),
    ).toBe("dirty");
  });

  it("smart stays put on a quiet clean checkout, or before the check answers", () => {
    expect(
      decideAutoWorktree({ policy: "smart", otherSessionBusy: false, dirty: false }),
    ).toBeNull();
    expect(
      decideAutoWorktree({ policy: "smart", otherSessionBusy: false, dirty: null }),
    ).toBeNull();
  });
});

describe("policy", () => {
  it("defaults to smart and remembers a choice", () => {
    expect(loadAutoWorktreePolicy()).toBe("smart");
    saveAutoWorktreePolicy("never");
    expect(loadAutoWorktreePolicy()).toBe("never");
  });

  it("treats an unknown saved value as smart", () => {
    localStorage.setItem("monocode.fork.autoWorktree", "sometimes");
    expect(loadAutoWorktreePolicy()).toBe("smart");
  });
});

describe("branch naming", () => {
  it("names the branch from the request with a short id", () => {
    expect(sessionWorktreeBranchName("Fix the login page!", "A1b2C3d4-e5")).toBe(
      "mc/fix-the-login-page-a1b2c3",
    );
  });

  it("drops accents and keeps the slug short, with no trailing dash", () => {
    const name = sessionWorktreeBranchName(
      `Café ${"word ".repeat(30)}`,
      "abcdef123",
    );
    expect(name.startsWith("mc/cafe-word")).toBe(true);
    expect(name.endsWith("-abcdef")).toBe(true);
    expect(name).not.toContain("--");
    expect(name.length).toBeLessThanOrEqual(3 + 40 + 7);
  });

  it("falls back to the temporary name when nothing is usable", () => {
    expect(sessionWorktreeBranchName("日本語", "abcdef123")).toBe("mc/abcdef12");
    expect(sessionWorktreeBranchName("", "abcdef123")).toBe("mc/abcdef12");
  });

  it("keeps the short id across a rename, once", () => {
    expect(renamedWorktreeBranch("mc/login-fix", "mc/fix-the-login-a1b2c3")).toBe(
      "mc/login-fix-a1b2c3",
    );
    expect(
      renamedWorktreeBranch("mc/login-fix-a1b2c3", "mc/fix-the-login-a1b2c3"),
    ).toBe("mc/login-fix-a1b2c3");
    expect(renamedWorktreeBranch("mc/login-fix", "mc/abcd")).toBe("mc/login-fix");
    expect(renamedWorktreeBranch("mc/login-fix", null)).toBe("mc/login-fix");
  });
});

describe("checkoutDirty", () => {
  const trees = [
    { path: "/repo", dirty: false },
    { path: "/repo/nested-tree", dirty: true },
  ];

  it("uses the closest checkout that holds the path", () => {
    expect(checkoutDirty("/repo", trees)).toBe(false);
    expect(checkoutDirty("/repo/src", trees)).toBe(false);
    expect(checkoutDirty("/repo/nested-tree/src", trees)).toBe(true);
  });

  it("is unknown outside every checkout", () => {
    expect(checkoutDirty("/other", trees)).toBeNull();
  });
});

describe("busy sessions", () => {
  it("counts only other sessions in the same project", () => {
    publishBusySessions([
      { id: "a", cwd: "/repo", busy: true },
      { id: "b", cwd: "/elsewhere", busy: true },
      { id: "c", cwd: "/repo", busy: false },
    ]);
    expect(otherSessionBusy("a", "/repo")).toBe(false);
    expect(otherSessionBusy("c", "/repo")).toBe(true);
    expect(otherSessionBusy("c", "/quiet")).toBe(false);
  });

  it("only tells listeners about real changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBusySessions(listener);
    const sessions = [{ id: "a", cwd: "/repo", busy: true }];
    publishBusySessions(sessions);
    publishBusySessions(sessions);
    expect(listener).toHaveBeenCalledTimes(1);
    publishBusySessions([]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("draft choices", () => {
  it("a person's choice beats the auto pick, per project", () => {
    noteAutoPick("s", "/repo", "busy");
    expect(autoPickReason("s", "/repo")).toBe("busy");
    noteUserWorkspaceChoice("s", "/repo");
    expect(autoPickReason("s", "/repo")).toBeNull();
    expect(userChoseWorkspace("s", "/repo")).toBe(true);
    expect(userChoseWorkspace("s", "/other")).toBe(false);
  });

  it("shows the coach card only until it is dismissed", () => {
    expect(coachSeen()).toBe(false);
    markCoachSeen();
    expect(coachSeen()).toBe(true);
  });
});
