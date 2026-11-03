import { describe, expect, it, vi } from "vitest";
import { setCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import * as providerAccounts from "../../features/providers/model/providerAccounts";
import { continuePickOptions } from "./continueUsage";

describe("continuePickOptions", () => {
  it("passes cwd into provider account lookup", () => {
    const spy = vi
      .spyOn(providerAccounts, "selectedProviderAccountId")
      .mockReturnValue("work");
    setCachedRateLimits("claude", "work", {
      provider: "claude",
      status: "ok",
      updatedAt: Date.now(),
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: null },
      weekly: null,
      monthly: null,
      resetCredits: null,
      error: null,
    });
    continuePickOptions("/repo/a").usedPercent!("claude");
    expect(spy).toHaveBeenCalledWith("claude", "/repo/a");
    spy.mockRestore();
  });
});
