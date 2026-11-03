// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../../features/sessions/model/session";
import { BackgroundAgentsBar } from "./BackgroundAgentsBar";

vi.mock("../../features/sessions/ui/AgentTranscript", () => ({
  SubagentMascot: () => null,
  SubagentTrail: () => null,
}));

const container = document.createElement("div");
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("keeps many parallel agents collapsed until requested, and allows closing with Escape", () => {
  const blocks: Block[] = Array.from({ length: 40 }, (_, index) => ({
    id: `agent-${index}`,
    role: "tool",
    text: `Review ${index}`,
    tool: { kind: "agent", status: "in_progress" },
    agentRun: { name: `Reviewer ${index}`, steps: [] },
  }));
  const render = (items: Block[]) => act(() => root.render(
    createElement(BackgroundAgentsBar, { session: { busy: true, blocks: items } }),
  ));
  render(blocks);
  const toggle = container.querySelector<HTMLButtonElement>("button")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("0 of 40 agents done");
  expect(container.querySelector("[data-fork-agents-board]")).toBeNull();
  act(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("[data-fork-agents-board]")).not.toBeNull();
  act(() => toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  render([...blocks, { ...blocks[0], id: "new-agent" }]);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[data-fork-agents-board]")).toBeNull();
});

it("opens a running command to show all of it", () => {
  const command = "npm run build -- --a-very-long-flag-the-row-would-cut-off";
  const blocks: Block[] = [
    {
      id: "command-1",
      role: "tool",
      text: "",
      tool: {
        kind: "execute",
        status: "in_progress",
        background: true,
        title: command,
      },
    },
  ];
  act(() => root.render(
    createElement(BackgroundAgentsBar, { session: { busy: true, blocks } }),
  ));
  const tray = container.querySelector<HTMLButtonElement>("button")!;
  expect(tray.textContent).toContain("1 command running");
  act(() => tray.click());
  const row = container.querySelector<HTMLButtonElement>(
    "[data-fork-agents-board] button",
  )!;
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[data-fork-agents-board] pre")).toBeNull();
  act(() => row.click());
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const board = container.querySelector("[data-fork-agents-board]")!;
  expect(board.querySelector("pre")?.textContent).toBe(command);
  expect(board.textContent).toContain("when it finishes");
  act(() => row.click());
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(board.querySelector("pre")).toBeNull();
});
