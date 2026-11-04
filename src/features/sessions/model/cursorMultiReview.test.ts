import { describe, expect, it } from "vitest";
import type { HarnessId } from "./session";
import {
  isFrontendReviewPath,
  pathsLookFrontend,
  pickCursorMultiReviewers,
} from "./cursorMultiReview";

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
