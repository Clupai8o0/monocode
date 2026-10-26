// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { Storage } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEditor } from "./FileEditor";
import { FilePane } from "./FilePane";
import {
  newEditorPane,
  newFileTab,
  type EditorPane,
} from "../../workspace/model/layout";
import { invalidateWatchedFiles } from "../model/fileWatch";
import { HTML_PREVIEW_DELAY } from "../../../fork/html/HtmlPreview";

const disk = vi.hoisted(() => ({ content: "<h1>Original</h1>", serial: 0 }));
const invoke = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command === "read_text_file") return disk.content;
    if (command === "stat_files") return [];
    if (command === "fork_html_preview_create") {
      const id = `preview-${++disk.serial}`;
      return {
        id,
        urlPath: `file-preview/${id}/index.html`,
        localAssets: true,
      };
    }
    if (command === "fork_html_preview_remove") return;
    if (command === "git_diff_files") return { files: [] };
    if (command === "git_file_diff")
      return {
        original: "",
        current: disk.content,
        binary: false,
        tooLarge: false,
      };
    throw new Error(`Unexpected command: ${command}`);
  }),
);
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
  convertFileSrc: (path: string) => `about:blank#${path}`,
}));

describe("HTML editor integration", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new Storage());
    localStorage.setItem("monocode.fileViewMode", "source");
    disk.content = "<h1>Original</h1>";
    invoke.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function open(
    path: string,
    options: { showDiff?: boolean; line?: number } = {},
  ) {
    await act(async () =>
      root.render(
        createElement(FileEditor, {
          path,
          cwd: "/repo",
          active: true,
          showDiff: options.showDiff,
          navigation: options.line
            ? { line: options.line, column: 1, token: 1 }
            : null,
          onDirtyChange: () => {},
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
  }

  function selected() {
    return container.querySelector(
      '[aria-label="HTML view"] [aria-selected="true"]',
    )?.textContent;
  }

  async function renderPane(
    pane: EditorPane,
    focused: boolean,
    visible: boolean,
  ) {
    await act(async () =>
      root.render(
        createElement(FilePane, {
          pane,
          focused,
          visible,
          showTabs: false,
          dirtyFileIds: new Set<string>(),
          fileErrorCounts: new Map<string, number>(),
          sessions: [],
          onFocus: () => {},
          onSelectFile: () => {},
          onCloseFile: () => {},
          onCloseOtherFiles: () => {},
          onDirtyChange: () => {},
          onErrorCountChange: () => {},
          onReorderFiles: () => {},
          onOpenFile: () => {},
          onUpdatePlan: () => {},
          onBuildPlan: () => {},
        }),
      ),
    );
    await act(async () => vi.dynamicImportSettled());
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
  }

  it("keeps visible HTML running when focus moves away but pauses hidden tabs", async () => {
    const first = newFileTab("/repo/visible.html", "/repo");
    const second = newFileTab("/repo/another.html", "/repo");
    const pane = { ...newEditorPane(first), files: [first, second] };
    await renderPane(pane, true, true);
    const frame = container.querySelector(
      'iframe[title="HTML preview: visible.html"]',
    );
    expect(frame).not.toBeNull();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    const allocations = invoke.mock.calls.filter(
      ([command]) => command === "fork_html_preview_create",
    ).length;

    await renderPane(pane, false, true);
    expect(
      container.querySelector('iframe[title="HTML preview: visible.html"]'),
    ).toBe(frame);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "fork_html_preview_create",
      ),
    ).toHaveLength(allocations);

    await renderPane(pane, false, false);
    expect(container.querySelector("iframe")).toBeNull();
    await renderPane({ ...pane, activeFileId: second.id }, false, true);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(
      container.querySelector('iframe[title="HTML preview: another.html"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('iframe[title="HTML preview: visible.html"]'),
    ).toBeNull();
  });

  it("opens HTML in Preview even when other text previews last used source", async () => {
    await open("/repo/design.html");
    expect(selected()).toBe("Preview");
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(localStorage.getItem("monocode.fileViewMode")).toBe("source");
  });

  it("keeps line links and review tabs in Code", async () => {
    await open("/repo/line.htm", { line: 1 });
    expect(selected()).toBe("Code");
    expect(container.querySelector("iframe")).toBeNull();
    await open("/repo/review.html", { showDiff: true });
    expect(selected()).toBe("Code");
  });

  it("reloads the rendered page when an agent changes the file", async () => {
    const path = "/repo/reloaded.html";
    await open(path);
    disk.content = "<h1>Agent changed this</h1>";
    await act(async () => invalidateWatchedFiles([path]));
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_create", {
      source: disk.content,
      path,
      cwd: "/repo",
    });
  });

  it("updates the preview from unsaved edits while Split is open", async () => {
    await open("/repo/live.html");
    const split = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Split",
    )!;
    await act(async () => split.click());
    const view = EditorView.findFromDOM(
      container.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () =>
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: "<h1>Live edit</h1>",
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
    expect(selected()).toBe("Split");
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_create", {
      source: "<h1>Live edit</h1>",
      path: "/repo/live.html",
      cwd: "/repo",
    });
  });
});
