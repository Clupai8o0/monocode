// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectBranchesState } from "./useProjectBranches";
import { useProjectWorktrees } from "./useProjectWorktrees";

const mocks = vi.hoisted(() => ({
  gitBranches: vi.fn(),
  listWorktrees: vi.fn(),
  gitChanged: new Set<() => void>(),
}));

vi.mock("../../../platform/tauri/fs", () => ({
  gitBranches: mocks.gitBranches,
  subscribeGitChanged: (listener: () => void) => {
    mocks.gitChanged.add(listener);
    return () => mocks.gitChanged.delete(listener);
  },
}));

vi.mock("../model/worktrees", () => ({
  listWorktrees: mocks.listWorktrees,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

async function mount(element: ReturnType<typeof createElement>) {
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root?.render(element);
  });
}

async function gitChanged() {
  await act(async () => {
    for (const listener of mocks.gitChanged) listener();
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  mocks.gitBranches.mockReset();
  mocks.listWorktrees.mockReset();
  mocks.gitChanged.clear();
});

const branches = (current: string) => ({
  current,
  detached: false,
  branches: [{ name: current, current: true, remote: false }],
});

describe("useProjectBranchesState", () => {
  function Branches({ cwd }: { cwd: string }) {
    useProjectBranchesState(cwd, true);
    return null;
  }

  it("reads again when git changes during a read, once", async () => {
    let finish!: (value: unknown) => void;
    mocks.gitBranches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.gitBranches.mockResolvedValue(branches("after"));
    await mount(createElement(Branches, { cwd: "/during-a-read" }));
    expect(mocks.gitBranches).toHaveBeenCalledTimes(1);

    await gitChanged();
    await gitChanged();
    expect(mocks.gitBranches).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(branches("before"));
    });
    expect(mocks.gitBranches).toHaveBeenCalledTimes(2);
  });

  it("does not read again for a read nobody interrupted", async () => {
    mocks.gitBranches.mockResolvedValue(branches("main"));
    await mount(createElement(Branches, { cwd: "/quiet" }));
    await act(async () => {});
    expect(mocks.gitBranches).toHaveBeenCalledTimes(1);
  });
});

describe("useProjectWorktrees", () => {
  const list = (dirty: boolean) => ({
    worktrees: [{ path: "/repo", branch: "main", dirty }],
    defaultRoot: "/worktrees",
  });

  it("re-renders only when a reload finds something new", async () => {
    let renders = 0;
    function Worktrees() {
      useProjectWorktrees("/repo-renders");
      renders += 1;
      return null;
    }
    mocks.listWorktrees.mockResolvedValue(list(false));
    await mount(createElement(Worktrees));
    const afterFirstLoad = renders;

    await gitChanged();
    expect(mocks.listWorktrees).toHaveBeenCalledTimes(2);
    expect(renders).toBe(afterFirstLoad);

    mocks.listWorktrees.mockResolvedValue(list(true));
    await gitChanged();
    expect(renders).toBe(afterFirstLoad + 1);
  });

  it("clears an old error even when the list is unchanged", async () => {
    let seen: { data?: unknown; error?: string } = {};
    function Worktrees() {
      seen = useProjectWorktrees("/repo-error");
      return null;
    }
    mocks.listWorktrees.mockResolvedValueOnce(list(false));
    await mount(createElement(Worktrees));

    mocks.listWorktrees.mockRejectedValueOnce(new Error("git busy"));
    await gitChanged();
    expect(seen.error).toContain("git busy");

    mocks.listWorktrees.mockResolvedValueOnce(list(false));
    await gitChanged();
    expect(seen.error).toBeUndefined();
    expect(seen.data).toEqual(list(false));
  });
});
