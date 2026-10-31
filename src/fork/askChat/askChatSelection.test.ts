// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeDiff,
  describeHeading,
  describeNotebook,
  describePdf,
  describeTable,
  type AskChatDescribe,
} from "./askChatDescribe";
import { AskChatRegion } from "./AskChatRegion";
import { parseFrameMessage, withSelectionBridge } from "./htmlSelectionBridge";
import {
  readAskChatSelection,
  useAskChatSelection,
} from "./useAskChatSelection";
import type { Terminal } from "@xterm/xterm";
import { useOnlyOpenMenu } from "./useOnlyOpenMenu";
import { TERMINAL_REFERENCE, useTerminalAskChat } from "./useTerminalAskChat";
import { ADD_TO_CHAT_EVENT } from "../../features/sessions/model/quoteDraft";

function stubRangeRects() {
  const rect = new DOMRect(1, 2, 3, 4);
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue({
    length: 1,
    item: () => rect,
  } as unknown as DOMRectList);
}

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function rangeOver(start: Node, end: Node = start): Range {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.childNodes.length || (end.textContent ?? "").length);
  return range;
}

function text(root: HTMLElement, selector: string): Text {
  return root.querySelector(selector)!.firstChild as Text;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("describe functions", () => {
  it("finds the pages of a PDF selection", () => {
    const root = mount(
      `<div data-ask-page="3"><span id="a">alpha</span></div><div data-ask-page="4"><span id="b">beta</span></div>`,
    );
    const describePages = describePdf("report.pdf");
    expect(describePages(rangeOver(text(root, "#a")), root)?.reference).toBe(
      "report.pdf p. 3",
    );
    expect(
      describePages(rangeOver(text(root, "#a"), text(root, "#b")), root)
        ?.reference,
    ).toBe("report.pdf pp. 3-4");
  });

  it("does not count a page the selection only touches", () => {
    const root = mount(
      `<div data-ask-page="3"><span id="a">alpha</span></div><div data-ask-page="4"><span id="b">beta</span></div>`,
    );
    const range = document.createRange();
    range.setStart(text(root, "#a"), 0);
    range.setEnd(text(root, "#b"), 0);
    expect(describePdf("report.pdf")(range, root)?.reference).toBe(
      "report.pdf p. 3",
    );
  });

  it("finds notebook cells", () => {
    const root = mount(
      `<div data-ask-cell="4"><p id="a">one</p></div><div data-ask-cell="5"><p>two</p></div><div data-ask-cell="6"><p id="b">three</p></div>`,
    );
    expect(
      describeNotebook("nb.ipynb")(
        rangeOver(text(root, "#a"), text(root, "#b")),
        root,
      )?.reference,
    ).toBe("nb.ipynb cells 4-6");
  });

  it("uses the last heading at or before the selection's start", () => {
    const root = mount(
      `<h1>Top</h1><p id="a">one</p><h2>Install</h2><p id="b">two</p><h2>Use</h2><p id="c">three</p>`,
    );
    const describeGuide = describeHeading("guide.md");
    expect(describeGuide(rangeOver(text(root, "#b")), root)?.reference).toBe(
      "guide.md § Install",
    );
    expect(
      describeGuide(rangeOver(text(root, "#a"), text(root, "#c")), root)
        ?.reference,
    ).toBe("guide.md § Top");
  });

  it("gives diff lines, and flags a selection of only removed ones", () => {
    const root = mount(
      `<div data-ask-line="7" data-ask-path="a.ts" data-ask-removed id="a">old</div>
       <div data-ask-line="7" data-ask-path="a.ts" id="b">new</div>
       <div data-ask-line="8" data-ask-path="a.ts" id="c">next</div>
       <div data-ask-line="2" data-ask-path="b.ts" id="d">other</div>`,
    );
    const describeLines = describeDiff();
    expect(describeLines(rangeOver(text(root, "#a")), root)?.reference).toBe(
      "a.ts:7 (removed)",
    );
    expect(
      describeLines(rangeOver(text(root, "#b"), text(root, "#c")), root)
        ?.reference,
    ).toBe("a.ts:7-8");
    expect(
      describeLines(rangeOver(text(root, "#c"), text(root, "#d")), root)
        ?.reference,
    ).toBe("a.ts:8 to b.ts:2");
  });

  it("never makes one span out of old and new line numbers", () => {
    const root = mount(
      `<div data-ask-line="100" data-ask-path="a.ts" data-ask-removed id="a">old</div>
       <div data-ask-line="101" data-ask-path="a.ts" data-ask-removed>old2</div>
       <div data-ask-line="2" data-ask-path="a.ts" id="b">new</div>`,
    );
    expect(
      describeDiff()(rangeOver(text(root, "#a"), text(root, "#b")), root)
        ?.reference,
    ).toBe("a.ts:2 and removed lines 100-101");
  });

  it("offers nothing for a diff's file header", () => {
    const root = mount(`<p id="a">a.ts</p>`);
    expect(describeDiff()(rangeOver(text(root, "#a")), root)).toBeNull();
  });

  const table = `<table><tbody>
    <tr><th></th><th data-ask-column="0" data-ask-row="1">A</th><th data-ask-column="1" data-ask-row="1">B</th><th data-ask-column="2" data-ask-row="1">C</th></tr>
    <tr><td>2</td><td data-ask-column="0" data-ask-row="2">a2</td><td data-ask-column="1" data-ask-row="2" id="b2">b2 words</td><td data-ask-column="2" data-ask-row="2">c2</td></tr>
    <tr><td>9</td><td data-ask-column="0" data-ask-row="9">a9</td><td data-ask-column="1" data-ask-row="9">b9</td><td data-ask-column="2" data-ask-row="9" id="c9">c9</td></tr>
    <tr><td>4</td><td data-ask-column="0" data-ask-row="4" id="a4">a4</td><td data-ask-column="1" data-ask-row="4">b4</td><td data-ask-column="2" data-ask-row="4">c4</td></tr>
  </tbody></table>`;

  it("leaves a selection inside one cell as it is", () => {
    const root = mount(table);
    expect(
      describeTable("d.xlsx", "Sheet1")(rangeOver(text(root, "#b2")), root),
    ).toEqual({ reference: "d.xlsx Sheet1!B2" });
  });

  it("sends the rectangle between two corners, not the document-order run", () => {
    const root = mount(table);
    expect(
      describeTable("d.csv")(
        rangeOver(text(root, "#b2"), text(root, "#c9")),
        root,
      ),
    ).toEqual({
      reference: "d.csv B:C rows 2, 9",
      text: "b2 words\tc2\nb9\tc9",
      cells: expect.any(Array),
    });
  });

  it("keeps an empty corner cell's column in the rectangle", () => {
    const root = mount(
      `<table><tbody>
        <tr><td data-ask-column="1" data-ask-row="2" id="empty"></td><td data-ask-column="2" data-ask-row="2">c2</td></tr>
        <tr><td data-ask-column="1" data-ask-row="3">b3</td><td data-ask-column="2" data-ask-row="3" id="c3">c3</td></tr>
      </tbody></table>`,
    );
    const range = document.createRange();
    range.setStart(root.querySelector("#empty")!, 0);
    range.setEnd(text(root, "#c3"), 2);
    const description = describeTable("d.csv")(range, root);
    expect(description?.reference).toBe("d.csv B2:C3");
    expect(description?.text).toBe("\tc2\nb3\tc3");
  });

  it("makes a rectangle when the end column is left of the start", () => {
    const root = mount(table);
    const description = describeTable("d.csv")(
      rangeOver(text(root, "#c9"), text(root, "#a4")),
      root,
    );
    expect(description?.text).toBe("a9\tb9\tc9\na4\tb4\tc4");
    expect(description?.reference).toBe("d.csv A:C rows 4, 9");
  });
});

describe("readAskChatSelection", () => {
  const anywhere: AskChatDescribe = () => ({ reference: "file.md" });

  function select(range: Range): Selection {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  beforeEach(() => {
    stubRangeRects();
  });

  afterEach(() => vi.restoreAllMocks());

  it("quotes a selection inside the view", () => {
    const root = mount(`<p id="a">hello there</p>`);
    const result = readAskChatSelection(
      select(rangeOver(text(root, "#a"))),
      root,
      anywhere,
    );
    expect(result?.text).toBe("file.md:\n\n> hello there");
    expect(result?.rect.width).toBe(3);
  });

  it("ignores a selection in another pane, or one crossing out of this one", () => {
    const left = mount(`<p id="l">left</p>`);
    const right = mount(`<p id="r">right</p>`);
    const inRight = select(rangeOver(text(right, "#r")));
    expect(readAskChatSelection(inRight, left, anywhere)).toBeNull();
    const across = select(rangeOver(text(left, "#l"), text(right, "#r")));
    expect(readAskChatSelection(across, left, anywhere)).toBeNull();
  });

  it("pulls back a whole-paragraph selection that ends just outside", () => {
    const root = mount(`<p id="a">hello</p>`);
    const after = document.createElement("div");
    after.innerHTML = "<button>Copy</button>";
    document.body.append(after);
    const range = document.createRange();
    range.setStart(text(root, "#a"), 0);
    range.setEnd(after, 0);
    expect(readAskChatSelection(select(range), root, anywhere)?.text).toBe(
      "file.md:\n\n> hello",
    );
  });

  it("offers nothing when the view can't say where text came from", () => {
    const root = mount(`<p id="a">hello</p>`);
    expect(
      readAskChatSelection(
        select(rangeOver(text(root, "#a"))),
        root,
        () => null,
      ),
    ).toBeNull();
  });

  it("offers nothing for a blank or collapsed selection", () => {
    const root = mount(`<p id="a">   </p><p id="b">x</p>`);
    expect(
      readAskChatSelection(select(rangeOver(text(root, "#a"))), root, anywhere),
    ).toBeNull();
    const collapsed = document.createRange();
    collapsed.setStart(text(root, "#b"), 0);
    expect(readAskChatSelection(select(collapsed), root, anywhere)).toBeNull();
  });
});

describe("selection watcher", () => {
  let host: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) =>
      window.setTimeout(() => run(0), 0),
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) =>
      window.clearTimeout(id),
    );
    stubRangeRects();
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    reactRoot = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => reactRoot.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const describeFile: AskChatDescribe = () => ({ reference: "file.md" });

  async function selectInDocument(element: Element) {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(rangeOver(element.firstChild!));
    document.dispatchEvent(new Event("selectionchange"));
    await act(async () => vi.advanceTimersByTimeAsync(5));
  }

  it("holds back until the pointer lifts", async () => {
    const seen: (string | null)[] = [];
    function Probe({ root }: { root: HTMLElement }) {
      const { selection } = useAskChatSelection(root, describeFile, true);
      seen.push(selection?.text ?? null);
      return null;
    }
    const region = mount(`<p id="a">drag me</p>`);
    await act(async () =>
      reactRoot.render(createElement(Probe, { root: region })),
    );
    const paragraph = region.querySelector("#a")!;

    paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await selectInDocument(paragraph);
    expect(seen[seen.length - 1]).toBeNull();

    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await act(async () => vi.advanceTimersByTimeAsync(5));
    expect(seen[seen.length - 1]).toBe("file.md:\n\n> drag me");
  });

  it("stays off when disabled, as under the test runner", async () => {
    await act(async () =>
      reactRoot.render(
        createElement(AskChatRegion, {
          describe: describeFile,
          children: createElement("p", { id: "off" }, "words"),
        }),
      ),
    );
    await selectInDocument(host.querySelector("#off")!);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("sends the quote through the add-to-chat event and clears the selection", async () => {
    const received: { text: string; mode: string }[] = [];
    const listener = (event: Event) =>
      received.push((event as CustomEvent).detail);
    window.addEventListener(ADD_TO_CHAT_EVENT, listener);
    await act(async () =>
      reactRoot.render(
        createElement(AskChatRegion, {
          describe: describeFile,
          enabled: true,
          children: createElement("p", { id: "on" }, "words"),
        }),
      ),
    );
    await selectInDocument(host.querySelector("#on")!);
    const button = [...document.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Add to chat",
    )!;
    await act(async () => button.click());
    window.removeEventListener(ADD_TO_CHAT_EVENT, listener);
    expect(received).toEqual([{ text: "file.md:\n\n> words", mode: "plain" }]);
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });
});

describe("terminal selection", () => {
  it("offers on release, follows Select All, and closes when cleared", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) =>
      window.setTimeout(() => run(0), 0),
    );
    vi.useFakeTimers();
    let notify = () => {};
    let selected = "cargo test";
    const term = {
      getSelection: () => selected,
      hasSelection: () => selected.length > 0,
      onSelectionChange: (listener: () => void) => {
        notify = listener;
        return { dispose() {} };
      },
    } as unknown as Terminal;
    const outer = mount("<div></div>");
    let seen: string | null | undefined;
    function Probe() {
      const { selection } = useTerminalAskChat(
        { current: outer },
        { current: term },
        "t1",
        true,
      );
      seen = selection?.text ?? null;
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const reactRoot = createRoot(host);
    await act(async () => reactRoot.render(createElement(Probe)));

    outer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup"));
    await act(async () => vi.advanceTimersByTimeAsync(5));
    expect(seen).toBe(`${TERMINAL_REFERENCE}:\n\n> cargo test`);

    selected = "everything";
    await act(async () => notify());
    expect(seen).toBe(`${TERMINAL_REFERENCE}:\n\n> everything`);

    selected = "";
    await act(async () => notify());
    expect(seen).toBeNull();

    // Select All with no menu open still offers the button.
    selected = "all of it";
    await act(async () => notify());
    expect(seen).toBe(`${TERMINAL_REFERENCE}:\n\n> all of it`);

    await act(async () => reactRoot.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe("only one selection menu", () => {
  it("closes an open menu when another one opens", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const closed = vi.fn();
    function Probe({ other }: { other: boolean }) {
      useOnlyOpenMenu(true, closed);
      useOnlyOpenMenu(other, () => {});
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const reactRoot = createRoot(host);
    await act(async () =>
      reactRoot.render(createElement(Probe, { other: false })),
    );
    expect(closed).not.toHaveBeenCalled();
    await act(async () =>
      reactRoot.render(createElement(Probe, { other: true })),
    );
    expect(closed).toHaveBeenCalledTimes(1);
    await act(async () => reactRoot.unmount());
    vi.unstubAllGlobals();
  });
});

describe("HTML frame messages", () => {
  const frame = { left: 100, top: 50, right: 500, bottom: 450 };

  it("appends a bridge that cannot end its own script early", () => {
    const page = withSelectionBridge("<h1>Hi</h1>");
    expect(page.startsWith("<h1>Hi</h1>")).toBe(true);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page.endsWith("</script>")).toBe(true);
  });

  it("moves the page's rect into the app's coordinates", () => {
    const message = parseFrameMessage(
      { type: "monocode:html-selection", text: "hi", rect: [10, 20, 30, 40] },
      frame,
    );
    expect(message?.kind).toBe("selection");
    if (message?.kind !== "selection") return;
    expect([message.rect.left, message.rect.top]).toEqual([110, 70]);
    expect([message.rect.width, message.rect.height]).toEqual([30, 40]);
  });

  it("keeps a rect the page made up inside the frame", () => {
    const message = parseFrameMessage(
      {
        type: "monocode:html-selection",
        text: "hi",
        rect: [-9000, 9000, 9000, 9000],
      },
      frame,
    );
    if (message?.kind !== "selection") throw new Error("expected a selection");
    expect([message.rect.left, message.rect.top]).toEqual([100, 450]);
    expect(message.rect.right).toBeLessThanOrEqual(frame.right);
    expect(message.rect.bottom).toBeLessThanOrEqual(frame.bottom);
  });

  it("ignores other messages, and treats bad selections as none", () => {
    expect(parseFrameMessage("hello", frame)).toBeNull();
    expect(parseFrameMessage({ type: "other", text: "x" }, frame)).toBeNull();
    expect(
      parseFrameMessage({ type: "monocode:html-selection", text: "" }, frame),
    ).toEqual({ kind: "clear" });
    expect(
      parseFrameMessage(
        {
          type: "monocode:html-selection",
          text: "x",
          rect: [1, "2", 3, 4],
        },
        frame,
      ),
    ).toEqual({ kind: "clear" });
    expect(
      parseFrameMessage({ type: "monocode:html-selection", tab: true }, frame),
    ).toEqual({ kind: "tab" });
  });

  it("caps how much text the page can hand over", () => {
    const message = parseFrameMessage(
      {
        type: "monocode:html-selection",
        text: "x".repeat(300_000),
        rect: [0, 0, 1, 1],
      },
      frame,
    );
    if (message?.kind !== "selection") throw new Error("expected a selection");
    expect(message.text.length).toBe(200_000);
  });
});
