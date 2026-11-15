// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderRateLimits } from "../../features/providers/model/rateLimits";
import {
  clearCachedRateLimits,
  setCachedRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  renameProviderAccount,
  saveProviderAccount,
  selectProviderAccount,
  providerAccountChoice,
  selectedProviderAccountId,
} from "../../features/providers/model/providerAccounts";
import {
  newSession,
  retargetSessionToProject,
  type Session,
} from "../../features/sessions/model/session";
import { UsageFooter } from "./UsageFooter";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

const WORK_ACCOUNT_ID = "account-work";
const PROJECT_A = "/repo/a";
const PROJECT_B = "/repo/b";

function claudeLimits(): ProviderRateLimits {
  return {
    provider: "claude",
    session: {
      usedPercent: 10,
      windowMinutes: 300,
      resetsAt: Date.now() + 3_600_000,
    },
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renameProviderAccount("claude", DEFAULT_PROVIDER_ACCOUNT_ID, "Personal");
  saveProviderAccount({
    id: WORK_ACCOUNT_ID,
    provider: "claude",
    label: "Work",
  });
  setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, claudeLimits());
  setCachedRateLimits("claude", WORK_ACCOUNT_ID, claudeLimits());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  clearCachedRateLimits();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}

/** The footer as App renders it for the focused session. */
async function renderFooter(
  session: Session,
  onSelectAccount: (provider: string, accountId: string) => void = () => {},
) {
  await act(async () =>
    root.render(
      createElement(UsageFooter, {
        providers: [session.harness === "codex" ? "codex" : "claude"],
        project: session.cwd,
        session: {
          id: session.id,
          harness: session.harness,
          model: session.model,
          providerAccountId: session.providerAccountId,
        },
        onSelectAccount,
      }),
    ),
  );
}

async function openAccountPicker(provider = "Claude Code") {
  await act(async () => button(`${provider} usage details`).click());
  await act(async () => button(`Switch ${provider} account`).click());
}

describe("UsageFooter account per project", () => {
  it("keeps another project on its own account after a blank session moves there", async () => {
    selectProviderAccount("claude", PROJECT_B, DEFAULT_PROVIDER_ACCOUNT_ID);
    let session = newSession("claude", PROJECT_A, "claude:opus-5");

    // Project A: the user picks Work. App stamps the blank session
    // (onSelectProviderAccount) and the footer saves the project selection.
    await renderFooter(session, (_provider, accountId) => {
      session = { ...session, providerAccountId: accountId };
    });
    await openAccountPicker();
    await act(async () => button("Work").click());
    expect(selectedProviderAccountId("claude", PROJECT_A)).toBe(
      WORK_ACCOUNT_ID,
    );
    expect(session.providerAccountId).toBe(WORK_ACCOUNT_ID);

    // The user opens project B. App reuses the blank session (onCwdChange).
    session = retargetSessionToProject(session, PROJECT_B);
    expect(selectedProviderAccountId("claude", PROJECT_B)).toBe(
      DEFAULT_PROVIDER_ACCOUNT_ID,
    );

    await renderFooter(session);
    await openAccountPicker();
    expect(
      button("Personal · main (~/.claude)").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(button("Work").getAttribute("aria-pressed")).toBe("false");
  });

  it.each(["claude", "codex"] as const)(
    "offers Auto by default for new %s sessions",
    async (provider) => {
      saveProviderAccount({ id: WORK_ACCOUNT_ID, provider, label: "Work" });
      const limits = { ...claudeLimits(), provider };
      setCachedRateLimits(provider, "default", limits);
      setCachedRateLimits(provider, WORK_ACCOUNT_ID, limits);
      await renderFooter(newSession(provider, PROJECT_A));
      await openAccountPicker(provider === "claude" ? "Claude Code" : "Codex");
      const auto = [
        ...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ].find((item) => item.textContent?.startsWith("Auto"));
      expect(auto).toBeDefined();
      expect(auto!.getAttribute("aria-pressed")).toBe("true");
      await act(async () => button("Work").click());
      expect(providerAccountChoice(provider, PROJECT_A)).toBe(WORK_ACCOUNT_ID);
      await openAccountPicker(provider === "claude" ? "Claude Code" : "Codex");
      const chooseAuto = [
        ...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ].find((item) => item.textContent?.startsWith("Auto"));
      await act(async () => chooseAuto!.click());
      expect(providerAccountChoice(provider, PROJECT_A)).toBe("auto");
    },
  );
});
