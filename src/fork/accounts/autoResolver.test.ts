// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderRateLimits,
  RateLimitWindow,
} from "../../features/providers/model/rateLimits";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../features/providers/model/rateLimitsFetch", () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchCodexRateLimits: vi.fn(),
}));

import {
  AUTO_PROVIDER_ACCOUNT_ID,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerAccountChoice,
  providerAccountExists,
  saveProviderAccount,
  selectedProviderAccountId,
  selectProviderAccount,
  sessionProviderAccountId,
  setAutoProviderAccountResolver,
} from "../../features/providers/model/providerAccounts";
import {
  clearCachedRateLimits,
  setCachedRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import {
  mobileAccountChoice,
  mobileSessionAccountId,
} from "../../features/mobile/model/mobileProviderAccounts";
import { newSession } from "../../features/sessions/model/session";
import {
  exhaustedSwitchFor,
  installAutoAccountResolver,
} from "./autoResolver";

const PROJECT = "/Users/me/projects/app";

function window(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 };
}

function usage(usedPercent: number): ProviderRateLimits {
  return {
    provider: "claude",
    session: window(usedPercent),
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}

beforeEach(() => {
  localStorage.clear();
  clearCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID);
  clearCachedRateLimits("claude", "account-cx");
  installAutoAccountResolver();
  saveProviderAccount({ id: "account-cx", provider: "claude", label: "cx" });
});

describe("Auto account choice", () => {
  it("stores auto but every spawn-side reader gets a real account", () => {
    selectProviderAccount("claude", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    expect(providerAccountChoice("claude", PROJECT)).toBe("auto");
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(100));
    setCachedRateLimits("claude", "account-cx", usage(30));
    const spawned = selectedProviderAccountId("claude", PROJECT);
    expect(spawned).toBe("account-cx");
    expect(providerAccountExists("claude", spawned)).toBe(true);
    expect(mobileAccountChoice("claude", PROJECT, {})).toBe("account-cx");
  });

  it("between two ready accounts, picks the one with more left", () => {
    selectProviderAccount("claude", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(60));
    setCachedRateLimits("claude", "account-cx", usage(20));
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("account-cx");
    setCachedRateLimits("claude", "account-cx", usage(60));
    expect(selectedProviderAccountId("claude", PROJECT)).toBe(DEFAULT_PROVIDER_ACCOUNT_ID);
  });

  it("re-picks for each new session as usage changes", () => {
    selectProviderAccount("claude", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(10));
    setCachedRateLimits("claude", "account-cx", usage(10));
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("default");
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(90));
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("account-cx");
  });

  it("falls back to main without usage data or a resolver", () => {
    selectProviderAccount("claude", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("default");
    setAutoProviderAccountResolver(null);
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(100));
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("default");
    setAutoProviderAccountResolver(() => "account-removed");
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("default");
  });

  it("leaves explicit choices and other providers unchanged", () => {
    selectProviderAccount("claude", PROJECT, "account-cx");
    expect(providerAccountChoice("claude", PROJECT)).toBe("account-cx");
    expect(selectedProviderAccountId("claude", PROJECT)).toBe("account-cx");
    selectProviderAccount("codex", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    expect(providerAccountChoice("codex", PROJECT)).toBe("default");
    expect(selectedProviderAccountId("codex", PROJECT)).toBe("default");
  });
});

describe("exhaustedSwitchFor", () => {
  it("suggests main when the session's cx account is exhausted", () => {
    setCachedRateLimits("claude", "account-cx", usage(100));
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(50));
    expect(exhaustedSwitchFor("claude", "account-cx")).toBe("default");
  });

  it("suggests nothing while the session's account has headroom", () => {
    setCachedRateLimits("claude", "account-cx", usage(95));
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(10));
    expect(exhaustedSwitchFor("claude", "account-cx")).toBeNull();
  });

  it("suggests nothing when the other account is exhausted too", () => {
    setCachedRateLimits("claude", "account-cx", usage(100));
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(100));
    expect(exhaustedSwitchFor("claude", "account-cx")).toBeNull();
  });
});

describe("sessionProviderAccountId", () => {
  const user = (draft?: boolean) => ({ role: "user", draft });

  it("resolves Auto only for empty or new sessions; legacy ones stay on default", () => {
    selectProviderAccount("claude", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(100));
    setCachedRateLimits("claude", "account-cx", usage(30));
    const base = { cwd: PROJECT };
    // New: Auto picks cx.
    expect(sessionProviderAccountId("claude", { ...base, blocks: [] })).toBe("account-cx");
    // Only an unsent draft: still new.
    expect(sessionProviderAccountId("claude", { ...base, blocks: [user(true)] })).toBe(
      "account-cx",
    );
    // Sent turns but no id: a legacy session, which ran on default.
    expect(
      sessionProviderAccountId("claude", { ...base, blocks: [user(true), user()] }),
    ).toBe(DEFAULT_PROVIDER_ACCOUNT_ID);
    // Its own id always wins.
    expect(
      sessionProviderAccountId("claude", {
        ...base,
        providerAccountId: DEFAULT_PROVIDER_ACCOUNT_ID,
        blocks: [],
      }),
    ).toBe(DEFAULT_PROVIDER_ACCOUNT_ID);
    expect(
      sessionProviderAccountId("claude", {
        ...base,
        providerAccountId: "account-cx",
        blocks: [user()],
      }),
    ).toBe("account-cx");
  });

  it("is the same rule mobile uses", () => {
    selectProviderAccount("claude", PROJECT, AUTO_PROVIDER_ACCOUNT_ID);
    setCachedRateLimits("claude", DEFAULT_PROVIDER_ACCOUNT_ID, usage(100));
    setCachedRateLimits("claude", "account-cx", usage(30));
    const fresh = newSession("claude", PROJECT);
    expect(mobileSessionAccountId(fresh)).toBe("account-cx");
    const legacy = {
      ...fresh,
      blocks: [{ id: "u1", role: "user" as const, text: "hi" }],
    } as typeof fresh;
    expect(mobileSessionAccountId(legacy)).toBe(DEFAULT_PROVIDER_ACCOUNT_ID);
  });
});
