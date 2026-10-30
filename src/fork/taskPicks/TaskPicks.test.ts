// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMarkdown } from "../../features/sessions/ui/AgentMarkdown";
import { ADD_TO_CHAT_EVENT } from "../../features/sessions/model/quoteDraft";
import { TaskPicksReply } from "./TaskPicks";
import { blockPicks } from "./picksStore";

const REPLY = [
  "Decisions for you:",
  "",
  "- [ ] Apply at A's line: run `B-READY.md` and see [the plan](https://example.com)",
  "- [ ] Hold: nothing ships",
  "  - a detail under it",
  "- [x] Already done",
  "- a plain bullet",
].join("\n");

let root: Root;
let container: HTMLDivElement;
let blockId: string;
let added: { text: string; mode: string }[];
const onAdd = (event: Event) => {
  added.push((event as CustomEvent).detail);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  blockId = crypto.randomUUID();
  added = [];
  window.addEventListener(ADD_TO_CHAT_EVENT, onAdd);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.removeEventListener(ADD_TO_CHAT_EVENT, onAdd);
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function renderReply(streaming = false, text = REPLY) {
  await act(async () => {
    root.render(
      createElement(
        TaskPicksReply,
        { blockId, streaming },
        createElement(AgentMarkdown, { text, streaming }),
      ),
    );
  });
}

const box = (label: string) =>
  container.querySelector<HTMLInputElement>(
    `input[data-task-label^="${label}"]`,
  )!;

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

describe("ticking the boxes in a reply", () => {
  it("makes each box tickable, with its item's own text", async () => {
    await renderReply();
    expect(container.querySelectorAll("input.task-pick")).toHaveLength(3);
    expect(box("Apply").disabled).toBe(false);
    expect(box("Apply").dataset.taskLabel).toBe(
      "Apply at A's line: run B-READY.md and see the plan",
    );
    expect(box("Hold").dataset.taskLabel).toBe("Hold: nothing ships");
    expect(box("Already").checked).toBe(true);
    expect(added).toEqual([]);
  });

  it("leaves Markdown outside a reply with fixed boxes", async () => {
    await act(async () => {
      root.render(createElement(AgentMarkdown, { text: REPLY }));
    });
    const inputs = container.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(3);
    expect([...inputs].every((input) => input.disabled)).toBe(true);
    expect(container.querySelector("input.task-pick")).toBeNull();
  });

  it("waits for the reply to finish", async () => {
    await renderReply(false);
    const label = box("Apply").dataset.taskLabel;
    await renderReply(true);
    expect(box("Apply").disabled).toBe(true);
    expect(box("Apply").dataset.taskLabel).toBe(label);
    await renderReply(false);
    expect(box("Apply").disabled).toBe(false);
  });

  it("ticks from the box and from the item's text", async () => {
    await renderReply();
    await click(box("Apply"));
    expect(box("Apply").checked).toBe(true);
    await click(box("Hold").closest("li")!);
    expect(box("Hold").checked).toBe(true);
    await click(box("Hold").closest("li")!);
    expect(box("Hold").checked).toBe(false);
  });

  it("does not tick from a link, a code span or a nested bullet", async () => {
    await renderReply();
    const apply = box("Apply").closest("li")!;
    await click(apply.querySelector("a")!);
    await click(apply.querySelector("code")!);
    expect(box("Apply").checked).toBe(false);
    await click(box("Hold").closest("li")!.querySelector("li")!);
    expect(box("Hold").checked).toBe(false);
  });

  it("keeps same-worded boxes apart, in one list and across lists", async () => {
    await renderReply(
      false,
      "## A\n\n- [ ] Review\n- [ ] Review\n\n## B\n\n- [ ] Review",
    );
    const boxes = () =>
      container.querySelectorAll<HTMLInputElement>("input.task-pick");
    expect(boxes()).toHaveLength(3);
    await click(boxes()[1]);
    await click(boxes()[2]);
    expect([...boxes()].map((input) => input.checked)).toEqual([
      false,
      true,
      true,
    ]);
    expect(added.map((pick) => pick.text)).toEqual(["Review", "Review"]);
  });

  it("does not tick while text is selected", async () => {
    await renderReply();
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
    } as Selection);
    await click(box("Hold").closest("li")!);
    expect(box("Hold").checked).toBe(false);
    vi.restoreAllMocks();
  });

  it("puts an option in the composer at once, and takes it back", async () => {
    await renderReply();
    await click(box("Apply"));
    expect(added).toEqual([
      {
        text: "Apply at A's line: run B-READY.md and see the plan",
        mode: "line",
      },
    ]);
    await click(box("Hold").closest("li")!);
    expect(added[1]).toEqual({ text: "Hold: nothing ships", mode: "line" });
    await click(box("Hold"));
    expect(added[2]).toEqual({
      text: "Hold: nothing ships",
      mode: "removeLine",
    });
    expect(added).toHaveLength(3);
  });

  it("adds nothing for a click that does not pick", async () => {
    await renderReply();
    const apply = box("Apply").closest("li")!;
    await click(apply.querySelector("a")!);
    await click(apply.querySelector("code")!);
    expect(added).toEqual([]);
  });

  it("keeps ticks when the reply is shown again", async () => {
    await renderReply();
    await click(box("Hold"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderReply();
    expect(box("Hold").checked).toBe(true);
    expect(Object.values(blockPicks(blockId)!)).toEqual(["ticked"]);
  });
});
