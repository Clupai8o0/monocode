// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageFooter } from "../../app/shell/UsageFooter";
import { clearCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import {
  idleRateLimits,
  RATE_LIMIT_POLL_MS,
} from "../../features/providers/model/rateLimits";

const fetches = vi.hoisted(() => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchCodexRateLimits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
}));
vi.mock("../../features/providers/model/rateLimitsFetch", () => fetches);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  localStorage.clear();
  clearCachedRateLimits();
  fetches.fetchCodexRateLimits.mockReset().mockImplementation(async () => ({
    ...idleRateLimits("codex"),
    status: "ok",
    updatedAt: Date.now(),
    weekly: {
      usedPercent: 99,
      windowMinutes: 10080,
      resetsAt: Date.now() + 86_400_000,
    },
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearCachedRateLimits();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount() {
  await act(async () =>
    root.render(createElement(UsageFooter, { providers: ["codex"] })),
  );
}

async function open() {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Codex usage details"]',
  );
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

it("refreshes seven-hour-old usage when its popup opens", async () => {
  await mount();
  vi.setSystemTime(Date.now() + 7 * 3_600_000);
  await open();
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Updated just now");
  await open();
  await open();
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
});

it("refreshes visible usage periodically and catches up on return from a hidden window", async () => {
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(RATE_LIMIT_POLL_MS));
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => vi.advanceTimersByTimeAsync(2 * RATE_LIMIT_POLL_MS));
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(3);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(3);
});

it("keeps the old age and shows refresh failure instead of claiming fresh quota", async () => {
  await mount();
  vi.setSystemTime(Date.now() + 7 * 3_600_000);
  fetches.fetchCodexRateLimits.mockResolvedValue({
    ...idleRateLimits("codex"),
    status: "error",
    error: "Timed out",
    updatedAt: Date.now(),
  });
  await open();
  expect(document.body.textContent).toContain("Updated 7h ago");
  expect(document.body.textContent).toContain("Couldn’t refresh");
});
