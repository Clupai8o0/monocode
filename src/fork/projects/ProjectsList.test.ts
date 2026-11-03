// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectsList } from "./ProjectsList";
import {
  loadProjectUse,
  markProjectsUsed,
  useProjectUseTracking,
} from "./projectUse";

vi.mock("../../features/projects/ui/CurrentProjectIcon", () => ({
  CurrentProjectIcon: () => null,
  useProjectLabel: (path: string) => path,
}));
vi.mock("../handoff/HandoffCard", () => ({ HandoffTag: () => null }));

const paths = ["/a", "/b", "/c"];
const recents = [
  { path: "/a", openedAt: 300 },
  { path: "/b", openedAt: 200 },
  { path: "/c", openedAt: 100 },
];
let container: HTMLDivElement;
let root: Root;

function renderList(cwd: string) {
  act(() =>
    root.render(
      createElement(ProjectsList, {
        paths,
        cwd,
        agents: [],
        recents,
        onSelectProject: () => undefined,
        onProjectContextMenu: () => undefined,
      }),
    ),
  );
}

function shownOrder(): (string | undefined)[] {
  return [...container.querySelectorAll<HTMLElement>("[data-project-path]")].map(
    (row) => row.dataset.projectPath,
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lifts the open project to the top and shows it", () => {
  renderList("/a");
  expect(shownOrder()).toEqual(["/a", "/b", "/c"]);
  const list = container.querySelector("ul")!;
  list.scrollTop = 40;
  renderList("/c");
  expect(shownOrder()).toEqual(["/c", "/a", "/b"]);
  expect(list.scrollTop).toBe(0);
});

it("leaves the rows still while the pointer is over the list", () => {
  renderList("/a");
  const section = container.querySelector("section")!;
  act(() => {
    section.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  });
  renderList("/c");
  expect(shownOrder()).toEqual(["/a", "/b", "/c"]);
  act(() => {
    section.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
  });
  expect(shownOrder()).toEqual(["/c", "/a", "/b"]);
});

it("reorders when a run marks a project as used", () => {
  renderList("/a");
  act(() => markProjectsUsed(["/c"], 900));
  expect(shownOrder()).toEqual(["/a", "/c", "/b"]);
});

it("marks a project used when its run starts and when it ends", () => {
  vi.useFakeTimers({ now: 1000 });
  const Tracker = ({ busy }: { busy: string[] }) => {
    useProjectUseTracking(busy);
    return null;
  };
  try {
    const render = (busy: string[]) =>
      act(() => root.render(createElement(Tracker, { busy })));
    render(["/a", "/a"]);
    expect(loadProjectUse()).toEqual({ "/a": 1000 });
    vi.setSystemTime(2000);
    render(["/a", "/b"]);
    expect(loadProjectUse()).toEqual({ "/a": 1000, "/b": 2000 });
    vi.setSystemTime(3000);
    render(["/b"]);
    expect(loadProjectUse()).toEqual({ "/a": 3000, "/b": 2000 });
  } finally {
    vi.useRealTimers();
  }
});

it("ignores a broken saved value", () => {
  localStorage.setItem("monocode.fork.projectUse", "not json");
  expect(loadProjectUse()).toEqual({});
  localStorage.setItem(
    "monocode.fork.projectUse",
    JSON.stringify({ "/a": 5, "/b": "soon" }),
  );
  expect(loadProjectUse()).toEqual({ "/a": 5 });
});

it("keeps only the newest projects", () => {
  for (let index = 0; index < 60; index += 1) {
    markProjectsUsed([`/p${index}`], index);
  }
  const kept = loadProjectUse();
  expect(Object.keys(kept)).toHaveLength(50);
  expect(kept["/p59"]).toBe(59);
  expect(kept["/p9"]).toBeUndefined();
});
