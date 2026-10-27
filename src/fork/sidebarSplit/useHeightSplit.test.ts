// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clampSize, loadStoredSize, saveStoredSize } from "./useHeightSplit";

describe("sidebar section sizes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saves, reads and resets a size", () => {
    expect(loadStoredSize("projectsHeight")).toBeNull();
    saveStoredSize("projectsHeight", 212.4);
    expect(localStorage.getItem("monocode.fork.sidebar.projectsHeight")).toBe(
      "212",
    );
    expect(loadStoredSize("projectsHeight")).toBe(212);
    saveStoredSize("projectsHeight", null);
    expect(loadStoredSize("projectsHeight")).toBeNull();
  });

  it("ignores a size it cannot use", () => {
    localStorage.setItem("monocode.fork.sidebar.width", "wide");
    expect(loadStoredSize("width")).toBeNull();
    localStorage.setItem("monocode.fork.sidebar.width", "-4");
    expect(loadStoredSize("width")).toBeNull();
  });

  it("clamps to the range, and to the minimum when the range is empty", () => {
    expect(clampSize(20, 48, 300)).toBe(48);
    expect(clampSize(500, 48, 300)).toBe(300);
    expect(clampSize(120.6, 48, 300)).toBe(121);
    expect(clampSize(200, 48, 10)).toBe(48);
  });
});
