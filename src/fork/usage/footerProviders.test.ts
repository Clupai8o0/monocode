// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageFooter } from "../../app/shell/UsageFooter";
import {
  emitHarnessAvailability,
  setHarnessAvailability,
} from "../../integrations/harness/core/availabilityState";
import { HARNESSES } from "../../features/sessions/model/session";
import { savePickerProviderVisible } from "../../features/sessions/model/models";
import { setProjectProviderHidden } from "../../features/sessions/model/projectProviders";
import {
  saveProviderAccount,
  selectProviderAccount,
} from "../../features/providers/model/providerAccounts";
import { clearCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import { idleRateLimits } from "../../features/providers/model/rateLimits";
import { saveShowRemainingUsage } from "../../features/settings/model/displayPrefs";

const fetches = vi.hoisted(() => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchCodexRateLimits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
}));
vi.mock("../../features/providers/model/rateLimitsFetch", () => fetches);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

let container: HTMLDivElement;
let root: Root;

function installed(codex: boolean) {
  setHarnessAvailability(
    Object.fromEntries(
      HARNESSES.map((id) => [id, id === "claude" || (id === "codex" && codex)]),
    ) as Parameters<typeof setHarnessAvailability>[0],
  );
  emitHarnessAvailability();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  saveShowRemainingUsage(false);
  installed(true);
  clearCachedRateLimits();
  fetches.fetchClaudeRateLimits.mockReset().mockResolvedValue({
    ...idleRateLimits("claude"),
    status: "ok",
    session: { usedPercent: 31, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 62, windowMinutes: 10080, resetsAt: null },
  });
  fetches.fetchCodexRateLimits.mockReset().mockResolvedValue({
    ...idleRateLimits("codex"),
    status: "ok",
    session: { usedPercent: 14, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 49, windowMinutes: 10080, resetsAt: null },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  clearCachedRateLimits();
  installed(false);
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(UsageFooter, {
        providers: ["claude"],
        session: { harness: "claude", providerAccountId: "default" },
        project: "/repo",
      }),
    ),
  );
}

function codexChip() {
  return container.querySelector<HTMLButtonElement>(
    '[aria-label="Codex usage details"]',
  );
}

it("shows Claude and Codex usage together while a Claude session is active", async () => {
  await render();
  const claude = container.querySelector(
    '[aria-label="Claude Code usage details"]',
  );
  expect(claude).not.toBeNull();
  expect(codexChip()).not.toBeNull();
  expect(codexChip()?.textContent).toContain("5h");
  expect(codexChip()?.textContent).toContain("wk");
  expect(codexChip()?.innerHTML).toContain("width: 14%");
  expect(codexChip()?.innerHTML).toContain("width: 49%");
  expect(fetches.fetchClaudeRateLimits).toHaveBeenCalledTimes(1);
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(1);
});

it("uses the project's Codex account without replacing the Claude session account", async () => {
  saveProviderAccount({ id: "account-work", provider: "codex", label: "Work" });
  selectProviderAccount("codex", "/repo", "account-work");
  await render();
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledWith("account-work");
  expect(fetches.fetchClaudeRateLimits).toHaveBeenCalledWith("default");
  expect(codexChip()?.textContent).toContain("Work");
});

it("follows installed providers and global/project visibility without extra fetches", async () => {
  installed(false);
  await render();
  expect(codexChip()).toBeNull();
  expect(fetches.fetchCodexRateLimits).not.toHaveBeenCalled();
  await act(async () => installed(true));
  expect(codexChip()).not.toBeNull();
  await act(async () => savePickerProviderVisible("codex", false));
  expect(codexChip()).toBeNull();
  await act(async () => savePickerProviderVisible("codex", true));
  expect(codexChip()).not.toBeNull();
  await act(async () => setProjectProviderHidden("/repo", "codex", true));
  expect(codexChip()).toBeNull();
  await act(async () => setProjectProviderHidden("/repo", "codex", false));
  expect(codexChip()).not.toBeNull();
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(1);
});

it("shows the actual unavailable state without fabricating usage windows", async () => {
  fetches.fetchCodexRateLimits.mockResolvedValue({
    ...idleRateLimits("codex"),
    status: "unavailable",
    error: "Codex not signed in",
  });
  await render();
  expect(codexChip()?.textContent).toContain("not connected");
  expect(codexChip()?.textContent).not.toContain("5h");
  expect(codexChip()?.textContent).not.toContain("wk");
});

it("keeps another active provider's sign-in control beside the plan balances", async () => {
  await act(async () =>
    root.render(
      createElement(UsageFooter, {
        providers: [],
        session: { harness: "grok", authRequired: true },
        project: "/repo",
      }),
    ),
  );
  expect(codexChip()).not.toBeNull();
  expect(
    container.querySelector('[aria-label="Grok Build sign-in required"]'),
  ).not.toBeNull();
});
