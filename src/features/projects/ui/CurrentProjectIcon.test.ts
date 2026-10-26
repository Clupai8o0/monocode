// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CurrentProjectIcon } from "./CurrentProjectIcon";
import {
  notifyTabGroupLogosChanged,
  saveTabGroupLogo,
  saveTabGroupLogoBackground,
} from "../../workspace/model/tabGroups";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
const cwd = "/projects/panoptic";
let container: HTMLDivElement;
let root: Root;
function render(busy = false) {
  act(() => root.render(createElement(CurrentProjectIcon, { cwd, busy })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("monocode:tab-group:key-version", "2");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the saved brand alone when idle, and layers the active mascot only while working", () => {
  saveTabGroupLogo(cwd, "/app/logos/panoptic.png");
  render();
  expect(container.querySelector("img")).not.toBeNull();
  expect(container.querySelector("svg")).toBeNull();
  render(true);
  expect(container.querySelector("[data-working] .mascot-active")).not.toBeNull();
  expect(container.querySelector(".project-identity-logo")).not.toBeNull();
  render(false);
  expect(container.querySelector("[data-working]")).toBeNull();
  expect(container.querySelector("svg")).toBeNull();
});

it("uses the mascot when a saved image fails and retries a replacement at the same path", () => {
  saveTabGroupLogo(cwd, "/app/logos/panoptic.png");
  render(true);
  const image = container.querySelector("img")!;
  const first = image.src;
  act(() => image.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[data-logo-failed] .mascot-active")).not.toBeNull();
  act(() => notifyTabGroupLogosChanged());
  expect(container.querySelector("img")?.src).not.toBe(first);
  expect(container.querySelector("[data-logo-failed]")).toBeNull();
});

it("updates another window's logo, background, and cache revision", () => {
  render();
  expect(container.querySelector("img")).toBeNull();
  saveTabGroupLogo(cwd, "/app/logos/panoptic.png");
  saveTabGroupLogoBackground(cwd, "light");
  act(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "monocode:tab-group:logo-revision",
  })));
  expect(container.querySelector("img")?.style.backgroundColor).toBe("#ffffff");
  const first = container.querySelector("img")!.src;
  act(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "monocode:tab-group:logo-revision",
  })));
  expect(container.querySelector("img")!.src).not.toBe(first);
  saveTabGroupLogoBackground(cwd, "dark");
  act(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "monocode:tab-group:logo-backgrounds",
  })));
  expect(container.querySelector("img")?.style.backgroundColor).toBe("#181818");
});

it("pauses animation in hidden windows without a recurring timer", () => {
  saveTabGroupLogo(cwd, "/app/logos/panoptic.png");
  render(true);
  const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.querySelector("[data-document-hidden]")).not.toBeNull();
  visibility.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.querySelector("[data-document-hidden]")).toBeNull();
  visibility.mockRestore();
});
