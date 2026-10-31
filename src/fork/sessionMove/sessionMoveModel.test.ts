import { describe, expect, it } from "vitest";
import {
  journalFinished,
  labKey,
  leftBehindText,
  moveAvailability,
  movedTitle,
  openJournal,
  parseMoved,
  macAccountFor,
  withMoved,
  type MoveFacts,
  type MovedRecord,
} from "./sessionMoveModel";
import {
  isClientPath,
  manifestProblem,
  moveSlug,
  normalizeRemoteUrl,
  packPathOk,
} from "./sessionMoveProtocol";

const FACTS: MoveFacts = {
  harness: "claude",
  cwd: "/Users/me/Documents/projects/app",
  isMono: false,
  isOrchestration: false,
  hasConversation: true,
  needsInput: false,
  moved: false,
  moving: false,
  target: { online: true, known: true, capabilities: ["session.move.v1"], name: "Vivobook" },
};

describe("moveAvailability", () => {
  it("offers it to a Claude session with somewhere to go", () => {
    expect(moveAvailability(FACTS)).toEqual({ show: true });
    // A busy session is fine: the move waits for the turn to end.
  });

  it("hides it for good reasons", () => {
    for (const over of [
      { harness: "codex" },
      { harness: "vivobook" },
      { isMono: true },
      { isOrchestration: true },
      { worktreeRemoved: true },
      { moved: true },
      { cwd: "remote://machine/project" },
      { cwd: "/Users/me/Documents/projects/upwork/acme/app" },
    ]) {
      expect(moveAvailability({ ...FACTS, ...over })).toEqual({ show: false });
    }
  });

  it("keeps Panoptic", () => {
    expect(
      moveAvailability({ ...FACTS, cwd: "/Users/me/Documents/projects/upwork/panoptic/repo" }),
    ).toEqual({ show: true });
  });

  it("disables it with the reason when that can change", () => {
    const reason = (over: Partial<MoveFacts>) => moveAvailability({ ...FACTS, ...over });
    expect(reason({ moving: true })).toEqual({ show: true, disabled: "Already moving" });
    expect(reason({ hasConversation: false })).toEqual({ show: true, disabled: "Nothing to move yet" });
    expect(reason({ needsInput: true })).toEqual({ show: true, disabled: "It is waiting for your answer" });
    expect(reason({ target: { ...FACTS.target, online: false } })).toEqual({
      show: true,
      disabled: "Vivobook is offline",
    });
    expect(reason({ target: { ...FACTS.target, capabilities: ["lab.v1"] } })).toEqual({
      show: true,
      disabled: "Update Vivobook to move sessions",
    });
  });
});

describe("protocol checks", () => {
  it("treats client work as staying, whatever the case", () => {
    expect(isClientPath("/Users/x/Documents/projects/upwork/acme")).toBe(true);
    expect(isClientPath("/Users/x/Documents/projects/UPWORK/acme/.claude/worktrees/a")).toBe(true);
    expect(isClientPath("/Users/x/Documents/projects/upwork")).toBe(true);
    expect(isClientPath("/Users/x/Documents/projects/upwork/panoptic")).toBe(false);
    expect(isClientPath("/Users/x/Documents/projects/upwork/PANOPTIC/repo")).toBe(false);
    expect(isClientPath("/Users/x/Documents/projects/upwork/panoptic-two")).toBe(true);
    expect(isClientPath("/Users/x/Documents/projects/monocode")).toBe(false);
  });

  it("matches a repository however its address is written", () => {
    const want = "github.com/Me/app";
    for (const url of [
      "git@github.com:Me/app.git",
      "https://github.com/Me/app",
      "https://github.com/Me/app.git/",
      "ssh://git@github.com:22/Me/app.git",
      "https://token@GitHub.com/Me/app",
    ]) {
      expect(normalizeRemoteUrl(url)).toBe(want);
    }
    expect(normalizeRemoteUrl("git@github.com:Me/other.git")).not.toBe(want);
  });

  it("makes a safe name", () => {
    expect(moveSlug("monocode-16", "abc")).toBe("monocode-16");
    expect(moveSlug("Fix the login/redirect!", "abc")).toBe("Fix-the-login-redirect");
    expect(moveSlug("../..", "abcdef123456")).toBe("session-abcdef12");
    expect(moveSlug("a..b.lock", "x")).toBe("a.b");
    expect(moveSlug("-x", "x")).toBe("x");
    expect(moveSlug(undefined, "ab-cd")).toBe("session-abcd");
    expect(moveSlug("a".repeat(90), "x")).toHaveLength(48);
  });

  it("takes only this session's paths in a pack", () => {
    const id = "conv-1";
    for (const ok of [
      "commits.bundle",
      "changes.patch",
      "untracked/a/b c.txt",
      "convo/session/conv-1.jsonl",
      "convo/session/conv-1/subagents/a.jsonl",
      "convo/history/conv-1/v1",
    ]) {
      expect(packPathOk(ok, id), ok).toBe(true);
    }
    for (const bad of [
      "",
      "/etc/passwd",
      "../x",
      "untracked",
      "untracked/../x",
      "untracked/a//b",
      "untracked/.git/config",
      "untracked/.GIT/config",
      "untracked/a\\b",
      "convo/session/other.jsonl",
      "convo/session/other/a",
      "convo/history/conv-1",
      "convo/other/conv-1/a",
      "manifest.json",
      "made.json",
    ]) {
      expect(packPathOk(bad, id), bad).toBe(false);
    }
  });

  it("checks a whole manifest", () => {
    const good = {
      version: 1,
      sessionId: "conv-1",
      head: "a".repeat(40),
      sourcePath: "/x",
      files: [{ path: "changes.patch", size: 1, sha256: "b".repeat(64) }],
      links: [{ path: "untracked/l", target: "t" }],
      ignored: [],
      ignoredMore: 0,
    };
    expect(manifestProblem(good)).toBeNull();
    expect(manifestProblem(null)).toBeTruthy();
    expect(manifestProblem({ ...good, version: 2 })).toBeTruthy();
    expect(manifestProblem({ ...good, sessionId: "../x" })).toBe("Invalid session id");
    expect(manifestProblem({ ...good, head: "HEAD" })).toBe("Invalid commit id");
    expect(manifestProblem({ ...good, files: [{ path: "../x", size: 1, sha256: "b".repeat(64) }] })).toContain("Refused");
    expect(manifestProblem({ ...good, links: [{ path: "convo/session/conv-1.jsonl", target: "t" }] })).toContain("Refused");
  });
});

describe("moved records", () => {
  const record: MovedRecord = {
    sessionId: "tab-1",
    providerSessionId: "conv-1",
    toName: "Vivobook",
    at: new Date(2026, 9, 31, 10, 42).getTime(),
    live: { kind: "host", machineId: "m1", name: "s", cwd: "/w", source: "claude-cx" },
    cwd: "/w",
    branch: "moved/s",
    leftBehind: [".env", "node_modules/"],
    leftBehindMore: 3,
  };

  it("survives being read back, and drops what it can't read", () => {
    expect(parseMoved(JSON.stringify({ "tab-1": record }))).toEqual({ "tab-1": record });
    expect(parseMoved("not json")).toEqual({});
    expect(parseMoved("[1]")).toEqual({});
    expect(parseMoved(JSON.stringify({ x: { nope: 1 } }))).toEqual({});
    expect(parseMoved(null)).toEqual({});
  });

  it("says where it went and what stayed", () => {
    expect(movedTitle(record)).toMatch(/^Moved to Vivobook at 10.42/);
    expect(leftBehindText(record)).toBe("Left behind: .env, node_modules/, and 3 more");
    expect(leftBehindText({ leftBehind: [".env"], leftBehindMore: 0 })).toBe("Left behind: .env");
    expect(leftBehindText({ leftBehind: [], leftBehindMore: 0 })).toBeNull();
  });

  it("points an old card at where the conversation is now", () => {
    const back: MovedRecord = {
      ...record,
      sessionId: "lab-source",
      toName: "this Mac",
      at: record.at + 1000,
      live: { kind: "tab", sessionId: "tab-2" },
    };
    const map = withMoved(withMoved({}, record), back);
    expect(map["tab-1"].live).toEqual({ kind: "tab", sessionId: "tab-2" });
    expect(map["tab-1"].toName).toBe("this Mac");
    expect(map["lab-source"]).toEqual(back);
    // Its folder, branch and what stayed behind are the new copy's too.
    const moved = withMoved(map, { ...record, sessionId: "tab-2", cwd: "/w2", branch: "moved/s-2", leftBehind: [], leftBehindMore: 0 });
    expect(moved["tab-1"]).toMatchObject({ cwd: "/w2", branch: "moved/s-2", leftBehind: [], leftBehindMore: 0 });
  });

  it("never drops a record that still locks a tab to make room", () => {
    let map = {};
    for (let n = 0; n < 501; n++) {
      map = withMoved(map, { ...record, sessionId: `tab-${n}`, providerSessionId: `conv-${n}` });
    }
    // Every record locks by default, so the oldest stays.
    expect(map["tab-0"]).toBeDefined();
    expect(Object.keys(map)).toHaveLength(501);
    // Only records whose tab is gone make room, oldest first.
    const gone = new Set(["tab-3", "tab-7"]);
    const next = withMoved(map, { ...record, sessionId: "tab-new", providerSessionId: "conv-new" }, (id) => !gone.has(id));
    expect(Object.keys(next)).toHaveLength(500);
    expect(next["tab-0"]).toBeDefined();
    expect(next["tab-3"]).toBeUndefined();
    expect(next["tab-7"]).toBeUndefined();
    expect(next["tab-new"]).toBeDefined();
  });

  it("binds a tab moved to this Mac to the account its transcript landed in", () => {
    expect(macAccountFor("cx", "account-cx")).toBe("account-cx");
    expect(macAccountFor("main", "account-cx")).toBe("default");
    // No cx account here: it landed in main's folder, so it is main's.
    expect(macAccountFor("cx", undefined)).toBe("default");
  });

  it("lets a session moved host, Mac, host move to the Mac again", () => {
    const toMac: MovedRecord = { ...record, sessionId: labKey("conv-1"), live: { kind: "tab", sessionId: "tab-2" } };
    const backToHost: MovedRecord = { ...record, sessionId: "tab-2", at: record.at + 1000 };
    const map = withMoved(withMoved({}, toMac), backToHost);
    expect(map[labKey("conv-1")]).toBeUndefined();
    expect(map["tab-2"]).toEqual(backToHost);
    // A move to this Mac keeps its own record.
    expect(withMoved({}, toMac)[labKey("conv-1")]).toEqual(toMac);
  });

  it("knows a journal whose card was saved belongs to a finished move", () => {
    const map = withMoved({}, { ...record, moveId: "move-1" });
    expect(journalFinished(map, "tab-1", "move-1")).toBe(true);
    expect(journalFinished(map, "tab-1", "move-2")).toBe(false);
    expect(journalFinished(map, "tab-9", "move-1")).toBe(false);
  });

  it("drops a finished move's journal before a later move replaces its card", () => {
    const toMac: MovedRecord = {
      ...record,
      sessionId: labKey("conv-1"),
      moveId: "m1",
      live: { kind: "tab", sessionId: "tab-2" },
    };
    const map = withMoved({}, toMac);
    const entry = (moveId: string, sessionId: string) => ({ plan: { moveId, sessionId } });
    // m1 finished but its entry stayed; m2 is the next move, m3 an unfinished one.
    const journal = [entry("m1", labKey("conv-1")), entry("m3", "tab-9")];
    expect(openJournal(journal, map, "m2")).toEqual([entry("m3", "tab-9")]);
    // Once the card is replaced, m1 could no longer be told apart: it is already gone.
    const later = withMoved(map, { ...record, sessionId: "tab-2", moveId: "m2" });
    expect(journalFinished(later, labKey("conv-1"), "m1")).toBe(false);
    expect(openJournal([entry("m2", "tab-2")], later, "x")).toEqual([]);
  });
});
