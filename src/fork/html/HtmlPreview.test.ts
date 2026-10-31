// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlPreview, HTML_PREVIEW_DELAY } from "./HtmlPreview";
import { HtmlViewShell } from "./HtmlViewShell";
import { htmlPreviewUrl, isHtmlPath } from "./htmlModel";

const invoke = vi.hoisted(() => vi.fn());
const preview = (id: string) => ({
  id,
  urlPath: `file-preview/${id}/index.html`,
  localAssets: true,
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string, scheme: string) =>
    `about:blank#${scheme}/${encodeURIComponent(path)}`,
}));

describe("HTML file preview", () => {
  let root: Root;
  let container: HTMLDivElement;
  let serial: number;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    serial = 0;
    invoke
      .mockReset()
      .mockImplementation(async (command: string) =>
        command === "fork_html_preview_create"
          ? preview(`preview-${++serial}`)
          : undefined,
      );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(source: string, active = true) {
    await act(async () =>
      root.render(
        createElement(HtmlPreview, {
          source,
          active,
          title: "design.html",
          path: "/repo/design.html",
          cwd: "/repo",
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
  }

  it("recognizes HTML files without treating source templates as pages", () => {
    expect(isHtmlPath("/repo/design.HTML")).toBe(true);
    expect(isHtmlPath("/repo/index.htm")).toBe(true);
    expect(isHtmlPath("/repo/template.html.ts")).toBe(false);
  });

  it("preserves native route hierarchy and encoded filename segments", () => {
    expect(htmlPreviewUrl("file-preview/token/my%20folder/index.html")).toBe(
      "about:blank#monoartifact/file-preview/token/my%20folder/index.html",
    );
  });

  it("renders scripts only in a native-served opaque sandbox", async () => {
    const source = "<!doctype html><script>window.secret = 1</script>";
    await render(source);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(frame.getAttribute("src")).toBe(
      "about:blank#monoartifact/file-preview/preview-1/index.html",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_create", {
      source,
      path: "/repo/design.html",
      cwd: "/repo",
    });
  });

  it("updates edited source and releases obsolete native snapshots", async () => {
    await render("<h1>First</h1>");
    await render("<h1>Updated</h1>");
    await act(async () =>
      container.querySelector("iframe")!.dispatchEvent(new Event("load")),
    );
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_remove", {
      id: "preview-1",
    });
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_create", {
      source: "<h1>Updated</h1>",
      path: "/repo/design.html",
      cwd: "/repo",
    });
    expect(container.querySelector("iframe")!.getAttribute("src")).toContain(
      "preview-2",
    );
  });

  it("releases a late result after a newer draft took over", async () => {
    let resolveOld!: (page: ReturnType<typeof preview>) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof preview>>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render("Old");
    await render("New");
    await act(async () => resolveOld(preview("late-old")));
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_remove", {
      id: "late-old",
    });
    expect(container.querySelector("iframe")!.getAttribute("src")).toContain(
      "preview-1",
    );
  });

  it("stops hidden scripts and does not allocate hidden previews", async () => {
    await render("Content");
    await render("Content", false);
    expect(container.querySelector("iframe")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_remove", {
      id: "preview-1",
    });
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "fork_html_preview_create",
      ),
    ).toHaveLength(1);
  });

  it("pauses preview scripts when the entire window becomes hidden", async () => {
    await render("Content");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("fork_html_preview_remove", {
      id: "preview-1",
    });
    hidden.mockRestore();
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("shows native errors and retries instead of remaining on a spinner", async () => {
    invoke.mockRejectedValueOnce(
      new Error("HTML preview supports files up to 8 MB."),
    );
    await render("Too big");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "8 MB",
    );
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    await act(async () => vi.advanceTimersByTimeAsync(HTML_PREVIEW_DELAY));
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("supports split and clears it when a line navigation arrives", async () => {
    const onModeChange = vi.fn();
    const shell = (navigationToken?: number) =>
      createElement(HtmlViewShell, {
        mode: "source",
        onModeChange,
        preview: createElement("div", { "data-preview": "" }),
        source: createElement("div", { "data-source": "" }),
        navigationToken,
      });
    await act(async () => root.render(shell()));
    const split = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Split",
    )!;
    await act(async () => split.click());
    expect(container.querySelector('[aria-selected="true"]')!.textContent).toBe(
      "Split",
    );
    expect(container.querySelector("[data-preview]")).not.toBeNull();
    await act(async () => root.render(shell(1)));
    expect(container.querySelector('[aria-selected="true"]')!.textContent).toBe(
      "Code",
    );
    expect(container.querySelector("[data-preview]")).toBeNull();
    expect(container.querySelector("[data-source]")).not.toBeNull();
  });
});
