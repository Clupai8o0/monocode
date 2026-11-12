// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke, loadRateLimits, loginHarness, cachedLimits } = vi.hoisted(
  () => ({
    invoke: vi.fn(),
    loadRateLimits: vi.fn(() => Promise.resolve()),
    loginHarness: vi.fn(() => Promise.resolve()),
    cachedLimits: {
      forAccount: (_provider: string, _accountId: string) => ({
        provider: "claude",
        status: "ok" as const,
        session: {
          usedPercent: 10,
          windowMinutes: 300,
          resetsAt: null as number | null,
        },
        weekly: null,
        monthly: null,
        resetCredits: null,
        updatedAt: 0,
        error: null as string | null,
      }),
    },
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../features/providers/model/rateLimitsCache", () => ({
  loadRateLimits,
  useCachedRateLimits: (provider: string, accountId: string) =>
    cachedLimits.forAccount(provider, accountId),
}));
vi.mock("../../integrations/harness/core/auth", () => ({
  loginHarness,
}));

import { AllUsagePanel } from "./AllUsage";
import { saveProviderAccount } from "../../features/providers/model/providerAccounts";

let container: HTMLDivElement;
let root: Root;
const memory = new Map<string, string>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => memory.clear(),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    },
  });
  invoke.mockReset();
  loadRateLimits.mockClear();
  loginHarness.mockClear().mockResolvedValue(undefined);
  cachedLimits.forAccount = (provider, accountId) => ({
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
    error: null,
  });
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

it("offers sign-in for a Codex account whose usage tokens expired", async () => {
  saveProviderAccount({
    id: "account-plus",
    provider: "codex",
    label: "limbusamaka@gmail.com",
  });
  cachedLimits.forAccount = (provider, accountId) =>
    provider === "codex" && accountId === "account-plus"
      ? {
          provider: "codex",
          status: "unavailable",
          session: null,
          weekly: null,
          monthly: null,
          resetCredits: null,
          updatedAt: Date.now(),
          error: "Codex not signed in",
        }
      : {
          provider,
          status: "ok",
          session: {
            usedPercent: 5,
            windowMinutes: 300,
            resetsAt: null,
          },
          weekly: null,
          monthly: null,
          resetCredits: null,
          updatedAt: 0,
          error: null,
        };
  invoke.mockResolvedValue({ status: "unavailable", message: "offline" });

  await act(async () => {
    root.render(createElement(AllUsagePanel));
  });
  await act(async () => {
    await Promise.resolve();
  });

  const codex = container.querySelector('[aria-label="Codex"]')!;
  expect(codex.textContent).toContain("Codex not signed in");
  const signIn = Array.from(codex.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Sign in"),
  );
  expect(signIn).toBeTruthy();
  await act(async () => {
    signIn!.click();
  });
  await vi.waitFor(() =>
    expect(loginHarness).toHaveBeenCalledWith("codex", "account-plus"),
  );
  expect(loadRateLimits).toHaveBeenCalledWith("codex", "account-plus", true);
});
