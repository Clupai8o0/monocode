import { isLiveHarness } from "../../integrations/harness/core/registry";
import { getCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import {
  selectedProviderAccountId,
  type ProviderAccountProvider,
} from "../../features/providers/model/providerAccounts";
import type { HarnessId } from "../../features/sessions/model/session";
import { getExtraUsage } from "../usage/extraUsage";
import type { ContinuePickOptions } from "./continueElsewhere";

export { cursorUsageResetsAt } from "../usage/extraUsage";

/** Shared continue-elsewhere pick options (usage bar, session menu, host). */
export function continuePickOptions(cwd?: string): ContinuePickOptions {
  return {
    isLive: isLiveHarness,
    usedPercent: (id: HarnessId) => harnessUsedPercent(id, cwd),
  };
}

/**
 * How spent a continue-elsewhere candidate looks (0–100). Lower means more
 * headroom. Claude and Codex use the hottest rate-limit window; Cursor uses
 * the hotter of its Auto and API pools.
 */
export function harnessUsedPercent(
  harness: HarnessId,
  project?: string,
): number | null {
  if (harness === "claude" || harness === "codex") {
    return rateLimitUsedPercent(harness, project);
  }
  if (harness === "cursor") {
    return cursorUsedPercent();
  }
  return null;
}

function rateLimitUsedPercent(
  provider: ProviderAccountProvider,
  project?: string,
): number | null {
  const accountId = selectedProviderAccountId(provider, project);
  const limits = getCachedRateLimits(provider, accountId);
  if (limits.status !== "ok" && limits.status !== "fetching") return null;
  const windows = [limits.session, limits.weekly, limits.monthly].filter(
    (window): window is NonNullable<typeof window> => !!window,
  );
  if (windows.length === 0) return null;
  return Math.max(...windows.map((window) => window.usedPercent));
}

function cursorUsedPercent(): number | null {
  const usage = getExtraUsage("cursor");
  if (usage.status !== "ok" || usage.bars.length === 0) return null;
  return Math.max(...usage.bars.map((bar) => bar.usedPercent));
}
