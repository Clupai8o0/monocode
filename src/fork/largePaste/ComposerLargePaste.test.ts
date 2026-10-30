// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

import { Composer } from "../../features/sessions/ui/Composer";

const BIG = `Error: boom\n${"x".repeat(40 * 1024)}`;
let cleanup = () => {};

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockImplementation(async (command: string) => {
    if (command === "write_attachment") return "/tmp/pasted-error-boom.txt";
    return null;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const submit = vi.fn();
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: false,
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        executionCwd: "~",
        initialDraft: "Before ",
        hideTopBar: true,
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit: submit,
      }),
    ),
  );
  const textarea = container.querySelector("textarea")!;
  textarea.setSelectionRange(7, 7);
  return { container, textarea, submit };
}

async function paste(textarea: HTMLTextAreaElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      files: [],
      items: [],
    },
  });
  await act(async () => {
    textarea.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return event;
}

it("turns a huge paste into a file and keeps the draft", async () => {
  const { container, textarea } = await setup();
  const event = await paste(textarea, BIG);
  expect(event.defaultPrevented).toBe(true);
  expect(textarea.value).toBe("Before ");
  const note = container.querySelector("[data-fork-large-paste]")!;
  expect(note.textContent).toContain("40 KB pasted as a file");
  expect(note.textContent).toContain("Error: boom");
  expect(invoke).toHaveBeenCalledWith(
    "write_attachment",
    expect.objectContaining({ name: "pasted-error-boom.txt" }),
  );
});

it("puts it back as text in one click", async () => {
  const { container, textarea } = await setup();
  await paste(textarea, BIG);
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Paste as text instead")!
      .click();
  });
  expect(textarea.value).toBe(`Before ${BIG}`);
  expect(container.querySelector("[data-fork-large-paste]")).toBeNull();
});

it("keeps a draft that already ends with the same text", async () => {
  const { textarea } = await setup();
  await act(async () => {
    textarea.value = BIG;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  textarea.setSelectionRange(BIG.length, BIG.length);
  await paste(textarea, BIG);
  expect(textarea.value).toBe(BIG);
});

it("leaves a normal paste to the field", async () => {
  const { container, textarea } = await setup();
  const event = await paste(textarea, "just a few words");
  expect(event.defaultPrevented).toBe(false);
  expect(container.querySelector("[data-fork-large-paste]")).toBeNull();
});
