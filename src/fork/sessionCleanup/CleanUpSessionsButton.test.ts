// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listSessionsByProject = vi.fn();
vi.mock("../../features/sessions/data/sessionStore", async (load) => ({
  ...(await load<object>()),
  listSessionsByProject,
}));
vi.mock("../workspaces/workspaces", () => ({
  sessionHeldElsewhere: vi.fn(async () => false),
}));
vi.mock("../sessionRead", () => ({
  readSession: vi.fn(() => Promise.resolve(null)),
}));

const { CleanUpSessionsButton } = await import("./CleanUpSessionsButton");
const { setCloseState } = await import("../closeBadges/closeState");
const { resetCleanupRows } = await import("./cleanupRows");

const SAVED = Date.now() - 3_600_000;
const session = (id: string, cwd: string) => ({
  id,
  cwd,
  harness: "claude",
  title: id,
  updatedAt: SAVED,
});
const PROJECTS: Record<string, unknown[]> = {
  "/p/alpha": [session("a1", "/p/alpha"), session("a2", "/p/alpha")],
  "/p/beta": [session("b1", "/p/beta"), session("b2", "/p/beta")],
};

let container: HTMLDivElement;
let root: Root;

async function mount(busy: string[] = []) {
  await act(async () => {
    root.render(
      createElement(CleanUpSessionsButton, {
        projectPaths: Object.keys(PROJECTS),
        busySessionIds: new Set(busy),
        approvalSessionIds: new Set<string>(),
        openSessionIds: [],
        onArchive: async () => true,
      }),
    );
  });
  // The first scan waits a few seconds after the button appears.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
}

const button = () =>
  document.body.querySelector<HTMLButtonElement>("[data-fork-clean-up-sessions]")!;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  resetCleanupRows();
  listSessionsByProject.mockReset();
  listSessionsByProject.mockImplementation(async (cwd: string) => PROJECTS[cwd]);
  setCloseState("a1", SAVED, { kind: "safe", detail: "" });
  setCloseState("a2", SAVED, { kind: "unsafe", detail: "still going" });
  setCloseState("b1", SAVED, { kind: "handover", detail: "/p/beta/h.md" });
  setCloseState("b2", SAVED, null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("counts safe and handover sessions from every project", async () => {
  await mount();
  expect(button().textContent).toBe("2");
  expect(button().getAttribute("aria-label")).toBe(
    "Clean up sessions, 2 ready to close",
  );
});

it("leaves a working session out of the count", async () => {
  await mount(["a1"]);
  expect(button().textContent).toBe("1");
});

it("shows no count when nothing is ready", async () => {
  setCloseState("a1", SAVED, null);
  setCloseState("b1", SAVED, null);
  await mount();
  expect(button().textContent).toBe("");
  expect(button().getAttribute("aria-label")).toBe("Clean up sessions");
});

it("one click opens the panel, with no menu in between", async () => {
  await mount();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  expect(document.body.querySelector("[data-fork-session-cleanup]")).not.toBeNull();
});

it("looks again when the panel closes", async () => {
  await mount();
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(0);
  });
  listSessionsByProject.mockClear();
  const cancel = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent === "Cancel",
  )!;
  await act(async () => {
    cancel.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(document.body.querySelector("[data-fork-session-cleanup]")).toBeNull();
  expect(listSessionsByProject).toHaveBeenCalledTimes(2);
});
