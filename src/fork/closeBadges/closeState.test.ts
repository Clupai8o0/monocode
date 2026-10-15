import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import {
  cachedCloseState,
  closeStateOfBlocks,
  parseCloseLine,
  setCloseState,
} from "./closeState";
import { CloseBadge, safeToClose } from "./CloseBadges";

describe("parseCloseLine", () => {
  it("reads the three close lines, with markdown around them", () => {
    expect(parseCloseLine("- **Close:** `Safe to close: nothing left to do.`")).toEqual({
      kind: "safe",
      detail: "",
    });
    expect(
      parseCloseLine("**Close:** Safe to close, handover ready: .claude/handoff.md"),
    ).toEqual({ kind: "handover", detail: ".claude/handoff.md" });
    expect(
      parseCloseLine("- **Close:** `Not safe to close: tests still running.`"),
    ).toEqual({ kind: "unsafe", detail: "tests still running" });
  });

  it("uses the last close line and ignores other text", () => {
    const text = "Close: Not safe to close: x\nmore\n- Close: Safe to close: done";
    expect(parseCloseLine(text)?.kind).toBe("safe");
    expect(parseCloseLine("No close line here.")).toBeNull();
    expect(parseCloseLine("Close: maybe later")).toBeNull();
  });
});

describe("closeStateOfBlocks", () => {
  const reply = (text: string) => ({ role: "assistant" as const, text });
  const user = (text: string) => ({ role: "user" as const, text });

  it("reads the last reply of the last turn", () => {
    expect(
      closeStateOfBlocks([
        user("go"),
        reply("working"),
        { role: "tool", text: "ls" },
        reply("Recap\n- Close: Safe to close, handover ready: h.md"),
      ]),
    ).toEqual({ kind: "handover", detail: "h.md" });
  });

  it("drops the state once the user writes again", () => {
    expect(
      closeStateOfBlocks([reply("Close: Safe to close: done"), user("one more thing")]),
    ).toBeNull();
  });
});

describe("badges", () => {
  it("shows a badge only for the save it was read from, and only when idle", () => {
    setCloseState("s1", 10, { kind: "safe", detail: "" });
    const html = (updatedAt: number, idle: boolean) =>
      renderToStaticMarkup(createElement(CloseBadge, { sessionId: "s1", updatedAt, idle }));
    expect(html(10, true)).toContain('data-fork-close="safe"');
    expect(html(10, false)).toBe("");
    expect(html(11, true)).toBe("");
    expect(cachedCloseState("s1", 11)).toBeNull();
  });

  it("picks only safe sessions to close", () => {
    setCloseState("a", 1, { kind: "safe", detail: "" });
    setCloseState("b", 1, { kind: "handover", detail: "h.md" });
    setCloseState("c", 1, { kind: "unsafe", detail: "busy" });
    setCloseState("d", 1, { kind: "safe", detail: "" });
    expect(
      safeToClose([
        { id: "a", updatedAt: 1 },
        { id: "b", updatedAt: 1 },
        { id: "c", updatedAt: 1 },
        { id: "d", updatedAt: 2 },
      ]),
    ).toEqual(["a"]);
  });
});
