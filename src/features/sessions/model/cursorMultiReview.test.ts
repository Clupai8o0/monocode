import { describe, expect, it } from "vitest";
import type { Block, HarnessId } from "./session";
import {
  buildCursorMultiReviewPrompt,
  buildCursorMultiReviewRequest,
  CURSOR_MULTI_REVIEW_APP_PREFIX,
  isFrontendReviewPath,
  pathsLookFrontend,
  pickCursorMultiReviewers,
  shouldStartCursorMultiReview,
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
    hasInFlightPair: false,
    worktreeRemoved: false,
    isRemote: false,
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

  it("rejects when a pair is already in flight", () => {
    expect(
      shouldStartCursorMultiReview({ ...base, hasInFlightPair: true }),
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
