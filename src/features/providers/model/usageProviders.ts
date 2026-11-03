import { supportsFirstClassUsage } from "../../../integrations/harness/core/firstClassProviders";
import type { HarnessId } from "../../sessions/model/session";
import type { RateLimitProvider } from "./rateLimits";

/** Non-first-class harnesses that still probe usage next to the composer. */
const EXTRA_USAGE_PROVIDERS = ["opencode", "devin"] as const satisfies readonly RateLimitProvider[];

/**
 * The providers whose plan usage a Mono on `harness` shows by its composer.
 * First-class harnesses use `supportsFirstClassUsage`; opencode/devin stay as extras.
 * Grok has no rate-limit fetcher and returns [].
 */
export function monoUsageProviders(harness: HarnessId): RateLimitProvider[] {
  if (supportsFirstClassUsage(harness)) {
    return [harness as RateLimitProvider];
  }
  if (
    (EXTRA_USAGE_PROVIDERS as readonly string[]).includes(harness)
  ) {
    return [harness as RateLimitProvider];
  }
  return [];
}
