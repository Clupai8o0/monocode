// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptySession } from "./EmptySession";

// The arcade loads on demand, so these wait for it. Its real drawing isn't under
// test here, and needs a canvas this environment doesn't have.
vi.mock("../../terminal/ui/TerminalGridBackground", () => ({
  TerminalGridBackground: () => createElement("canvas"),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("empty session background", () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });

  async function render(hasChatBackground: boolean)
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(EmptySession, { cwd: "/work/demo", hasChatBackground }));
    });
    return host;
  }

  it("renders the arcade when no chat background is selected", async () => {
    const host = await render(false);
    await vi.waitFor(() => expect(host.querySelector("canvas")).not.toBeNull());
  });

  it("does not render the arcade over a selected chat background", async () => {
    const host = await render(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector("canvas")).toBeNull();
  });
});
