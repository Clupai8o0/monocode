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
  const grokReset = Date.now() + 3.5 * 60 * 60_000;
  invoke.mockImplementation((_command: string, args: { provider: string }) =>
    Promise.resolve(
      args.provider === "grok"
        ? {
            status: "ok",
            body: JSON.stringify({
              config: {
                creditUsagePercent: 24,
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  end: new Date(grokReset).toISOString(),
                },
              },
            }),
          }
        : args.provider === "deepseek"
        ? {
            status: "ok",
            body: JSON.stringify({
              balance_infos: [{ currency: "USD", total_balance: "1.95" }],
            }),
          }
        : args.provider === "cursor"
          ? {
              status: "ok",
              body: JSON.stringify({
                billingCycleEnd: "1794215782490",
                planUsage: {
                  autoPercentUsed: 22.6,
                  apiPercentUsed: 4,
                },
                displayMessage: "You've used 23% of your included usage",
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
  const cursor = container.querySelector('[aria-label="Cursor"]')!;
  expect(cursor.textContent).toContain("Auto");
  expect(cursor.textContent).toContain("API");
  expect(cursor.textContent).toContain(
    "You've used 23% of your included usage",
  );
  expect(container.textContent).toContain("$1.95 left");
  expect(container.textContent).toContain("muse is not installed");
  expect(container.textContent).toContain("agy timed out");
  expect(invoke).toHaveBeenCalledWith("fork_extra_usage", { provider: "grok" });
  const grok = container.querySelector('[aria-label="Grok"]')!;
  expect(grok.textContent).toContain("wk");
  expect(grok.textContent).toContain("24% used");
  expect(grok.textContent).toContain("3h");
  expect(container.textContent).not.toContain(
    "Grok Build doesn't report plan usage.",
  );
});
