import { describe, expect, it } from "vitest";
import {
  CONTINUE_PROMPT,
  handoffAge,
  handoffPath,
  summarizeHandoff,
} from "./handoffModel";

describe("handoffPath", () => {
  it("points at .claude/handoff.md in local folders only", () => {
    expect(handoffPath("/Users/me/app/")).toBe(
      "/Users/me/app/.claude/handoff.md",
    );
    expect(handoffPath("remote://box/app")).toBeNull();
    expect(handoffPath("~")).toBeNull();
  });
});

describe("summarizeHandoff", () => {
  it("takes the newest section's heading and first line", () => {
    const text = [
      "# MonoCode fork — handoff (2026-10-10)",
      "",
      "## NOW (2026-10-16 01:35): both tracks **BUILT**, waiting on `commit`",
      "- Done: alert boards ([design](https://x.y)) and claims tags",
      "- Left: live test",
      "",
      "## EARLIER",
      "- old",
    ].join("\n");
    expect(summarizeHandoff(text)).toEqual({
      heading: "NOW (2026-10-16 01:35): both tracks BUILT, waiting on commit",
      line: "Done: alert boards (design) and claims tags",
    });
  });

  it("falls back to the first line when there are no sections", () => {
    expect(summarizeHandoff("Just carry on with the tests.\nMore.")).toEqual({
      heading: "",
      line: "Just carry on with the tests.",
    });
    expect(summarizeHandoff("")).toEqual({ heading: "", line: "" });
  });

  it("clips long lines", () => {
    const long = summarizeHandoff(`## ${"x".repeat(200)}`).heading;
    expect(long).toHaveLength(90);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("handoffAge", () => {
  it("reads short", () => {
    expect(handoffAge(0, 30_000)).toBe("just now");
    expect(handoffAge(0, 12 * 60_000)).toBe("12m ago");
    expect(handoffAge(0, 3 * 3_600_000)).toBe("3h ago");
    expect(handoffAge(0, 72 * 3_600_000)).toBe("3d ago");
  });

  it("names the file in the prompt", () => {
    expect(CONTINUE_PROMPT).toContain(".claude/handoff.md");
  });
});
