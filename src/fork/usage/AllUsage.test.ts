// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const loadRateLimits = vi.fn(() => Promise.resolve());
vi.mock("../../features/providers/model/rateLimitsCache", () => ({
  loadRateLimits,
  useCachedRateLimits: (provider: string, accountId: string) => ({
    provider,
    status: "ok",
    session: {
      usedPercent: accountId === "default" ? 95 : 10,
      windowMinutes: 300,
      resetsAt: null,
    },
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: 0,
  }),
}));

const { AllUsagePanel } = await import("./AllUsage");
const { saveProviderAccount } =
  await import("../../features/providers/model/providerAccounts");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  invoke.mockReset();
  loadRateLimits.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists every Claude account and each other agent's usage", async () => {
  saveProviderAccount({
    id: "account-second",
    provider: "claude",
    label: "Second",
  });
  invoke.mockImplementation((_command: string, args: { provider: string }) =>
    Promise.resolve(
      args.provider === "deepseek"
        ? {
            status: "ok",
            body: JSON.stringify({
              balance_infos: [{ currency: "USD", total_balance: "1.95" }],
            }),
          }
        : args.provider === "muse"
          ? { status: "unavailable", message: "muse is not installed" }
          : { status: "error", message: "agy timed out" },
    ),
  );
  await act(async () => {
    root.render(createElement(AllUsagePanel));
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(loadRateLimits).toHaveBeenCalledWith("claude", "default", false);
  expect(loadRateLimits).toHaveBeenCalledWith(
    "claude",
    "account-second",
    false,
  );
  const claude = container.querySelector('[aria-label="Claude Code"]')!;
  expect(claude.textContent).toContain("main");
  expect(claude.textContent).toContain("Second");
  expect(container.textContent).toContain("$1.95 left");
  expect(container.textContent).toContain("muse is not installed");
  expect(container.textContent).toContain("agy timed out");
  expect(container.textContent).toContain(
    "Grok Build doesn't report plan usage.",
  );
});
