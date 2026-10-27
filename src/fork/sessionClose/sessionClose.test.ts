import { describe, expect, it } from "vitest";
import type { Session } from "../../features/sessions/model/session";
import {
  leafIds,
  newEditorWorkspaceTab,
  newFileTab,
  newTab,
  splitPane,
  type WorkspaceTab,
} from "../../features/workspace/model/layout";
import {
  canCloseForMemory,
  planSessionClose,
  referencedSessionIds,
  withRunningLeads,
} from "./sessionClose";

const CWD = "/Users/me/project";

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    cwd: CWD,
    harness: "claude",
    title: "",
    model: "",
    blocks: [{ id: `${id}-u`, role: "user", text: "hi" }],
    ...extra,
  } as Session;
}

function tabWith(...ids: string[]): WorkspaceTab {
  const tab = newTab(ids[0]);
  let layout = tab.layout;
  for (const id of ids.slice(1)) {
    layout = splitPane(layout, ids[0], "row", id);
  }
  return { ...tab, layout };
}

function plan(
  tabs: WorkspaceTab[],
  sessions: Session[],
  ids: string[],
  activeTabId = tabs[0].id,
  busyIds: ReadonlySet<string> = new Set(),
) {
  return planSessionClose({
    tabs,
    sessions,
    ids,
    busyIds,
    activeTabId,
    scope: "workspace",
  });
}

describe("canCloseForMemory", () => {
  it("closes an idle saved conversation", () => {
    expect(canCloseForMemory(session("a"), new Set())).toBe(true);
  });

  it("keeps work in flight and what only makes sense on screen", () => {
    const none = new Set<string>();
    expect(canCloseForMemory(session("a", { busy: true }), none)).toBe(false);
    expect(canCloseForMemory(session("a"), new Set(["a"]))).toBe(false);
    expect(
      canCloseForMemory(session("a", { orchestrationLeadId: "lead" }), none),
    ).toBe(false);
    expect(
      canCloseForMemory(
        session("a", { pendingQuestion: {} as Session["pendingQuestion"] }),
        none,
      ),
    ).toBe(false);
    expect(
      canCloseForMemory(
        session("a", {
          queuedMessages: [{ id: "q" } as NonNullable<
            Session["queuedMessages"]
          >[number]],
        }),
        none,
      ),
    ).toBe(false);
    // A usage limit, and any resume armed for its reset, live in memory.
    expect(
      canCloseForMemory(
        session("a", { usageLimit: {} as Session["usageLimit"] }),
        none,
      ),
    ).toBe(false);
    expect(
      canCloseForMemory(
        session("a", { pendingSwitch: {} as Session["pendingSwitch"] }),
        none,
      ),
    ).toBe(false);
    // Never sent anything: nothing saved to come back to.
    expect(canCloseForMemory(session("a", { blocks: [] }), none)).toBe(false);
  });
});

describe("planSessionClose", () => {
  it("closes a background tab and keeps the active one", () => {
    const a = tabWith("a");
    const b = tabWith("b");
    const result = plan([a, b], [session("a"), session("b")], ["b"]);
    expect(result.closed).toEqual(["b"]);
    expect(result.tabs.map((tab) => tab.id)).toEqual([a.id]);
    expect(result.activeTabId).toBe(a.id);
    expect(result.blankTabIds).toEqual([]);
  });

  it("closes only the pane in a split", () => {
    const tab = tabWith("a", "b");
    const result = plan([tab], [session("a"), session("b")], ["b"]);
    expect(result.closed).toEqual(["b"]);
    expect(leafIds(result.tabs[0].layout)).toEqual(["a"]);
    expect(result.tabs[0].focusedId).toBe("a");
  });

  it("moves off the active tab when it closes", () => {
    const a = tabWith("a");
    const b = tabWith("b");
    const result = plan([a, b], [session("a"), session("b")], ["b"], b.id);
    expect(result.tabs.map((tab) => tab.id)).toEqual([a.id]);
    expect(result.activeTabId).toBe(a.id);
  });

  it("keeps the last tab for a blank session", () => {
    const a = tabWith("a");
    const result = plan([a], [session("a")], ["a"]);
    expect(result.closed).toEqual(["a"]);
    expect(result.tabs.map((tab) => tab.id)).toEqual([a.id]);
    expect(result.blankTabIds).toEqual([a.id]);
    expect(result.activeTabId).toBe(a.id);
  });

  it("keeps one tab when every tab closes at once", () => {
    const a = tabWith("a");
    const b = tabWith("b");
    const result = plan([a, b], [session("a"), session("b")], ["a", "b"]);
    expect(result.closed.sort()).toEqual(["a", "b"]);
    expect(result.tabs).toHaveLength(1);
    expect(result.blankTabIds).toEqual([result.tabs[0].id]);
    expect(result.activeTabId).toBe(result.tabs[0].id);
  });

  it("closes a loaded session that has no tab", () => {
    const a = tabWith("a");
    const result = plan([a], [session("a"), session("loose")], ["loose"]);
    expect(result.closed).toEqual(["loose"]);
    expect(result.tabs).toEqual([a]);
  });

  it("skips busy sessions and unknown ids", () => {
    const a = tabWith("a");
    const b = tabWith("b");
    const result = plan(
      [a, b],
      [session("a"), session("b", { busy: true })],
      ["b", "gone"],
    );
    expect(result.closed).toEqual([]);
    expect(result.tabs).toEqual([a, b]);
  });

  it("keeps a file pane beside the closed session", () => {
    const a = tabWith("a");
    const editor = newEditorWorkspaceTab(
      newFileTab("/Users/me/project/x.ts", CWD),
    );
    const paneId = editor.editorPanes[0].id;
    const mixed: WorkspaceTab = {
      ...editor,
      layout: splitPane(editor.layout, paneId, "row", "b"),
      focusedId: "b",
    };
    const result = plan([a, mixed], [session("a"), session("b")], ["b"]);
    expect(result.closed).toEqual(["b"]);
    expect(result.tabs).toHaveLength(2);
    expect(leafIds(result.tabs[1].layout)).toEqual([paneId]);
    expect(result.tabs[1].focusedId).toBe(paneId);
    expect(result.tabs[1].editorPanes).toEqual(editor.editorPanes);
  });

  it("leaves a session open when its tab holds files outside the layout", () => {
    const a = tabWith("a");
    const file = newFileTab("/Users/me/project/x.ts", CWD);
    const withFile: WorkspaceTab = {
      ...tabWith("b"),
      editorPanes: [{ id: "pane", files: [file], activeFileId: file.id }],
    };
    const result = plan([a, withFile], [session("a"), session("b")], ["b"]);
    expect(result.closed).toEqual([]);
    expect(result.tabs).toEqual([a, withFile]);
  });
});

describe("withRunningLeads", () => {
  it("holds the lead of a run that is still going", () => {
    const busy = new Set(["x"]);
    const held = withRunningLeads(busy, [
      { leadId: "lead", status: "active" },
      { leadId: "waiting", status: "paused" },
      { leadId: "done", status: "completed" },
    ]);
    expect([...held].sort()).toEqual(["lead", "waiting", "x"]);
    expect(withRunningLeads(busy, [])).toBe(busy);
  });
});

describe("referencedSessionIds", () => {
  it("keeps a session whose plan is open in a tab", () => {
    const a = tabWith("a");
    const plan = {
      ...newFileTab("/Users/me/project/plan.md", CWD),
      plan: { sessionId: "b" } as NonNullable<
        ReturnType<typeof newFileTab>["plan"]
      >,
    };
    const editor = newEditorWorkspaceTab(plan);
    const tabs = [a, editor];
    expect([...referencedSessionIds(tabs)]).toEqual(["b"]);
    const result = planSessionClose({
      tabs,
      sessions: [session("a"), session("b")],
      ids: ["b"],
      busyIds: new Set(),
      activeTabId: a.id,
      scope: "workspace",
    });
    expect(result.closed).toEqual([]);
  });
});
