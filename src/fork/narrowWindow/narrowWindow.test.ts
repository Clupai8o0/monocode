// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  narrowState,
  onUserToggle,
  onWidth,
  useNarrowWindowSidebar,
} from "./narrowWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("onWidth", () => {
  it("hides an open sidebar when the window gets narrow, and brings it back", () => {
    const state = narrowState();
    expect(onWidth(state, 1200, true)).toBeNull();
    expect(onWidth(state, 650, true)).toBe("hide");
    expect(onWidth(state, 720, false)).toBeNull(); // between the lines
    expect(onWidth(state, 760, false)).toBe("show");
  });

  it("leaves a sidebar the user closed alone", () => {
    const state = narrowState();
    expect(onWidth(state, 650, false)).toBeNull();
    expect(onWidth(state, 1200, false)).toBeNull();
  });

  it("keeps a sidebar the user opened while narrow until the window is wide again", () => {
    const state = narrowState();
    onUserToggle(state, 650, true);
    expect(onWidth(state, 600, true)).toBeNull();
    expect(onWidth(state, 900, true)).toBeNull();
    expect(onWidth(state, 650, true)).toBe("hide");
  });

  it("does not bring back a sidebar the user closed after it was hidden", () => {
    const state = narrowState();
    expect(onWidth(state, 650, true)).toBe("hide");
    onUserToggle(state, 650, false);
    expect(onWidth(state, 1200, false)).toBeNull();
  });
});

describe("useNarrowWindowSidebar", () => {
  let root: Root | null = null;
  let toggle: (() => void) | null = null;
  let current = false;

  function Probe({ initial }: { initial: boolean }) {
    const [open, setOpen] = useState(initial);
    useNarrowWindowSidebar(open, setOpen);
    current = open;
    toggle = () => setOpen((value) => !value);
    return null;
  }

  function resize(width: number) {
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
  }

  function mount(width: number, initial: boolean) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(Probe, { initial })));
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it("hides on a narrow start and restores when widened", () => {
    mount(650, true);
    expect(current).toBe(false);
    resize(1200);
    expect(current).toBe(true);
  });

  it("lets the user open a closed sidebar while narrow and keeps it open", () => {
    mount(650, false);
    act(() => toggle!());
    expect(current).toBe(true);
    resize(640);
    expect(current).toBe(true);
  });

  it("restores the sidebar when narrow and wide arrive before React commits", () => {
    mount(1200, true);
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 650, configurable: true });
      window.dispatchEvent(new Event("resize"));
      Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(current).toBe(true);
    // Nothing stale is left to mistake the user's next toggle for its own.
    resize(650);
    expect(current).toBe(false);
    act(() => toggle!()); // user opens it while narrow
    resize(640);
    expect(current).toBe(true);
  });

  it("does not restore a sidebar the user closed", () => {
    mount(1200, true);
    resize(650);
    expect(current).toBe(false);
    act(() => toggle!()); // user opens
    act(() => toggle!()); // and closes
    resize(1200);
    expect(current).toBe(false);
  });
});
