// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function tool(id: string): Block {
  return {
    id,
    role: "tool",
    text: `Inspect ${id}`,
    tool: { kind: "shell", status: "completed" },
  };
}

describe("prose folded into the work trail", () => {
  it("marks a mid-turn note as process, leaving the answer at full strength", () => {
    const blocks: Block[] = [
      { id: "user", role: "user", text: "Keep me posted" },
      tool("t1"),
      { id: "note", role: "assistant", text: "Trying the other config." },
      tool("t2"),
      {
        id: "answer",
        role: "assistant",
        text: "The investigation is complete.",
      },
    ];
    act(() => root.render(createElement(AgentTranscript, { blocks })));

    // The trail stays collapsed until asked for, so none of what it holds —
    // the note included — is in the DOM yet.
    expect(container.querySelector(".zen-fold-prose")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show the work"]',
    )!;
    expect(toggle).not.toBeNull();

    act(() => toggle.click());

    // Only the mid-turn note carries the marker; the tool rows it sits
    // between stay ordinary rail entries.
    const prose = container.querySelectorAll(".zen-fold-prose");
    expect(prose).toHaveLength(1);
    expect(prose[0].textContent).toContain("Trying the other config.");
    expect(prose[0].textContent).not.toContain(
      "The investigation is complete.",
    );

    // The answer renders the same markdown root, outside the demoted wrapper.
    const answer = Array.from(
      container.querySelectorAll(".agent-markdown"),
    ).find((el) => el.textContent?.includes("The investigation is complete."));
    expect(answer).not.toBeUndefined();
    expect(answer?.closest(".zen-fold-prose")).toBeNull();
  });

  it("keeps a mid-turn link, prompt or question in view when the work folds", () => {
    const blocks: Block[] = [
      { id: "user-notes", role: "user", text: "Set it up" },
      tool("t1"),
      {
        id: "link",
        role: "assistant",
        text: "Sign in here: https://example.com/device",
      },
      tool("t2"),
      {
        id: "prompt",
        role: "assistant",
        text: "Paste this into the other session:\n\n```\nrun the build\n```",
      },
      tool("t3"),
      { id: "ask", role: "assistant", text: "Should I also push it?" },
      tool("t4"),
      { id: "note", role: "assistant", text: "Trying the other config." },
      tool("t5"),
      { id: "answer", role: "assistant", text: "All set." },
    ];
    act(() => root.render(createElement(AgentTranscript, { blocks })));

    const notes = Array.from(
      container.querySelectorAll("[data-reader-note]"),
    ).map((el) => el.textContent ?? "");
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("https://example.com/device");
    expect(notes[1]).toContain("run the build");
    expect(notes[2]).toContain("Should I also push it?");
    // Plain narration still folds away until the work is opened.
    expect(container.textContent).not.toContain("Trying the other config.");
    expect(container.textContent).toContain("All set.");

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Show the work"]')!
        .click(),
    );
    // Opening the work does not show the lifted notes a second time.
    const prose = Array.from(container.querySelectorAll(".zen-fold-prose"));
    expect(prose.map((el) => el.textContent)).toEqual([
      expect.stringContaining("Trying the other config."),
    ]);
  });

  it("keeps opened work open when the transcript mounts again", () => {
    const blocks: Block[] = [
      { id: "user-reopen", role: "user", text: "Look into it" },
      tool("r1"),
      { id: "note-reopen", role: "assistant", text: "Checking the logs." },
      tool("r2"),
      { id: "answer-reopen", role: "assistant", text: "Found it." },
    ];
    const props = { blocks, sessionId: "session-reopen" };
    act(() => root.render(createElement(AgentTranscript, props)));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Show the work"]')!
        .click(),
    );
    expect(container.textContent).toContain("Checking the logs.");

    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(AgentTranscript, props)));
    expect(
      container.querySelector('button[aria-label="Hide the work"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Checking the logs.");

    // Another session with the same turn starts folded, mounted fresh or
    // shown in the same transcript.
    act(() =>
      root.render(
        createElement(AgentTranscript, { blocks, sessionId: "third-session" }),
      ),
    );
    expect(
      container.querySelector('button[aria-label="Show the work"]'),
    ).not.toBeNull();
    act(() => root.render(createElement(AgentTranscript, props)));
    expect(
      container.querySelector('button[aria-label="Hide the work"]'),
    ).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(AgentTranscript, { blocks, sessionId: "other-session" }),
      ),
    );
    expect(
      container.querySelector('button[aria-label="Show the work"]'),
    ).not.toBeNull();
  });
});
