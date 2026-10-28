// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalSession,
  ExternalSessionsTarget,
} from "./externalSessionsModel";
import { useExternalSessions, readExternalSession } from "./externalSessionsStore";
import { continueFromHandoff } from "../handoff/handoffStore";
import {
  ElsewhereGroup,
  elsewhereTarget,
  sessionLabel,
  viewerStillOpen,
} from "./ElsewhereGroup";
import { ExternalSessionViewer } from "./ExternalSessionViewer";

vi.mock("./externalSessionsStore", () => ({
  useExternalSessions: vi.fn(),
  readExternalSession: vi.fn(),
}));
vi.mock("../handoff/handoffStore", () => ({
  continueFromHandoff: vi.fn(() => true),
}));
vi.mock("../../features/sessions/ui/AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) =>
    createElement("div", { "data-md": "" }, text),
}));
vi.mock("../../platform/tauri/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

const target: ExternalSessionsTarget = {
  kind: "local",
  projectId: "/p",
  cwd: "/p",
};

const running: ExternalSession = {
  id: "abcdef1234567",
  projectId: "/p",
  source: "claude-cx",
  cwd: "/p",
  branch: "main",
  state: "running",
  updatedAt: Date.now() - 5 * 60_000,
  note: "fixing tests",
  hasTranscript: true,
};
const handed: ExternalSession = {
  id: "s2",
  projectId: "/p",
  source: "claude",
  name: "monocode-16",
  cwd: "/p",
  state: "handed-over",
  handoffPath: ".claude/handoff-api.md",
  hasTranscript: true,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function mockList(sessions: ExternalSession[], supported = true) {
  vi.mocked(useExternalSessions).mockReturnValue({
    sessions,
    supported,
    loading: false,
    refresh: () => {},
  });
}

async function render(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(node);
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(readExternalSession).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ElsewhereGroup", () => {
  it("is hidden when unsupported or empty", async () => {
    mockList([running], false);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    expect(container.innerHTML).toBe("");
    mockList([]);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    expect(container.innerHTML).toBe("");
  });

  it("starts collapsed, expands, and remembers it", async () => {
    mockList([running, handed]);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    expect(container.textContent).toContain("Elsewhere2");
    expect(container.querySelector("[data-fork-elsewhere-row]")).toBeNull();
    click(container.querySelector("button[aria-expanded]"));
    const rows = container.querySelectorAll("[data-fork-elsewhere-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("cx abcdef12cxmain5m ago");
    expect(rows[0].getAttribute("title")).toBe("fixing tests");
    expect(rows[1].textContent).toBe("monocode-16");
    expect(rows[1].querySelector("[aria-label='Handed over']")).not.toBeNull();
    expect(localStorage.getItem("monocode.fork.elsewhereOpen")).toContain("/p");
  });

  it("keeps the viewer only for the same project while the group shows", () => {
    const open = { key: "/p", session: running };
    expect(viewerStillOpen(open, "/p", [running, handed])).toBe(true);
    expect(viewerStillOpen(open, "/q", [running])).toBe(false);
    // A session that ended stays open; its turns are already read.
    expect(viewerStillOpen(open, "/p", [handed])).toBe(true);
    expect(viewerStillOpen(open, "/p", [])).toBe(false);
    expect(viewerStillOpen(null, "/p", [running])).toBe(false);
  });

  it("closes the viewer for good when the list empties", async () => {
    vi.mocked(readExternalSession).mockReturnValue(new Promise(() => {}));
    localStorage.setItem("monocode.fork.elsewhereOpen", JSON.stringify({ "/p": true }));
    mockList([running]);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    click(document.querySelector("[data-fork-elsewhere-row]"));
    expect(document.querySelector("[data-fork-external-viewer]")).not.toBeNull();
    mockList([]);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    expect(document.querySelector("[data-fork-external-viewer]")).toBeNull();
    mockList([running]);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    expect(document.querySelector("[data-fork-external-viewer]")).toBeNull();
  });

  it("closes the viewer for good when the project changes", async () => {
    vi.mocked(readExternalSession).mockReturnValue(new Promise(() => {}));
    localStorage.setItem("monocode.fork.elsewhereOpen", JSON.stringify({ "/p": true }));
    mockList([running]);
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    click(document.querySelector("[data-fork-elsewhere-row]"));
    const other = { kind: "local" as const, projectId: "/q", cwd: "/q" };
    await render(createElement(ElsewhereGroup, { target: other, cwd: "/q" }));
    expect(document.querySelector("[data-fork-external-viewer]")).toBeNull();
    await render(createElement(ElsewhereGroup, { target, cwd: "/p" }));
    expect(document.querySelector("[data-fork-external-viewer]")).toBeNull();
  });

  it("labels sessions without a name", () => {
    expect(sessionLabel(running)).toBe("cx abcdef12");
    expect(
      sessionLabel({ ...handed, name: undefined, id: "handoff:.claude/handoff.md" }),
    ).toBe("claude handoff-api.md");
  });

  it("builds targets", () => {
    expect(elsewhereTarget("~")).toBeUndefined();
    expect(elsewhereTarget("/p")).toEqual(target);
    expect(elsewhereTarget("remote://m/p", { machineId: "m", projectId: "x" })).toEqual(
      { kind: "remote", machineId: "m", projectId: "x" },
    );
    expect(elsewhereTarget("remote://m/p", { projectId: "x" })).toBeUndefined();
  });
});

describe("ExternalSessionViewer", () => {
  it("opens on Handoff, shows the transcript and loads older turns", async () => {
    vi.mocked(readExternalSession)
      .mockResolvedValueOnce({
        turns: [
          { role: "user", text: "do it" },
          { role: "tool", text: "Bash ls\nmore" },
          { role: "assistant", text: "**done**" },
        ],
        before: 10,
        handoff: { path: ".claude/handoff-api.md", text: "## NOW" },
      })
      .mockResolvedValueOnce({
        turns: [{ role: "user", text: "first" }],
        truncated: true,
      });
    await render(
      createElement(ExternalSessionViewer, {
        target,
        session: handed,
        cwd: "/p",
        onClose: () => {},
      }),
    );
    const tabs = () => [...document.querySelectorAll("[role=tab]")];
    expect(tabs().map((t) => t.textContent)).toEqual(["Handoff", "Transcript"]);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-md]")?.textContent).toBe("## NOW");
    click(tabs()[1]);
    expect(document.body.textContent).toContain("Bash ls");
    expect(document.body.textContent).not.toContain("more");
    const older = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Load older",
    );
    await act(async () => {
      older!.click();
    });
    expect(readExternalSession).toHaveBeenLastCalledWith(target, "s2", 10);
    const text = document.body.textContent ?? "";
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("do it"));
    expect(text).toContain("Some long text was shortened.");
    expect(text).not.toContain("Load older");
  });

  it("Continue here starts from the session's handoff", async () => {
    vi.mocked(readExternalSession).mockResolvedValue({ turns: [] });
    const onClose = vi.fn();
    await render(
      createElement(ExternalSessionViewer, {
        target,
        session: handed,
        cwd: "/p",
        onClose,
      }),
    );
    click(document.querySelector("[data-fork-external-continue]"));
    expect(continueFromHandoff).toHaveBeenCalledWith("/p", ".claude/handoff-api.md");
    expect(onClose).toHaveBeenCalled();
  });

  it("has no Handoff tab or Continue without a handoff", async () => {
    vi.mocked(readExternalSession).mockResolvedValue({ turns: [] });
    await render(
      createElement(ExternalSessionViewer, {
        target,
        session: running,
        cwd: "/p",
        onClose: () => {},
      }),
    );
    expect([...document.querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual([
      "Transcript",
    ]);
    expect(document.querySelector("[data-fork-external-continue]")).toBeNull();
  });

  it("keeps actions out of the tablist and moves tabs with arrow keys", async () => {
    vi.mocked(readExternalSession).mockResolvedValue({ turns: [] });
    await render(
      createElement(ExternalSessionViewer, {
        target,
        session: handed,
        cwd: "/p",
        onClose: () => {},
      }),
    );
    const list = document.querySelector("[role=tablist]")!;
    expect([...list.querySelectorAll("button")].every((b) => b.role === "tab")).toBe(true);
    const tabs = [...list.querySelectorAll<HTMLElement>("[role=tab]")];
    const panel = document.querySelector("[role=tabpanel]")!;
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    expect(tabs.every((t) => t.getAttribute("aria-controls") === panel.id)).toBe(true);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0]);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[1].id);
    expect(document.activeElement).toBe(tabs[1]);
    act(() => {
      tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
  });
});
