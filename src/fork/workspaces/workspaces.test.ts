import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  label: "main" as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (mocks.label === null) {
      throw new Error("no Tauri");
    }
    return { label: mocks.label };
  },
}));

async function load() {
  vi.resetModules();
  const win = await import("./workspaceWindow");
  const store = await import("../../features/sessions/data/sessionStore");
  const ws = await import("./workspaces");
  return { win, store, ws };
}

afterEach(() => {
  mocks.invoke.mockReset();
  mocks.label = "main";
});

describe("workspace window labels", () => {
  it("only ws-<slug> labels are workspaces", async () => {
    const { win } = await load();
    expect(win.workspaceSlugOfLabel("ws-uni")).toBe("uni");
    expect(win.workspaceSlugOfLabel("ws-uni-2")).toBe("uni-2");
    expect(win.workspaceSlugOfLabel("main")).toBeNull();
    expect(win.workspaceSlugOfLabel("window-3")).toBeNull();
    expect(win.workspaceSlugOfLabel("ws-")).toBeNull();
    expect(win.workspaceSlugOfLabel("ws-Uni")).toBeNull();
    expect(win.workspaceSlugOfLabel("ws--x")).toBeNull();
  });

  it("routes store commands only in a workspace window", async () => {
    const { win } = await load();
    expect(win.storeCommand("workspace_set_snapshot", null)).toBe(
      "workspace_set_snapshot",
    );
    expect(win.storeCommand("workspace_set_snapshot", "uni")).toBe(
      "fork_workspace_save",
    );
    expect(win.storeCommand("session_list_in_flight", "uni")).toBe(
      "fork_workspace_list_in_flight",
    );
  });

  it("behaves like the main window without Tauri", async () => {
    mocks.label = null;
    const { win } = await load();
    expect(win.currentWorkspaceSlug()).toBeNull();
  });
});

describe("session store in a workspace window", () => {
  it("main keeps upstream's single snapshot row", async () => {
    const { store } = await load();
    mocks.invoke.mockResolvedValue(null);
    await store.saveWorkspaceSnapshot({ a: 1 });
    await store.loadWorkspaceSnapshot();
    await store.listInFlightSessions().catch(() => []);
    expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual([
      "workspace_set_snapshot",
      "workspace_get_snapshot",
      "session_list_in_flight",
    ]);
  });

  it("a workspace window saves and loads its own row", async () => {
    mocks.label = "ws-uni";
    const { store } = await load();
    mocks.invoke.mockResolvedValue(null);
    await store.saveWorkspaceSnapshot({ a: 1 });
    await store.loadWorkspaceSnapshot();
    mocks.invoke.mockResolvedValue([]);
    await store.replaceInFlightSessions([{ sessionId: "s1", cwd: "/x" }]);
    await store.listInFlightSessions();
    expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual([
      "fork_workspace_save",
      "fork_workspace_load",
      "fork_workspace_set_in_flight",
      "fork_workspace_list_in_flight",
    ]);
    expect(mocks.invoke.mock.calls[0][1]).toEqual({ snapshot: { a: 1 } });
    expect(mocks.invoke.mock.calls[2][1]).toEqual({
      sessions: [{ sessionId: "s1", cwd: "/x" }],
    });
  });
});

describe("titles and session reports", () => {
  it("puts the workspace name first", async () => {
    const { ws } = await load();
    expect(ws.titleWithWorkspace("chat — MonoCode", "Uni")).toBe(
      "Uni · chat — MonoCode",
    );
    expect(ws.titleWithWorkspace("chat", null)).toBe("chat");
    expect(ws.titleWithWorkspace("", "Uni")).toBe("Uni");
  });

  it("ignores order and repeats when comparing open sessions", async () => {
    const { ws } = await load();
    expect(ws.sessionIdsKey(["b", "a", "b"])).toBe(
      ws.sessionIdsKey(["a", "b"]),
    );
    expect(ws.sessionIdsKey([])).toBe("");
  });

  it("does nothing under the test runner", async () => {
    const { ws } = await load();
    expect(ws.FORK_WORKSPACES).toBe(false);
    await expect(ws.focusSessionElsewhere("s1")).resolves.toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
