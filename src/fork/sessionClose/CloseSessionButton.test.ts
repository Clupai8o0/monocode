// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloseSessionButton } from "./CloseSessionButton";
import { AUTO_CLOSE_AFTER_S } from "./autoClose";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let visible = true;
let covered = false;
let observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];

class FakeObserver {
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    observers.push(callback);
  }
  observe() {
    for (const callback of observers) {
      callback([{ isIntersecting: visible }]);
    }
  }
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let keyN = 0;

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  covered = false;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 100, height: 20,
  } as DOMRect);
  // The offer is on top unless a test covers it.
  document.elementFromPoint = () =>
    covered ? document.body : container.querySelector("[data-fork-safe-close]");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onClose = vi.fn(() => Promise.resolve(true));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function render(replyKey = `s@${keyN++}`) {
  act(() => {
    root.render(createElement(CloseSessionButton, { replyKey, onClose }));
  });
  return replyKey;
}

function wait(seconds: number) {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
}

it("closes the session once the offer has been in view long enough", () => {
  render();
  wait(AUTO_CLOSE_AFTER_S - 1);
  expect(onClose).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Closes in 1s");
  wait(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  wait(AUTO_CLOSE_AFTER_S);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("waits while the offer is out of view or the window is in the background", () => {
  visible = false;
  render();
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).not.toHaveBeenCalled();

  act(() => observers[0]([{ isIntersecting: true }]));
  vi.mocked(document.hasFocus).mockReturnValue(false);
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).not.toHaveBeenCalled();

  vi.mocked(document.hasFocus).mockReturnValue(true);
  wait(AUTO_CLOSE_AFTER_S);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("waits while something covers the offer", () => {
  covered = true;
  render();
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).not.toHaveBeenCalled();
  covered = false;
  wait(AUTO_CLOSE_AFTER_S);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("does not try again when a failed close is mounted again", async () => {
  onClose.mockResolvedValue(false);
  const key = render();
  wait(AUTO_CLOSE_AFTER_S);
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => {});
  act(() => root.unmount());
  root = createRoot(container);
  render(key);
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-fork-auto-close]")).toBeNull();
});

it("holds at the last second when the pane is left just then", () => {
  render();
  wait(AUTO_CLOSE_AFTER_S - 1);
  // The tick lands before the observer hears the pane went away.
  covered = true;
  wait(1);
  expect(onClose).not.toHaveBeenCalled();
  covered = false;
  wait(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("Keep open stops it for that reply, even after the pane comes back", () => {
  const key = render();
  const keep = container.querySelector<HTMLButtonElement>("[data-fork-keep-open]");
  act(() => keep!.click());
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).not.toHaveBeenCalled();
  expect(container.querySelector("[data-fork-auto-close]")).toBeNull();

  act(() => root.unmount());
  root = createRoot(container);
  render(key);
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).not.toHaveBeenCalled();

  // A newer reply counts down again.
  render(`${key}-next`);
  wait(AUTO_CLOSE_AFTER_S);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("the button still closes at once", () => {
  render();
  const button = container.querySelector<HTMLButtonElement>("[data-fork-safe-close]");
  act(() => button!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("a refused close by hand does not start the countdown again", async () => {
  onClose.mockResolvedValue(false);
  render();
  const button = container.querySelector<HTMLButtonElement>("[data-fork-safe-close]");
  act(() => button!.click());
  await act(async () => {});
  wait(AUTO_CLOSE_AFTER_S * 2);
  expect(onClose).toHaveBeenCalledTimes(1);
  // Still there to try again by hand.
  act(() => button!.click());
  expect(onClose).toHaveBeenCalledTimes(2);
});
