import {
  mapUsageWindow,
  SESSION_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES,
  type ProviderRateLimits,
} from "../../features/providers/model/rateLimits";
import {
  getCachedRateLimits,
  setCachedRateLimits,
} from "../../features/providers/model/rateLimitsCache";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `utilization` arrives as a 0–1 fraction; the footer reads percent. */
function usageWindow(raw: unknown, minutes: number) {
  const rec = record(raw);
  const utilization = rec?.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null;
  }
  return mapUsageWindow(
    { used_percentage: utilization * 100, resets_at: rec?.resetsAt },
    minutes,
  );
}

/**
 * Fork: Claude Code reports the plan's 5-hour and weekly use in every
 * `rate_limit_event` (`rate_limit_info.unifiedWindows`). Reading it there
 * keeps the footer current without the usage endpoint, which Anthropic
 * rate-limits (HTTP 429) when it is asked too often.
 */
export function claudeUsageFromRateLimitEvent(
  rec: Record<string, unknown>,
  now = Date.now(),
): ProviderRateLimits | null {
  const windows = record(record(rec.rate_limit_info)?.unifiedWindows);
  if (!windows) return null;
  const session = usageWindow(windows.five_hour, SESSION_WINDOW_MINUTES);
  const weekly = usageWindow(windows.seven_day, WEEKLY_WINDOW_MINUTES);
  if (!session && !weekly) return null;
  return {
    provider: "claude",
    session,
    weekly,
    monthly: null,
    resetCredits: null,
    updatedAt: now,
    error: null,
    status: "ok",
  };
}

export function publishClaudeStreamUsage(
  accountId: string | undefined,
  rec: Record<string, unknown>,
): void {
  const usage = claudeUsageFromRateLimitEvent(rec);
  if (!usage) return;
  const account = accountId ?? "default";
  // An event with one window must not blank the other.
  const current = getCachedRateLimits("claude", account);
  setCachedRateLimits("claude", account, {
    ...usage,
    session: usage.session ?? current.session,
    weekly: usage.weekly ?? current.weekly,
  });
}
