import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  antigravityRoute,
  isRoutePaused,
  loadPausedRoutes,
  resetPausedRoutesCache,
} from "./pausedRoutes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("pausedRoutes", () => {
  beforeEach(() => {
    resetPausedRoutesCache();
    vi.mocked(invoke).mockReset();
  });

  it("matches route prefixes", () => {
    expect(antigravityRoute("gemini-4-carbon")).toBe("agy:gemini-4-carbon");
    const paused = { "agy:gemini": "competition" };
    expect(isRoutePaused("agy:gemini-4-carbon", paused)).toBe(true);
    expect(isRoutePaused("agy:gemini-3.8-flash-high", paused)).toBe(true);
    expect(isRoutePaused("agy:claude-sonnet-5-5", paused)).toBe(false);
  });

  it("fails open when invoke errors", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no tauri"));
    await expect(loadPausedRoutes()).resolves.toEqual({});
    expect(isRoutePaused("agy:gemini-4-carbon")).toBe(false);
  });

  it("keeps only string values from the fork map", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      "agy:gemini": "paused",
      "agy:other": 42,
      nested: { x: 1 },
    });
    await expect(loadPausedRoutes()).resolves.toEqual({ "agy:gemini": "paused" });
  });
});