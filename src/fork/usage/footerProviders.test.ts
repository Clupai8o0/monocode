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

function claudeChip() {
  return container.querySelector('[aria-label="Claude Code usage details"]');
}

it("shows only the active session's provider", async () => {
  await render();
  expect(claudeChip()).not.toBeNull();
  expect(codexChip()).toBeNull();
  expect(fetches.fetchClaudeRateLimits).toHaveBeenCalledTimes(1);
  expect(fetches.fetchCodexRateLimits).not.toHaveBeenCalled();
});

it("shows no provider usage with no session open", async () => {
  await act(async () =>
    root.render(createElement(UsageFooter, { providers: [], project: "/repo" })),
  );
  expect(claudeChip()).toBeNull();
  expect(codexChip()).toBeNull();
  expect(fetches.fetchClaudeRateLimits).not.toHaveBeenCalled();
  expect(fetches.fetchCodexRateLimits).not.toHaveBeenCalled();
});

it("keeps another active provider's sign-in control, with no plan balances", async () => {
  await act(async () =>
    root.render(
      createElement(UsageFooter, {
        providers: [],
        session: { harness: "grok", authRequired: true },
        project: "/repo",
      }),
    ),
  );
  expect(claudeChip()).toBeNull();
  expect(codexChip()).toBeNull();
  expect(
    container.querySelector('[aria-label="Grok Build sign-in required"]'),
  ).not.toBeNull();
});
