// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeView, parties } from "../../../tests/browser/fixtures/messageLogView";
import type { MessageLogView } from "./messageLogView";
import { layoutMap } from "./MessageMap";
import { MessagesWindow, type MessagesWindowProps } from "./MessagesWindow";
import { filterRows, sourceLines } from "./messagesFilter";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function render(over: Partial<MessagesWindowProps> = {}, view: MessageLogView = fakeView()) {
  const props: MessagesWindowProps = {
    view,
    onClose: vi.fn(),
    onWindowChange: vi.fn(),
    onOpenSession: vi.fn(),
    onCopy: vi.fn(() => Promise.resolve()),
    onSendAgain: vi.fn(),
    onDismiss: vi.fn(),
    onRestore: vi.fn(),
    onOpenHomeLab: vi.fn(),
    formatTime: (at) => new Date(at).toISOString().slice(11, 16),
    ...over,
  };
  act(() => root.render(createElement(MessagesWindow, props)));
  return props;
}

const rowIds = () => [...document.querySelectorAll("[data-feed-row]")].map((el) => el.getAttribute("data-feed-row"));

function button(name: string | RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((el) =>
    typeof name === "string" ? el.textContent?.trim() === name : name.test(el.textContent ?? ""),
  );
  if (!found) {
    throw new Error(`no button ${name}`);
  }
  return found;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("MessagesWindow", () => {
  it("lists rows newest first with status, route and counts", () => {
    render();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Messages");
    expect(rowIds()).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);
    const dropped = document.querySelector('[data-feed-row="r4"]')!;
    expect(dropped.textContent).toContain("Dropped");
    expect(dropped.textContent).toContain("Relay");
    expect(dropped.textContent).toContain("Vivobook");
    expect(dropped.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("problem");
    expect(document.querySelector('[data-feed-row="r2"] [data-tone]')?.getAttribute("data-tone")).toBe("held");
    expect(document.querySelector('[data-feed-row="r6"] [data-tone]')?.getAttribute("data-tone")).toBe("waiting");
    expect(document.querySelector("[data-counts]")?.textContent).toBe(
      "8 messages, 2 problems, 3 between machines in the last 24 hours",
    );
  });

  it("filters to problems and to a machine, and changes the window", () => {
    const props = render();
    click(button("Problems only"));
    expect(rowIds()).toEqual(["r3", "r4"]);
    expect(document.querySelector("[data-counts]")?.textContent).toContain("2 shown of 8 messages");
    click(button("Problems only"));
    click(button("Vivobook"));
    expect(rowIds()).toEqual(["r4", "r5", "r6", "r7"]);
    click(button("7d"));
    expect(props.onWindowChange).toHaveBeenCalledWith("7d");
  });

  it("expands a row to its full message, status and trail, and opens a session", () => {
    const props = render();
    const row = document.querySelector('[data-feed-row="r4"]')!;
    const toggle = row.querySelector("button[aria-expanded]")!;
    expect(row.textContent).not.toContain("Relay trail");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toContain("Lost by the relay on Vivobook: Not picked up within 45 s");
    expect(row.textContent).toContain("Dropped on Vivobook: Not picked up within 45 s");
    click(button("Open lab-runner"));
    expect(props.onOpenSession).toHaveBeenCalledWith("mono-9");
    click(button("Open monocode-ui"));
    expect(props.onOpenSession).toHaveBeenCalledWith("mono-1");
  });

  it("filters the feed to a session picked on the map", () => {
    render();
    click(document.querySelector('[role="tab"]:not([aria-selected="true"])')!);
    const node = document.querySelector(`[data-map-node="${parties.runner.key}"]`)!;
    expect(document.querySelectorAll("[data-map-place]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-map-edge]").length).toBeGreaterThan(0);
    click(node);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Feed");
    expect(rowIds()).toEqual(["r4", "r5", "r7"]);
    expect(document.body.textContent).toContain("Only lab-runner");
    click(document.querySelector('[aria-label^="Show every session"]')!);
    expect(rowIds()).toHaveLength(8);
  });

  it("opens on a request's filters", () => {
    render({ initial: { partyKey: parties.panoptic.key, problemsOnly: false } });
    expect(rowIds()).toEqual(["r1", "r2", "r5", "r8"]);
  });

  it("shows the warning with a way to the Home lab", () => {
    const props = render();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("The relay is off on Vivobook");
    click(button("Open Home lab"));
    expect(props.onOpenHomeLab).toHaveBeenCalled();
  });

  it("gives a lost message ways to send it again, copy it, and dismiss it", async () => {
    const props = render();
    click(document.querySelector('[data-feed-row="r3"] button')!);
    const actions = () => document.querySelector('[data-feed-row="r3"] [data-row-actions]')!;
    expect([...actions().querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Send again…",
      "Copy text",
      "Open monocode-ui",
      "Dismiss",
    ]);
    click(button("Send again…"));
    const r3 = props.view.rows.find((r) => r.id === "r3")!;
    expect(props.onSendAgain).toHaveBeenCalledWith(r3.preview);
    await act(async () => {
      button("Copy text").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(props.onCopy).toHaveBeenCalledWith(r3.preview);
    expect(button("Copied")).toBeTruthy();
    click(button("Dismiss"));
    expect(props.onDismiss).toHaveBeenCalledWith("r3");
  });

  it("offers Restore on a dismissed row, and only Copy on a delivered one", () => {
    const view = fakeView();
    view.rows = view.rows.map((r) =>
      r.id === "r3" ? { ...r, problem: false, settled: true, dismissed: true } : r,
    );
    const props = render({}, view);
    click(document.querySelector('[data-feed-row="r3"] button')!);
    click(button("Restore"));
    expect(props.onRestore).toHaveBeenCalledWith("r3");
    click(document.querySelector('[data-feed-row="r8"] button')!);
    const labels = [...document.querySelectorAll('[data-feed-row="r8"] [data-row-actions] button')].map(
      (b) => b.textContent,
    );
    expect(labels[0]).toBe("Copy text");
    expect(labels).not.toContain("Send again…");
    expect(labels).not.toContain("Dismiss");
    expect(document.querySelector("[data-preview-cut]")).toBeNull();
  });

  it("says when the kept text is only the start of the message", () => {
    const view = fakeView();
    view.rows = view.rows.map((r) => (r.id === "r3" ? { ...r, preview: "x".repeat(600) } : r));
    render({}, view);
    click(document.querySelector('[data-feed-row="r3"] button')!);
    expect(document.querySelector("[data-preview-cut]")?.textContent).toContain("first 600 characters");
  });

  it("says plainly when it is loading, empty, or filtered to nothing", () => {
    render({}, fakeView({ rows: [], loading: true, warning: undefined }));
    expect(document.body.textContent).toContain("Reading messages…");
    render({}, fakeView({ rows: [], loading: false, warning: undefined }));
    expect(document.body.textContent).toContain("No messages between sessions in the last 24 hours.");
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});

describe("messagesFilter", () => {
  it("matches either end for place and party", () => {
    const view = fakeView();
    expect(filterRows(view.rows, { problemsOnly: false, placeId: "local", partyKey: null })).toHaveLength(7);
    expect(filterRows(view.rows, { problemsOnly: true, placeId: null, partyKey: parties.ghost.key })).toHaveLength(1);
  });

  it("words machines that are not answering, unless the warning already does", () => {
    const view = fakeView({ warning: undefined });
    view.sources[1] = { ...view.sources[1], state: "offline" };
    expect(sourceLines(view, () => "10:30")).toEqual(["Vivobook isn't answering. Its messages are from 10:30."]);
    view.sources[1] = { ...view.sources[1], state: "old-host" };
    expect(sourceLines(view, () => "")).toEqual(["Vivobook needs a host update to show its messages."]);
    expect(sourceLines({ ...view, warning: "Vivobook needs a host update to show its messages." }, () => "")).toEqual([]);
  });
});

describe("layoutMap", () => {
  it("puts each place in a column, unknown ends last, and drops edges with no ends", () => {
    const layout = layoutMap(fakeView().graph);
    expect(layout.columns.map((column) => column.id)).toEqual(["local", "m1", "?"]);
    expect(layout.edges).toHaveLength(8);
    const problems = layoutMap(fakeView().graph, true);
    expect(problems.edges.map(({ edge }) => edge.to)).toEqual([parties.ghost.key, parties.runner.key]);
  });
});
