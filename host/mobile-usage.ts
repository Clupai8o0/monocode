import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
} from "../src/features/providers/model/rateLimitsFetch";
import { errorRateLimits } from "../src/features/providers/model/rateLimits";
import { mobileUsageSnapshot } from "../src/features/mobile/model/mobileAccountUsage";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../src/features/providers/model/providerAccounts";

/**
 * How much of the plan this machine's Claude and Codex accounts have used, in
 * the shape the phone's account picker already reads. The desktop answers this
 * from the same cache its own footer uses; a host has no footer, so it keeps
 * a small cache of its own with the same effect: the phone can ask as often as
 * it likes, and only a pull to refresh probes the provider again.
 *
 * One account per provider — the config directory this host runs its agents
 * with. Switching between several would mean a separate sign-in per directory,
 * which only the owner can do.
 */

/** How long a reading stands before the next ask probes again. */
const FRESH_MS = 60_000;
/** The providers that report usage at all. */
const PROVIDERS = ["claude", "codex"] as const;

type Provider = (typeof PROVIDERS)[number];
type Limits = Awaited<ReturnType<typeof fetchClaudeRateLimits>>;

export function createMobileUsage() {
  const cache = new Map<Provider, { at: number; limits: Limits }>();
  const inflight = new Map<Provider, Promise<Limits>>();

  const read = async (provider: Provider, refresh: boolean): Promise<Limits> => {
    const cached = cache.get(provider);
    if (!refresh && cached && Date.now() - cached.at < FRESH_MS)
      return cached.limits;
    // One probe at a time per provider: the picker opening asks for both, and
    // Codex's probe starts a whole app-server.
    const running = inflight.get(provider);
    if (running) return running;
    const probe = (
      provider === "claude" ? fetchClaudeRateLimits() : fetchCodexRateLimits()
    )
      .catch((error: unknown) =>
        errorRateLimits(
          provider,
          error instanceof Error ? error.message : String(error),
        ),
      )
      .then((limits) => {
        // A failed probe keeps the last good reading, which the phone shows as
        // stale rather than as nothing at all.
        if (
          limits.status === "error" &&
          !limits.session &&
          !limits.weekly &&
          !limits.monthly &&
          !limits.resetCredits &&
          cached
        )
          return errorRateLimits(
            provider,
            limits.error ?? "Usage is unavailable",
            cached.limits,
          );
        return limits;
      })
      .then((limits) => {
        cache.set(provider, { at: Date.now(), limits });
        return limits;
      })
      .finally(() => {
        if (inflight.get(provider) === probe) inflight.delete(provider);
      });
    inflight.set(provider, probe);
    return probe;
  };

  return async (params: Record<string, unknown>) => {
    const provider = params.provider;
    if (provider !== "claude" && provider !== "codex")
      throw new Error(
        "Usage is only available for Claude Code and Codex accounts",
      );
    const limits = await read(provider, params.refresh === true);
    return {
      accounts: {
        // Used, not remaining: the desktop's own preference lives in its
        // browser storage, which a host has none of.
        [DEFAULT_PROVIDER_ACCOUNT_ID]: mobileUsageSnapshot(
          limits,
          Date.now(),
          false,
        ),
      },
    };
  };
}
