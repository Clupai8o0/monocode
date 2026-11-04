import { describe, expect, it } from "vitest";
import type { Block, HarnessId } from "./session";
import {
  buildCursorMultiReviewFanInText,
  buildCursorMultiReviewPrompt,
  buildCursorMultiReviewQueueMessage,
  buildCursorMultiReviewRequest,
  CursorMultiReviewPairs,
  CURSOR_MULTI_REVIEW_APP_PREFIX,
  isFrontendReviewPath,
  latestUserTurn,
  pathsLookFrontend,
  pickCursorMultiReviewers,
  shouldStartCursorMultiReview,
  cursorMultiReviewChildResult,
  cursorMultiReviewEmptyStatus,
  truncateReviewReport,
} from "./cursorMultiReview";

function user(id: string, text: string, extra: Partial<Block> = {}): Block {
  return { id, role: "user", text, ...extra };
}
function assistant(id: string, text: string): Block {
  return { id, role: "assistant", text };
}
function edit(id: string, path: string): Block {
  return {
    id,
    role: "tool",
    text: `Edited ${path}`,
    tool: {
      kind: "edit",
      title: `Edited ${path}`,
      status: "completed",
      preview: { kind: "write", path, fileName: path.split("/").pop() },
    },
  };
}

describe("latestUserTurn", () => {
  it("returns the last turn or null", () => {
    expect(latestUserTurn([])).toBeNull();
    const first = [user("u1", "one"), assistant("a1", "ok")];
    const second = [user("u2", "two"), edit("e2", "src/a.ts")];
    expect(latestUserTurn([...first, ...second])).toEqual(second);
  });
});

describe("isFrontendReviewPath", () => {
  it("matches UI extensions and path segments", () => {
    expect(isFrontendReviewPath("src/ui/Button.tsx")).toBe(true);
    expect(isFrontendReviewPath("styles/app.scss")).toBe(true);
    expect(isFrontendReviewPath("host/engine.ts")).toBe(false);
  });
});

describe("pathsLookFrontend", () => {
  it("returns true when any path looks frontend", () => {
    expect(
      pathsLookFrontend(["host/engine.ts", "src/components/Foo.tsx"]),
    ).toBe(true);
    expect(pathsLookFrontend(["host/engine.ts"])).toBe(false);
  });
});

describe("pickCursorMultiReviewers", () => {
  const live = (id: HarnessId) =>
    id === "claude" || id === "codex" || id === "grok";
  const visible = () => true;

  it("returns Claude plus lowest-usage peer", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: live,
        isVisible: visible,
        usedPercent: (id) => (id === "codex" ? 10 : id === "grok" ? 80 : null),
      }),
    ).toEqual([
      { harness: "claude", role: "claude" },
      { harness: "codex", role: "peer" },
    ]);
  });

  it("falls back codex → grok when usage unknown", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: (id) => id === "claude" || id === "grok" || id === "opencode",
        isVisible: visible,
        usedPercent: () => null,
      }).map((r) => r.harness),
    ).toEqual(["claude", "grok"]);
  });

  it("returns peer-only when Claude is missing", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: (id) => id === "codex",
        isVisible: visible,
        usedPercent: () => 0,
      }),
    ).toEqual([{ harness: "codex", role: "peer" }]);
  });

  it("returns empty when nobody is live", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: () => false,
        isVisible: visible,
        usedPercent: () => null,
      }),
    ).toEqual([]);
  });
});

describe("buildCursorMultiReviewPrompt", () => {
  it("forbids edits and adds frontend focus for Claude", () => {
    const prompt = buildCursorMultiReviewPrompt({
      from: "cursor",
      to: "claude",
      role: "claude",
      userRequest: "Polish the settings row",
      report: "Updated SettingsView",
      files: ["src/features/settings/ui/SettingsView.tsx"],
      frontendFocus: true,
    });
    expect(prompt).toMatch(/do not modify files/i);
    expect(prompt).not.toMatch(/Fix anything you agree is broken/);
    expect(prompt).toMatch(/UI\/UX|a11y|layout/i);
  });

  it("keeps the file list after a full request and report", () => {
    const prompt = buildCursorMultiReviewPrompt({
      from: "cursor",
      to: "codex",
      role: "peer",
      userRequest: "x".repeat(400),
      report: "y".repeat(900),
      files: ["src/a.ts"],
      frontendFocus: false,
    });
    expect(prompt).toContain("- src/a.ts");
  });

  it("keeps the frontend focus when the file list overflows the limit", () => {
    const prompt = buildCursorMultiReviewPrompt({
      from: "cursor",
      to: "claude",
      role: "claude",
      userRequest: "x",
      report: "y",
      files: Array.from(
        { length: 40 },
        (_, i) =>
          `src/features/settings/ui/components/${"deep/".repeat(20)}File${i}.tsx`,
      ),
      frontendFocus: true,
    });
    expect(prompt).toContain("[truncated]");
    expect(prompt).toContain("## Frontend focus");
  });

  it("keeps peer prompt general", () => {
    const prompt = buildCursorMultiReviewPrompt({
      from: "cursor",
      to: "codex",
      role: "peer",
      userRequest: "x",
      report: "y",
      files: ["src/features/settings/ui/SettingsView.tsx"],
      frontendFocus: true,
    });
    expect(prompt).not.toMatch(/UI\/UX|a11y|layout/i);
  });
});

describe("buildCursorMultiReviewRequest", () => {
  it("sets secondOpinion.kind and a read-only prompt", () => {
    const turn = [
      user("u1", "Polish the settings row"),
      assistant("a1", "Updated SettingsView"),
      edit("e1", "src/features/settings/ui/SettingsView.tsx"),
    ];
    const result = buildCursorMultiReviewRequest({
      from: "cursor",
      to: "claude",
      role: "claude",
      turn,
      cwd: "/tmp/project",
      pairId: "pair-1",
      sourceSessionId: "sess-1",
      turnId: "u1",
    });
    expect(result.options.secondOpinion.kind).toBe("cursor-multi-review");
    expect(result.prompt).toMatch(/do not modify files/i);
  });
});

describe("shouldStartCursorMultiReview", () => {
  const turn = [
    user("u1", "fix footer"),
    assistant("a1", "done"),
    edit("e1", "src/app/shell/UsageFooter.tsx"),
  ];
  const base = {
    enabled: true,
    harness: "cursor" as const,
    turn,
    turnUserBlockId: "u1",
    alreadyReviewed: false,
    worktreeRemoved: false,
    isRemote: false,
    backgroundRun: false,
  };

  it("requires setting, cursor harness, edits, and no in-flight pair", () => {
    expect(shouldStartCursorMultiReview(base)).toBe(true);
    expect(shouldStartCursorMultiReview({ ...base, enabled: false })).toBe(
      false,
    );
  });

  it("rejects non-cursor harness", () => {
    expect(shouldStartCursorMultiReview({ ...base, harness: "claude" })).toBe(
      false,
    );
  });

  it("rejects turns with no edits", () => {
    expect(
      shouldStartCursorMultiReview({
        ...base,
        turn: [user("u1", "fix footer"), assistant("a1", "done")],
      }),
    ).toBe(false);
  });

  it("rejects a turn already reviewed", () => {
    expect(
      shouldStartCursorMultiReview({ ...base, alreadyReviewed: true }),
    ).toBe(false);
  });

  it("rejects background runs", () => {
    expect(
      shouldStartCursorMultiReview({ ...base, backgroundRun: true }),
    ).toBe(false);
  });

  it("rejects removed worktrees and remote projects", () => {
    expect(
      shouldStartCursorMultiReview({ ...base, worktreeRemoved: true }),
    ).toBe(false);
    expect(shouldStartCursorMultiReview({ ...base, isRemote: true })).toBe(
      false,
    );
  });

  it("skips fan-in app turns", () => {
    const fanIn = [
      user("u2", "Multi-review ready", {
        appRequestId: `${CURSOR_MULTI_REVIEW_APP_PREFIX}abc`,
      }),
      edit("e2", "src/x.ts"),
    ];
    expect(
      shouldStartCursorMultiReview({
        ...base,
        turn: fanIn,
        turnUserBlockId: "u2",
      }),
    ).toBe(false);
  });

  it("skips turns that are already cursor-multi-review", () => {
    expect(
      shouldStartCursorMultiReview({
        ...base,
        turn: [
          user("u1", "fix footer", {
            secondOpinion: {
              from: "cursor",
              to: "claude",
              kind: "cursor-multi-review",
            },
          }),
          assistant("a1", "done"),
          edit("e1", "src/app/shell/UsageFooter.tsx"),
        ],
      }),
    ).toBe(false);
  });
});

describe("cursorMultiReviewEmptyStatus", () => {
  it("names each reviewer and why it ended", () => {
    expect(
      cursorMultiReviewEmptyStatus([
        {
          status: "failed",
          harness: "codex",
          title: "Review · Codex",
          text: "",
          error: "usage limited",
        },
        {
          status: "cancelled",
          harness: "grok",
          title: "Review · Grok",
          text: "",
        },
      ]),
    ).toBe(
      "Auto-review ended without a report. Codex failed: usage limited; Grok Build cancelled.",
    );
  });
});

describe("buildCursorMultiReviewFanInText request", () => {
  const results = [
    {
      status: "completed" as const,
      harness: "codex" as const,
      title: "Review · Codex",
      text: "Fine.",
    },
  ];

  it("names the turn it reviewed", () => {
    expect(buildCursorMultiReviewFanInText(results, "Fix\nthe footer")).toMatch(
      /your turn "Fix the footer"/,
    );
  });

  it("falls back to the last turn with no request", () => {
    expect(buildCursorMultiReviewFanInText(results)).toMatch(/your last turn/);
  });
});

describe("CursorMultiReviewPairs order", () => {
  const done = (harness: HarnessId) => ({
    status: "completed" as const,
    harness,
    title: "Review",
    text: "ok",
  });

  it("holds a newer turn's note until the older turn's reviews finish", () => {
    const ready: string[] = [];
    const pairs = new CursorMultiReviewPairs((pair) => {
      ready.push(pair.turnId);
    });
    pairs.begin({
      sourceSessionId: "cursor-1",
      turnId: "turn-a",
      childSessionIds: ["a1"],
    });
    pairs.begin({
      sourceSessionId: "cursor-1",
      turnId: "turn-b",
      childSessionIds: ["b1"],
    });
    pairs.begin({
      sourceSessionId: "cursor-2",
      turnId: "other",
      childSessionIds: ["c1"],
    });

    pairs.settleChild("b1", done("codex"));
    expect(ready).toEqual([]);
    // Another session's reviews are not held back.
    pairs.settleChild("c1", done("codex"));
    expect(ready).toEqual(["other"]);

    pairs.settleChild("a1", done("claude"));
    expect(ready).toEqual(["other", "turn-a", "turn-b"]);
  });
});

describe("buildCursorMultiReviewFanInText status", () => {
  it("marks a partial report from a reviewer that stopped early", () => {
    const text = buildCursorMultiReviewFanInText([
      {
        status: "cancelled",
        harness: "claude",
        title: "Review · Claude",
        text: "First finding.",
      },
    ]);
    expect(text).toMatch(/## Claude[^\n]*\n\(cancelled\)\nFirst finding\./);
  });

  it("leaves a finished report unmarked", () => {
    const text = buildCursorMultiReviewFanInText([
      {
        status: "completed",
        harness: "claude",
        title: "Review · Claude",
        text: "Fine.",
      },
    ]);
    expect(text).toMatch(/## Claude[^\n]*\nFine\./);
  });
});

describe("cursorMultiReviewChildResult", () => {
  const child = (blocks: Block[]) => ({
    harness: "claude" as const,
    title: "Review · Claude",
    blocks,
  });

  it("takes the last written reply of the latest turn", () => {
    const result = cursorMultiReviewChildResult(
      child([
        user("u1", "review"),
        assistant("a1", "Looking."),
        edit("e1", "src/x.ts"),
        assistant("a2", "Missing aria-label."),
      ]),
      { status: "completed" },
    );
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Missing aria-label.");
  });

  it("keeps failure details when nothing was written", () => {
    expect(
      cursorMultiReviewChildResult(child([]), {
        status: "failed",
        error: "usage limited",
      }),
    ).toMatchObject({ status: "failed", text: "", error: "usage limited" });
  });
});

describe("truncateReviewReport", () => {
  it("caps at 3000 characters", () => {
    expect(truncateReviewReport("x".repeat(4000)).length).toBe(3000);
  });
});

describe("CursorMultiReviewPairs", () => {
  it("fires onReady once when all children settle", () => {
    const ready: string[] = [];
    const pairs = new CursorMultiReviewPairs((pair) => {
      ready.push(pair.pairId);
    });
    const pairId = pairs.begin({
      sourceSessionId: "cursor-1",
      turnId: "u1",
      childSessionIds: ["r-claude", "r-codex"],
    });
    expect(pairs.hasStarted("cursor-1", "u1")).toBe(true);
    expect(pairs.isChild("r-claude")).toBe(true);
    expect(pairs.isChild("r-codex")).toBe(true);
    expect(pairs.isChild("other")).toBe(false);

    pairs.settleChild("r-claude", {
      status: "completed",
      harness: "claude",
      title: "Review · Claude",
      text: "Looks fine.",
    });
    expect(ready).toEqual([]);
    expect(pairs.hasStarted("cursor-1", "u1")).toBe(true);

    pairs.settleChild("r-codex", {
      status: "failed",
      harness: "codex",
      title: "Review · Codex",
      text: "",
      error: "usage limited",
    });
    expect(ready).toEqual([pairId]);
    // Stays reviewed, so a later settle of the same turn can't re-fire.
    expect(pairs.hasStarted("cursor-1", "u1")).toBe(true);
    expect(pairs.isChild("r-claude")).toBe(false);
  });

  it("dropSource clears without onReady", () => {
    let readyCount = 0;
    const pairs = new CursorMultiReviewPairs(() => {
      readyCount += 1;
    });
    pairs.begin({
      sourceSessionId: "cursor-1",
      turnId: "u1",
      childSessionIds: ["r-claude", "r-codex"],
    });
    pairs.dropSource("cursor-1");
    expect(pairs.isChild("r-claude")).toBe(false);
    pairs.settleChild("r-claude", {
      status: "completed",
      harness: "claude",
      title: "Review · Claude",
      text: "late",
    });
    pairs.settleChild("r-codex", {
      status: "completed",
      harness: "codex",
      title: "Review · Codex",
      text: "late",
    });
    expect(readyCount).toBe(0);
  });
});

describe("buildCursorMultiReviewFanInText", () => {
  it("includes both sections and read-only guidance", () => {
    const text = buildCursorMultiReviewFanInText([
      {
        status: "completed",
        harness: "claude",
        title: "Review · Claude",
        text: "Missing aria-label.",
      },
      {
        status: "completed",
        harness: "codex",
        title: "Review · Codex",
        text: "Off-by-one in the pager.",
      },
    ]);
    expect(text).toMatch(/read-only/i);
    expect(text).toContain("## Claude");
    expect(text).toContain("## Codex");
    expect(text).toContain("Missing aria-label");
  });
});

describe("buildCursorMultiReviewQueueMessage", () => {
  it("uses app prefix + pairId and fan-in text", () => {
    const results = [
      {
        status: "completed" as const,
        harness: "claude" as const,
        title: "Review · Claude",
        text: "Missing aria-label.",
      },
    ];
    const message = buildCursorMultiReviewQueueMessage("pair-abc", results);
    expect(message.id).toBe(`${CURSOR_MULTI_REVIEW_APP_PREFIX}pair-abc`);
    expect(message.text).toBe(buildCursorMultiReviewFanInText(results));
    expect(message.attachments).toEqual([]);
  });
});
