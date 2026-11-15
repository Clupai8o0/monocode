import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import {
  cleanupAge,
  cleanupCandidates,
  cleanupResult,
  deleteCautions,
  deleteQuestion,
  firstFilledFilter,
  groupByProject,
  handoverLocation,
  IDLE_AFTER_MS,
  inCleanupFilter,
  isHeld,
  readyToClose,
  tickedByDefault,
} from "./cleanupModel";

function row(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd: "/p/a",
    harness: "claude",
    model: "m",
    runtimeMode: "default",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as SessionSummary;
}

const nothingHeld = { busy: new Set<string>(), approval: new Set<string>() };

describe("cleanupCandidates", () => {
  it("leaves out what must not be tidied away unseen", () => {
    const rows = [
      row("plain"),
      row("archived", { archived: true }),
      row("pinned", { pinned: true }),
      row("draft", { draft: true }),
      row("hidden", { sidebarHidden: true }),
      row("worker", { orchestrationLeadId: "lead" }),
    ];
    expect(cleanupCandidates(rows, nothingHeld).map((r) => r.id)).toEqual([
      "plain",
    ]);
  });

  it("leaves out sessions working, waiting or on screen", () => {
    const rows = [row("a"), row("busy"), row("asking"), row("shown")];
    const held = {
      activeSessionId: "shown",
      busy: new Set(["busy"]),
      approval: new Set(["asking"]),
    };
    expect(cleanupCandidates(rows, held).map((r) => r.id)).toEqual(["a"]);
    expect(isHeld("busy", held)).toBe(true);
    expect(isHeld("a", held)).toBe(false);
  });
});

describe("inCleanupFilter", () => {
  const now = 10 * IDLE_AFTER_MS;

  it("matches the close line for Safe and Handover", () => {
    expect(inCleanupFilter(now, "safe", "safe", now)).toBe(true);
    expect(inCleanupFilter(now, "handover", "safe", now)).toBe(false);
    expect(inCleanupFilter(now, undefined, "safe", now)).toBe(false);
    expect(inCleanupFilter(now, "handover", "handover", now)).toBe(true);
  });

  it("matches by age for Idle, with the edge counted in", () => {
    expect(inCleanupFilter(now - IDLE_AFTER_MS, undefined, "idle", now)).toBe(
      true,
    );
    expect(
      inCleanupFilter(now - IDLE_AFTER_MS + 1, undefined, "idle", now),
    ).toBe(false);
  });

  it("shows every row under Everything", () => {
    expect(inCleanupFilter(now, "unsafe", "all", now)).toBe(true);
  });
});

describe("tickedByDefault", () => {
  it("ticks closed, finished sessions", () => {
    expect(tickedByDefault("safe", "safe", false, true)).toBe(true);
    expect(tickedByDefault(undefined, "idle", false, true)).toBe(true);
  });

  it("never starts ticked for open, unsafe or Everything", () => {
    expect(tickedByDefault("safe", "safe", true, true)).toBe(false);
    expect(tickedByDefault("unsafe", "idle", false, true)).toBe(false);
    expect(tickedByDefault("safe", "all", false, true)).toBe(false);
  });

  it("waits for a session's last reply to be read", () => {
    expect(tickedByDefault(undefined, "idle", false, false)).toBe(false);
  });
});

describe("groupByProject", () => {
  it("keeps rows together in first-seen order", () => {
    const groups = groupByProject([
      { cwd: "/b", id: 1 },
      { cwd: "/a", id: 2 },
      { cwd: "/b", id: 3 },
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(["/b", "/a"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual([1, 3]);
  });
});

describe("labels", () => {
  it("shortens ages", () => {
    expect(cleanupAge(-5)).toBe("0m");
    expect(cleanupAge(12 * 60_000)).toBe("12m");
    expect(cleanupAge(5 * 3_600_000)).toBe("5h");
    expect(cleanupAge(3 * 86_400_000)).toBe("3d");
  });

  it("mentions kept sessions only when there are some", () => {
    expect(cleanupResult("archive", 3, 0)).toBe("Archived 3.");
    expect(cleanupResult("archive", 3, 1)).toContain("Kept 1");
    expect(cleanupResult("delete", 3, 0)).toBe("Deleted 3.");
    expect(cleanupResult("delete", 3, 1)).toContain("could not be deleted");
  });

  it("asks how much to delete and says what stays", () => {
    expect(deleteQuestion(1, 1)).toBe(
      "Delete 1 session from 1 project for good? Worktrees and branches stay.",
    );
    expect(deleteQuestion(4, 2)).toContain("4 sessions from 2 projects");
  });

  it("names only the risks a delete really has", () => {
    expect(deleteCautions(0, 0, 0)).toBeUndefined();
    expect(deleteCautions(2, 0, 1)).toBe(
      "Includes 2 marked not safe, 1 open in a tab.",
    );
    expect(deleteCautions(0, 3, 0)).toBe("Includes 3 not read yet.");
  });
});

describe("firstFilledFilter", () => {
  it("prefers the earliest tab with rows", () => {
    expect(firstFilledFilter(() => 2)).toBe("safe");
    expect(firstFilledFilter((f) => (f === "handover" || f === "all" ? 1 : 0))).toBe(
      "handover",
    );
    expect(firstFilledFilter((f) => (f === "all" ? 3 : 0))).toBe("all");
  });
  it("falls back to Safe when there is nothing at all", () => {
    expect(firstFilledFilter(() => 0)).toBe("safe");
  });
});

describe("readyToClose", () => {
  it("counts safe and handover only", () => {
    expect(readyToClose(["safe", "handover", "unsafe", undefined, "safe"])).toBe(3);
    expect(readyToClose([])).toBe(0);
  });
});

describe("handoverLocation", () => {
  it("shortens a path inside the project", () => {
    expect(handoverLocation("/p/a/.claude/handoff.md", "/p/a")).toBe(".claude/handoff.md");
    expect(handoverLocation("/p/a/x.md", "/p/a/")).toBe("x.md");
  });
  it("leaves anything else whole", () => {
    expect(handoverLocation("/p/ab/x.md", "/p/a")).toBe("/p/ab/x.md");
    expect(handoverLocation(".claude/handoff.md", "/p/a")).toBe(".claude/handoff.md");
  });
});
