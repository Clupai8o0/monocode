// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../../features/sessions/model/session";
import { BackgroundAgentsBar } from "./BackgroundAgentsBar";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

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
  vi.useRealTimers();
  invoke.mockReset();
});

it("opens the board when agents appear, and allows closing with Escape", () => {
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
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toContain("0 of 40 agents done");
  expect(container.querySelector("[data-fork-agents-board]")).not.toBeNull();
  act(() => toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // A new agent re-opens so parallel work stays visible like live sessions.
  render([...blocks, { ...blocks[0], id: "new-agent" }]);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("[data-fork-agents-board]")).not.toBeNull();
});

it("lists Claude background jobs with a stop button above the composer", () => {
  const onStopJob = vi.fn(async () => undefined);
  act(() =>
    root.render(
      createElement(BackgroundAgentsBar, {
        session: {
          busy: false,
          blocks: [],
          backgroundJobs: [
            {
              id: "job-1",
              title: "Dev server",
              command: "npm run dev",
              startedAt: Date.now() - 5_000,
            },
          ],
        },
        onStopJob,
      }),
    ),
  );
  const tray = container.querySelector<HTMLButtonElement>("button")!;
  expect(tray.textContent).toContain("1 job running");
  expect(tray.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Dev server");
  expect(container.textContent).toContain("npm run dev");
  const stop = container.querySelector<HTMLButtonElement>(
    '[aria-label="Stop Dev server"]',
  )!;
  // The action is spelled out, not left to a bare square.
  expect(stop.textContent).toBe("Stop");
  act(() => stop.click());
  expect(onStopJob).toHaveBeenCalledWith("job-1");
  expect(stop.textContent).toBe("Stopping…");
  expect(stop.getAttribute("aria-label")).toBe("Stopping Dev server");
  expect(stop.disabled).toBe(true);
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
  expect(tray.getAttribute("aria-expanded")).toBe("true");
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

const script = "cd /tmp\nnpm run build";
const outputPath = "/private/tmp/claude-501/p/s/tasks/b1.output";

/** Renders one running command and opens its row. */
async function openCommand(path: string | undefined = outputPath) {
  const blocks: Block[] = [
    {
      id: "command-1",
      role: "tool",
      text: "",
      tool: {
        kind: "execute",
        status: "in_progress",
        background: true,
        title: "cd /tmp",
        command: script,
        ...(path ? { outputPath: path } : {}),
      },
    },
  ];
  act(() => root.render(
    createElement(BackgroundAgentsBar, { session: { busy: true, blocks } }),
  ));
  // The tray opens itself when work appears.
  const row = container.querySelector<HTMLButtonElement>(
    "[data-fork-agents-board] button",
  )!;
  await act(async () => row.click());
  return { row, board: container.querySelector("[data-fork-agents-board]")! };
}

it("shows the whole script and follows the output while the row is open", async () => {
  vi.useFakeTimers();
  invoke.mockResolvedValue({ text: "\x1b[32mone\x1b[0m\n", truncated: false, size: 14 });
  const { row, board } = await openCommand();
  expect(invoke).toHaveBeenCalledWith("fork_task_output_tail", { path: outputPath });
  const [command, output] = board.querySelectorAll("pre");
  expect(command.textContent).toBe(script);
  expect(output.textContent).toBe("one");
  expect(board.textContent).not.toContain("when it finishes");

  invoke.mockResolvedValue({ text: "one\ntwo\n", truncated: true, size: 90000 });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(board.querySelectorAll("pre")[1].textContent).toBe("one\ntwo");
  expect(board.textContent).toContain("Earlier output left out.");

  // Closed, it stops reading.
  await act(async () => row.click());
  const reads = invoke.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(invoke.mock.calls.length).toBe(reads);
});

it("says so while a command has printed nothing, then shows what comes", async () => {
  vi.useFakeTimers();
  invoke.mockResolvedValue(null);
  const { board } = await openCommand();
  expect(board.textContent).toContain("No output yet.");
  expect(board.querySelectorAll("pre")).toHaveLength(1);
  invoke.mockResolvedValue({ text: "ready\n", truncated: false, size: 6 });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(board.textContent).not.toContain("No output yet.");
  expect(board.querySelectorAll("pre")[1].textContent).toBe("ready");
});

it("notes the cut even when the tail it can see hasn't changed", async () => {
  vi.useFakeTimers();
  invoke.mockResolvedValue({ text: "same\n", truncated: false, size: 5 });
  const { board } = await openCommand();
  expect(board.textContent).not.toContain("Earlier output left out.");
  invoke.mockResolvedValue({ text: "same\n", truncated: true, size: 90000 });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(board.textContent).toContain("Earlier output left out.");
});

it("doesn't call a long run of blank output no output", async () => {
  invoke.mockResolvedValue({ text: "\n\n", truncated: true, size: 90000 });
  const { board } = await openCommand();
  expect(board.textContent).not.toContain("No output yet.");
  expect(board.textContent).toContain("Earlier output left out.");
});

it("falls back to the transcript when the file can't be read, and stops trying", async () => {
  vi.useFakeTimers();
  invoke.mockRejectedValue("refused");
  const { board } = await openCommand();
  expect(board.textContent).toContain("when it finishes");
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("reads nothing for a command with no output file", async () => {
  const { board } = await openCommand("");
  expect(invoke).not.toHaveBeenCalled();
  expect(board.textContent).toContain("when it finishes");
});
