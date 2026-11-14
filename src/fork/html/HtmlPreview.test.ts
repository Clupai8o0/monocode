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

  describe("when the native draft budget is full", () => {
    const MEMORY_FULL =
      "HTML preview memory is full. Close another HTML preview and retry.";
    const TOO_LARGE =
      "This HTML file is too large for the preview memory budget (32 MB). Open Code to edit it.";
    type Page = ReturnType<typeof preview>;
    type CreateResult = Page | string | Promise<Page>;

    /** Scripted create results; once exhausted, creates succeed as usual. */
    function scriptCreates(
      results: Array<() => CreateResult>,
      remove: () => Promise<void> = async () => undefined,
    ) {
      invoke.mockImplementation(async (command: string) => {
        if (command !== "fork_html_preview_create") {
          return remove();
        }
        const next = results.shift();
        const result = next ? next() : preview(`preview-${++serial}`);
        if (typeof result === "string") {
          throw result;
        }
        return result;
      });
    }
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const creates = () =>
      invoke.mock.calls.filter(
        ([command]) => command === "fork_html_preview_create",
      );
    const removed = () =>
      invoke.mock.calls
        .filter(([command]) => command === "fork_html_preview_remove")
        .map(([, args]) => (args as { id: string }).id);
    const frameSrc = () => container.querySelector("iframe")?.getAttribute("src");
    const alert = () => container.querySelector('[role="alert"]')?.textContent;

    it("frees the old draft, waits for the free, then retries once", async () => {
      await render("Old");
      const free = deferred<void>();
      scriptCreates([() => MEMORY_FULL], () => free.promise);
      await render("New");
      expect(removed()).toEqual(["preview-1"]);
      expect(creates()).toHaveLength(2);
      expect(frameSrc()).toBeUndefined();

      await act(async () => free.resolve());
      expect(creates()).toHaveLength(3);
      expect(creates()[2]![1]).toMatchObject({ source: "New" });
      expect(frameSrc()).toContain("preview-2");
      expect(alert()).toBeUndefined();

      await act(async () =>
        container.querySelector("iframe")!.dispatchEvent(new Event("load")),
      );
      expect(removed()).toEqual(["preview-1"]);
    });

    it("shows the error when the retry is also out of memory", async () => {
      await render("Old");
      scriptCreates([() => MEMORY_FULL, () => MEMORY_FULL]);
      await render("New");
      expect(creates()).toHaveLength(3);
      expect(alert()).toContain("memory is full");
      expect(frameSrc()).toBeUndefined();
    });

    it("does not retry when this preview has nothing to free", async () => {
      scriptCreates([() => MEMORY_FULL]);
      await render("Only");
      expect(creates()).toHaveLength(1);
      expect(alert()).toContain("memory is full");
    });

    it("does not retry a single source over the whole budget", async () => {
      await render("Old");
      scriptCreates([() => TOO_LARGE]);
      await render("Huge");
      expect(creates()).toHaveLength(2);
      expect(alert()).toContain("Open Code");
    });

    it("drops the retry when a newer edit arrives during the free", async () => {
      await render("Old");
      const free = deferred<void>();
      scriptCreates([() => MEMORY_FULL], () => free.promise);
      await render("Stale");
      await render("Newest");
      expect(frameSrc()).toContain("preview-2");
      await act(async () => free.resolve());

      const sources = creates().map(
        ([, args]) => (args as { source: string }).source,
      );
      expect(sources).toEqual(["Old", "Stale", "Newest"]);
      expect(frameSrc()).toContain("preview-2");
      expect(removed()).toEqual(["preview-1"]);
    });

    it("releases a late retry without touching the newer frame", async () => {
      await render("Old");
      const retry = deferred<Page>();
      scriptCreates([() => MEMORY_FULL, () => retry.promise]);
      await render("Stale");
      expect(creates()).toHaveLength(3);
      await render("Newest");
      expect(frameSrc()).toContain("preview-2");

      await act(async () => retry.resolve(preview("late-retry")));
      expect(removed()).toEqual(["preview-1", "late-retry"]);
      expect(frameSrc()).toContain("preview-2");
    });

    it("waits for a superseded create to be released before retrying", async () => {
      await render("Old");
      const superseded = deferred<Page>();
      scriptCreates([() => superseded.promise, () => MEMORY_FULL]);
      await render("Typing");
      await render("Typed");
      expect(creates()).toHaveLength(3);

      await act(async () => superseded.resolve(preview("superseded")));
      expect(removed()).toEqual(["preview-1", "superseded"]);
      expect(creates()).toHaveLength(4);
      expect(creates()[3]![1]).toMatchObject({ source: "Typed" });
      expect(frameSrc()).toContain("preview-2");
    });
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
