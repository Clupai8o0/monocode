// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedRateLimits,
  getCachedRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import {
  claudeUsageFromRateLimitEvent,
  publishClaudeStreamUsage,
} from "./claudeStreamUsage";

// Captured from `claude -p --output-format stream-json` (Claude Code 2.1).
const EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1793100000,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.25, resetsAt: 1793100000, status: "allowed" },
      seven_day: { utilization: 0.14, resetsAt: 1793682000, status: "allowed" },
    },
  },
};

// Before EVENT's 5-hour window resets, so both windows are still running.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1793090000 * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  clearCachedRateLimits();
});

describe("Claude stream usage", () => {
  it("reads both plan windows as percentages", () => {
    const usage = claudeUsageFromRateLimitEvent(EVENT, 1000);
    expect(usage?.status).toBe("ok");
    expect(usage?.updatedAt).toBe(1000);
    expect(usage?.session?.usedPercent).toBe(25);
    expect(usage?.session?.resetsAt).toBe(1793100000 * 1000);
    expect(usage?.weekly?.usedPercent).toBeCloseTo(14);
  });

  it("ignores events without window data", () => {
    expect(
      claudeUsageFromRateLimitEvent({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      }),
    ).toBeNull();
  });

  it("feeds the footer cache for the session's account", () => {
    publishClaudeStreamUsage(undefined, EVENT);
    expect(getCachedRateLimits("claude", "default").session?.usedPercent).toBe(
      25,
    );
    publishClaudeStreamUsage("work", EVENT);
    expect(getCachedRateLimits("claude", "work").weekly).not.toBeNull();
  });

  it("drops a saved window that has run out when the plan stops reporting it", () => {
    // A 5-hour window from before moving to a weekly-only plan (Ultra).
    publishClaudeStreamUsage(undefined, EVENT);
    publishClaudeStreamUsage(undefined, {
      type: "rate_limit_event",
      rate_limit_info: {
        rateLimitType: "seven_day",
        unifiedWindows: {
          seven_day: { utilization: 0.94, resetsAt: 1793682000 },
        },
      },
    });
    // Still running: kept, as for an event that carries only one window.
    expect(getCachedRateLimits("claude", "default").session?.usedPercent).toBe(25);
    // Past its reset with no fresh reading: gone.
    vi.setSystemTime(1793100001 * 1000);
    publishClaudeStreamUsage(undefined, {
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          seven_day: { utilization: 0.95, resetsAt: 1793682000 },
        },
      },
    });
    const usage = getCachedRateLimits("claude", "default");
    expect(usage.session).toBeNull();
    expect(usage.weekly?.usedPercent).toBeCloseTo(95);
  });

  it("keeps the other window when an event carries only one", () => {
    publishClaudeStreamUsage(undefined, EVENT);
    publishClaudeStreamUsage(undefined, {
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.5, resetsAt: 1793100000 },
        },
      },
    });
    const usage = getCachedRateLimits("claude", "default");
    expect(usage.session?.usedPercent).toBe(50);
    expect(usage.weekly?.usedPercent).toBeCloseTo(14);
  });

  it("publishes utilization from a rejected rate_limit_event", () => {
    publishClaudeStreamUsage(undefined, {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 1, resetsAt: 1793100000, status: "rejected" },
          seven_day: { utilization: 0.4, resetsAt: 1793682000, status: "allowed" },
        },
      },
    });
    const usage = getCachedRateLimits("claude", "default");
    expect(usage.session?.usedPercent).toBe(100);
    expect(usage.weekly?.usedPercent).toBeCloseTo(40);
  });
});
