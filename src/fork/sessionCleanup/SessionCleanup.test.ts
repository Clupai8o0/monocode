// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listSessionsByProject = vi.fn();
vi.mock("../../features/sessions/data/sessionStore", async (load) => ({
  ...(await load<object>()),
  listSessionsByProject,
}));
const sessionHeldElsewhere = vi.fn();
vi.mock("../workspaces/workspaces", () => ({ sessionHeldElsewhere }));
vi.mock("../sessionRead", () => ({
  readSession: vi.fn(() => Promise.resolve(null)),
}));

const { SessionCleanup } = await import("./SessionCleanup");
const { setCloseState } = await import("../closeBadges/closeState");
const { cachedCleanupRows, resetCleanupRows } = await import("./cleanupRows");
const { readSession } = await import("../sessionRead");

type Row = {
  id: string;
  cwd: string;
  harness: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
};

const NOW = Date.now();
const SAVED = NOW - 3_600_000;

function session(id: string, cwd: string, extra: Partial<Row> = {}): Row {
  return { id, cwd, harness: "claude", title: id, updatedAt: SAVED, ...extra };
}

let projects: Record<string, Row[]>;
let container: HTMLDivElement;
let root: Root;
let onArchive: ReturnType<typeof vi.fn>;
let onDelete: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
let onOpenSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  projects = {
    "/p/alpha": [session("a1", "/p/alpha"), session("a2", "/p/alpha")],
    "/p/beta": [session("b1", "/p/beta")],
  };
  resetCleanupRows();
  sessionHeldElsewhere.mockReset();
  sessionHeldElsewhere.mockResolvedValue(false);
  listSessionsByProject.mockReset();
  listSessionsByProject.mockImplementation(async (cwd: string) => projects[cwd]);
  setCloseState("a1", SAVED, { kind: "safe", detail: "" });
  setCloseState("a2", SAVED, { kind: "unsafe", detail: "still running" });
  setCloseState("b1", SAVED, { kind: "safe", detail: "" });
  onArchive = vi.fn(async () => true);
  onDelete = vi.fn(async () => true);
  onClose = vi.fn();
  onOpenSession = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(
  extra: {
    busy?: string[];
    openSessionIds?: string[];
    activeSessionId?: string;
  } = {},
) {
  await act(async () => {
    root.render(
      createElement(SessionCleanup, {
        projectPaths: ["/p/alpha", "/p/beta"],
        activeSessionId: extra.activeSessionId,
        busySessionIds: new Set(extra.busy ?? []),
        approvalSessionIds: new Set<string>(),
        openSessionIds: extra.openSessionIds ?? [],
        onArchive: onArchive as never,
        onDelete: onDelete as never,
        onOpenSession: onOpenSession as never,
        onClose: onClose as never,
      }),
    );
  });
}

function buttonNamed(name: RegExp): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find((b) =>
    name.test(b.textContent ?? ""),
  );
  if (!button) {
    throw new Error(`no button matching ${name}`);
  }
  return button;
}

function rowBox(title: string): HTMLInputElement | undefined {
  const label = [...document.body.querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith(title),
  );
  return label?.querySelector("input") ?? undefined;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

it("gathers safe sessions from every project and ticks them", async () => {
  await mount();
  expect(listSessionsByProject).toHaveBeenCalledWith("/p/alpha");
  expect(listSessionsByProject).toHaveBeenCalledWith("/p/beta");
  expect(rowBox("a1")?.checked).toBe(true);
  expect(rowBox("b1")?.checked).toBe(true);
  expect(rowBox("a2")).toBeUndefined();
  expect(document.body.textContent).toContain("2 selected in 2 projects");
});

it("archives across projects, then Undo restores them", async () => {
  await mount();
  await click(buttonNamed(/^Archive 2$/));
  expect(onArchive.mock.calls).toEqual([
    ["a1", true],
    ["b1", true],
  ]);
  expect(document.body.textContent).toContain("Archived 2.");
  expect(rowBox("a1")).toBeUndefined();

  await click(buttonNamed(/^Undo$/));
  expect(onArchive).toHaveBeenCalledWith("a1", false);
  expect(onArchive).toHaveBeenCalledWith("b1", false);
  expect(document.body.textContent).toContain("Restored 2.");
  expect(rowBox("a1")?.checked).toBe(true);
});

it("leaves working and on-screen sessions out", async () => {
  await mount({ busy: ["a1"], activeSessionId: "b1" });
  expect(rowBox("a1")).toBeUndefined();
  expect(rowBox("b1")).toBeUndefined();
});

it("marks an open session and does not tick it", async () => {
  await mount({ openSessionIds: ["a1"] });
  expect(rowBox("a1")?.checked).toBe(false);
  expect(rowBox("b1")?.checked).toBe(true);
  expect(document.body.textContent).toContain("In a tab");
});

it("Everything starts with nothing ticked, and shows not-safe rows", async () => {
  await mount();
  await click(buttonNamed(/^Everything/));
  expect(rowBox("a2")?.checked).toBe(false);
  expect(rowBox("a1")?.checked).toBe(false);
  expect(buttonNamed(/^Archive$/).disabled).toBe(true);
});

it("a project box ticks only that project", async () => {
  await mount();
  await click(buttonNamed(/^Everything/));
  await click(rowBox("alpha")!);
  expect(rowBox("a1")?.checked).toBe(true);
  expect(rowBox("a2")?.checked).toBe(true);
  expect(rowBox("b1")?.checked).toBe(false);
});

it("keeps a session that moved on after the panel opened", async () => {
  await mount();
  projects["/p/alpha"] = [
    session("a1", "/p/alpha", { updatedAt: SAVED + 5000 }),
    session("a2", "/p/alpha"),
  ];
  await click(buttonNamed(/^Archive 2$/));
  expect(onArchive.mock.calls).toEqual([["b1", true]]);
  expect(document.body.textContent).toContain("Archived 1. Kept 1");
});

it("keeps a session another window holds", async () => {
  sessionHeldElsewhere.mockImplementation(async (id: string) => id === "a1");
  await mount();
  await click(buttonNamed(/^Archive 2$/));
  expect(sessionHeldElsewhere).toHaveBeenCalledWith("a1");
  expect(onArchive.mock.calls).toEqual([["b1", true]]);
  expect(document.body.textContent).toContain("Archived 1. Kept 1");
});

it("carries on past a session that could not be archived", async () => {
  onArchive.mockImplementationOnce(async () => false);
  await mount();
  await click(buttonNamed(/^Archive 2$/));
  expect(onArchive).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Archived 1. Kept 1");
});

it("says so when a project cannot be read", async () => {
  listSessionsByProject.mockImplementation(async (cwd: string) => {
    if (cwd === "/p/beta") {
      throw new Error("locked");
    }
    return projects[cwd];
  });
  await mount();
  expect(rowBox("a1")).toBeDefined();
  expect(document.body.textContent).toContain("Could not read 1 project.");
});

const deletedIds = () => onDelete.mock.calls.map(([row]) => row.id);

it("deletes nothing until the second click, and offers no undo", async () => {
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  expect(onDelete).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "Delete 2 sessions from 2 projects for good? Worktrees and branches stay.",
  );
  await click(buttonNamed(/^Delete 2 for good$/));
  expect(deletedIds()).toEqual(["a1", "b1"]);
  expect(onArchive).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Deleted 2.");
  expect(rowBox("a1")).toBeUndefined();
  expect(document.body.textContent).not.toContain("Undo");
});

it("Keep them backs out of a delete with the ticks intact", async () => {
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  await click(buttonNamed(/^Keep them$/));
  expect(onDelete).not.toHaveBeenCalled();
  expect(rowBox("a1")?.checked).toBe(true);
  expect(buttonNamed(/^Delete 2…$/).disabled).toBe(false);
});

it("locks the ticks while asking, so the count asked about holds", async () => {
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  expect(rowBox("a1")?.disabled).toBe(true);
  expect(buttonNamed(/^Everything/).disabled).toBe(true);
});

it("warns about not-safe and open sessions before deleting them", async () => {
  await mount({ openSessionIds: ["a1"] });
  await click(buttonNamed(/^Everything/));
  await click(rowBox("a1")!);
  await click(rowBox("a2")!);
  await click(buttonNamed(/^Delete 2…$/));
  expect(document.body.textContent).toContain(
    "Includes 1 marked not safe, 1 open in a tab.",
  );
});

it("keeps what moved on, what another window holds and what failed", async () => {
  projects["/p/gamma"] = [session("c1", "/p/gamma")];
  setCloseState("c1", SAVED, { kind: "safe", detail: "" });
  sessionHeldElsewhere.mockImplementation(async (id: string) => id === "b1");
  onDelete.mockImplementationOnce(async () => false);
  await act(async () => {
    root.render(
      createElement(SessionCleanup, {
        projectPaths: ["/p/alpha", "/p/beta", "/p/gamma"],
        busySessionIds: new Set<string>(),
        approvalSessionIds: new Set<string>(),
        openSessionIds: [],
        onArchive: onArchive as never,
        onDelete: onDelete as never,
        onClose: onClose as never,
      }),
    );
  });
  await click(buttonNamed(/^Delete 3…$/));
  projects["/p/gamma"] = [session("c1", "/p/gamma", { updatedAt: SAVED + 1 })];
  await click(buttonNamed(/^Delete 3 for good$/));
  expect(deletedIds()).toEqual(["a1"]);
  expect(document.body.textContent).toContain(
    "Deleted 0. Kept 3: changed, in use or could not be deleted.",
  );
});

it("looks again before each delete, so one changed meanwhile stays", async () => {
  onDelete.mockImplementationOnce(async () => {
    projects["/p/beta"] = [session("b1", "/p/beta", { pinned: true })];
    return true;
  });
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  await click(buttonNamed(/^Delete 2 for good$/));
  expect(deletedIds()).toEqual(["a1"]);
  expect(document.body.textContent).toContain("Deleted 1. Kept 1");
});

it("keeps one that went missing or could not be read before its delete", async () => {
  onDelete.mockImplementationOnce(async () => {
    listSessionsByProject.mockImplementation(async () => {
      throw new Error("locked");
    });
    return true;
  });
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  await click(buttonNamed(/^Delete 2 for good$/));
  expect(deletedIds()).toEqual(["a1"]);
  expect(document.body.textContent).toContain("Deleted 1. Kept 1");
});

it("keeps a session that started working after the question", async () => {
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  await mount({ busy: ["a1"] });
  await click(buttonNamed(/^Delete 2 for good$/));
  expect(deletedIds()).toEqual(["b1"]);
  expect(document.body.textContent).toContain("Deleted 1. Kept 1");
});

it("a failed delete throwing still keeps the row", async () => {
  onDelete.mockImplementation(async () => {
    throw new Error("locked");
  });
  await mount();
  await click(buttonNamed(/^Delete 2…$/));
  await click(buttonNamed(/^Delete 2 for good$/));
  expect(document.body.textContent).toContain("Deleted 0. Kept 2");
  expect(rowBox("a1")).toBeDefined();
});

it("has no Delete button when the app gives no way to delete", async () => {
  await act(async () => {
    root.render(
      createElement(SessionCleanup, {
        projectPaths: ["/p/alpha"],
        busySessionIds: new Set<string>(),
        approvalSessionIds: new Set<string>(),
        openSessionIds: [],
        onArchive: onArchive as never,
        onClose: onClose as never,
      }),
    );
  });
  expect(document.body.textContent).toContain("Archive");
  expect(document.body.textContent).not.toContain("Delete");
});

it("closes on Cancel", async () => {
  await mount();
  await click(buttonNamed(/^Cancel$/));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("opens on the first tab with something in it", async () => {
  setCloseState("a1", SAVED, { kind: "handover", detail: "" });
  setCloseState("b1", SAVED, null);
  await mount();
  expect(buttonNamed(/^Handover/).getAttribute("aria-pressed")).toBe("true");
  expect(rowBox("a1")?.checked).toBe(true);
});

it("stays on a tab once something was ticked", async () => {
  setCloseState("a1", SAVED, null);
  setCloseState("b1", SAVED, null);
  await mount();
  await click(buttonNamed(/^Safe to close/));
  expect(buttonNamed(/^Safe to close/).getAttribute("aria-pressed")).toBe("true");
});

it("opens filled from the last look, before the new read answers", async () => {
  await mount();
  act(() => root.unmount());
  root = createRoot(container);
  listSessionsByProject.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(rowBox("a1")).toBeDefined();
  expect(rowBox("b1")?.checked).toBe(true);
});

it("keeps a project's rows when reading it again fails", async () => {
  await mount();
  act(() => root.unmount());
  root = createRoot(container);
  listSessionsByProject.mockImplementation(async (cwd: string) => {
    if (cwd === "/p/beta") {
      throw new Error("no");
    }
    return projects[cwd];
  });
  await mount();
  expect(rowBox("b1")).toBeDefined();
  expect(document.body.textContent).toContain("Could not read 1 project");
});

it("shows where a handover is, from the project", async () => {
  setCloseState("a1", SAVED, {
    kind: "handover",
    detail: "/p/alpha/.claude/handoff.md",
  });
  await mount();
  await click(buttonNamed(/^Handover/));
  const path = document.body.querySelector("[data-fork-handover-path]");
  expect(path?.textContent).toBe(".claude/handoff.md");
});

it("goes to a session and closes the panel without ticking it", async () => {
  await mount();
  const before = rowBox("a1")?.checked;
  const go = document.body.querySelector('button[aria-label="Go to a1"]');
  await click(go!);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSession).toHaveBeenCalledWith("a1");
  expect(rowBox("a1")?.checked).toBe(before);
});

it("picks the tab only after unread sessions have been checked", async () => {
  vi.mocked(readSession).mockResolvedValueOnce({
    blocks: [
      { role: "assistant", text: "**Close:** Safe to close: nothing left to do." },
    ],
  } as never);
  projects = { "/p/alpha": [session("fresh", "/p/alpha", { updatedAt: SAVED + 1 })], "/p/beta": [] };
  await mount();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(buttonNamed(/^Safe to close/).getAttribute("aria-pressed")).toBe("true");
  expect(rowBox("fresh")?.checked).toBe(true);
});

it("takes archived sessions out of the shared list, so the count falls", async () => {
  await mount();
  expect(cachedCleanupRows(["/p/alpha", "/p/beta"]).map((r) => r.id)).toContain("a1");
  await click(buttonNamed(/^Archive 2$/));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const left = cachedCleanupRows(["/p/alpha", "/p/beta"]).map((r) => r.id);
  expect(left).not.toContain("a1");
  expect(left).not.toContain("b1");
  expect(left).toContain("a2");
});
