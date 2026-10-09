import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { newSession, type Block } from "../../features/sessions/model/session";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import { sanitizeSessionForPersist } from "../../features/sessions/data/sessionStore";
import {
  applyChecklistOp,
  checklistFromBlocks,
  isChecklistToolName,
  sanitizeChecklistOp,
  type Checklist,
} from "./checklist";
import { ChecklistSidebar } from "./ChecklistSidebar";

const empty: Checklist = { title: "Checklist", items: [] };

function fold(...ops: Record<string, unknown>[]): Checklist {
  return ops.reduce<Checklist>((list, op) => applyChecklistOp(list, op), empty);
}

describe("checklist tool name", () => {
  it("matches only the mod's own tool", () => {
    expect(isChecklistToolName("mcp__side-checklist__checklist")).toBe(true);
    expect(isChecklistToolName("checklist")).toBe(false);
    expect(isChecklistToolName("mcp__other__checklist")).toBe(false);
    expect(isChecklistToolName("TodoWrite")).toBe(false);
  });
});

describe("checklist fold", () => {
  const set = {
    action: "set",
    title: "Swap",
    items: [
      { text: "Quit the app", who: "Sam", by: "now" },
      "Reply closed",
      { text: "Check logs", done: true },
    ],
  };

  it("set replaces the list and keeps who, by and done", () => {
    expect(fold(set)).toEqual({
      title: "Swap",
      items: [
        { text: "Quit the app", done: false, who: "Sam", by: "now" },
        { text: "Reply closed", done: false },
        { text: "Check logs", done: true },
      ],
    });
  });

  it("set without a title keeps the current one", () => {
    expect(fold(set, { action: "set", items: ["Only"] }).title).toBe("Swap");
  });

  it("add appends, check and uncheck toggle by 1-based number", () => {
    const list = fold(
      set,
      { action: "add", items: ["Fourth"] },
      { action: "check", numbers: [1, 4] },
      { action: "uncheck", number: 3 },
    );
    expect(list.items.map((item) => [item.text, item.done])).toEqual([
      ["Quit the app", true],
      ["Reply closed", false],
      ["Check logs", false],
      ["Fourth", true],
    ]);
  });

  it("remove drops every numbered step against the list as it was", () => {
    const list = fold(set, { action: "remove", numbers: [1, 3] });
    expect(list.items.map((item) => item.text)).toEqual(["Reply closed"]);
  });

  it("ignores out-of-range numbers and unknown actions, like the mod", () => {
    const before = fold(set);
    expect(fold(set, { action: "check", numbers: [9] })).toEqual(before);
    expect(fold(set, { action: "check", numbers: [] })).toEqual(before);
    expect(fold(set, { action: "check", numbers: [1.5] })).toEqual(before);
    expect(fold(set, { action: "shuffle" })).toEqual(before);
  });

  it("clear empties the list and resets the title", () => {
    expect(fold(set, { action: "clear" })).toEqual(empty);
  });

  it("skips calls whose tool failed", () => {
    const blocks = [
      { checklist: set, tool: { status: "completed" } },
      { checklist: { action: "clear" }, tool: { status: "failed" } },
    ];
    expect(checklistFromBlocks(blocks).items).toHaveLength(3);
  });
});

describe("sanitizeChecklistOp", () => {
  it("keeps only the fields the fold reads", () => {
    expect(
      sanitizeChecklistOp({ action: "check", numbers: [1], junk: "x" }),
    ).toEqual({ action: "check", numbers: [1] });
    expect(sanitizeChecklistOp({ numbers: [1] })).toBeUndefined();
    expect(sanitizeChecklistOp("set")).toBeUndefined();
  });
});

describe("checklist.updated event", () => {
  function withTool(callId: string) {
    return applyHarnessEvent(newSession("claude", "/repo"), {
      type: "tool.started",
      callId,
      title: "checklist",
      kind: "mcp__side-checklist__checklist",
      status: "pending",
    });
  }

  it("stores the latest input on the matching tool block", () => {
    let session = withTool("toolu_1");
    session = applyHarnessEvent(session, {
      type: "checklist.updated",
      callId: "toolu_1",
      input: { action: "set", items: ["One"] },
    });
    session = applyHarnessEvent(session, {
      type: "checklist.updated",
      callId: "toolu_1",
      input: { action: "set", items: ["One", "Two"] },
    });
    const tool = session.blocks.find((block) => block.tool?.callId === "toolu_1");
    expect(tool?.checklist).toEqual({ action: "set", items: ["One", "Two"] });
    expect(checklistFromBlocks(session.blocks).items).toHaveLength(2);
  });

  it("keeps the op when the tool finishes", () => {
    let session = withTool("toolu_1");
    session = applyHarnessEvent(session, {
      type: "checklist.updated",
      callId: "toolu_1",
      input: { action: "set", items: ["One"] },
    });
    session = applyHarnessEvent(session, {
      type: "tool.updated",
      callId: "toolu_1",
      status: "completed",
    });
    expect(checklistFromBlocks(session.blocks).items).toEqual([
      { text: "One", done: false },
    ]);
  });

  it("ignores a call with no tool block", () => {
    const session = newSession("claude", "/repo");
    expect(
      applyHarnessEvent(session, {
        type: "checklist.updated",
        callId: "missing",
        input: { action: "set", items: ["One"] },
      }),
    ).toBe(session);
  });
});

describe("checklist persistence", () => {
  it("survives a save and keeps the blocks around it", () => {
    const session = newSession("claude", "/repo");
    session.blocks = [
      { id: "u1", role: "user", text: "steps please" },
      {
        id: "t1",
        role: "tool",
        text: "checklist",
        tool: { callId: "toolu_1", status: "completed" },
        checklist: { action: "set", items: ["One"], junk: "dropped" },
      },
      {
        id: "tasks1",
        role: "tasks",
        text: "[ ] Inspect",
        taskList: { items: [{ text: "Inspect", status: "pending" }] },
      },
    ];
    const saved = sanitizeSessionForPersist(session).blocks as Block[];
    expect(saved.map((block) => block.id)).toEqual(["u1", "t1", "tasks1"]);
    expect(saved[1].checklist).toEqual({ action: "set", items: ["One"] });
    expect(checklistFromBlocks(saved).items).toEqual([
      { text: "One", done: false },
    ]);
  });
});

describe("ChecklistSidebar", () => {
  const blocks = [
    {
      id: "b1",
      role: "tool",
      text: "checklist",
      tool: { callId: "t1", status: "completed" },
      checklist: {
        action: "set",
        title: "Deploy",
        items: [{ text: "Run migrations", who: "Sam", by: "Fri", done: true }, "Ship"],
      },
    },
  ] as Block[];

  it("renders nothing without a checklist", () => {
    expect(renderToStaticMarkup(createElement(ChecklistSidebar, { blocks: [] }))).toBe("");
  });

  it("renders the title, progress, steps and owners", () => {
    const html = renderToStaticMarkup(createElement(ChecklistSidebar, { blocks }));
    expect(html).toContain("Deploy");
    expect(html).toContain("1/2");
    expect(html).toContain("Run migrations");
    expect(html).toContain("Sam · Fri");
    expect(html).toContain("Ship");
  });
});
