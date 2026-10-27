import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
} from "../src/features/providers/model/rateLimitsFetch";
import { errorRateLimits } from "../src/features/providers/model/rateLimits";
import { mobileUsageSnapshot } from "../src/features/mobile/model/mobileAccountUsage";
import { hostAccounts } from "./accounts";

/**
 * How much of the plan this machine's Claude and Codex accounts have used, in
 * the shape the phone's account picker already reads. The desktop answers this
 * from the same cache its own footer uses; a host has no footer, so it keeps
 * a small cache of its own with the same effect: the phone can ask as often as
 * it likes, and only a pull to refresh probes the provider again.
 *
 * Every sign-in the host found for the provider (see `accounts.ts`), each
 * probed with its own config directory.
 */

/** How long a reading stands before the next ask probes again. */
const FRESH_MS = 60_000;
/** The providers that report usage at all. */
const PROVIDERS = ["claude", "codex"] as const;

type Provider = (typeof PROVIDERS)[number];
type Limits = Awaited<ReturnType<typeof fetchClaudeRateLimits>>;

export function createMobileUsage() {
  const cache = new Map<string, { at: number; limits: Limits }>();
  const inflight = new Map<string, Promise<Limits>>();

  const read = async (
    provider: Provider,
    accountId: string,
    refresh: boolean,
  ): Promise<Limits> => {
    const key = `${provider}:${accountId}`;
    const cached = cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < FRESH_MS)
      return cached.limits;
    // One probe at a time per account: the picker opening asks for both, and
    // Codex's probe starts a whole app-server.
    const running = inflight.get(key);
    if (running) return running;
    const probe = (
      provider === "claude"
        ? fetchClaudeRateLimits(accountId)
        : fetchCodexRateLimits(accountId)
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
        cache.set(key, { at: Date.now(), limits });
        return limits;
      })
      .finally(() => {
        if (inflight.get(key) === probe) inflight.delete(key);
      });
    inflight.set(key, probe);
    return probe;
  };

  return async (params: Record<string, unknown>) => {
    const provider = params.provider;
    if (provider !== "claude" && provider !== "codex")
      throw new Error(
        "Usage is only available for Claude Code and Codex accounts",
      );
    const accounts = hostAccounts().filter(
      (account) => account.provider === provider && !account.duplicate,
    );
    const readings = await Promise.all(
      accounts.map(async (account) => {
        const limits = await read(provider, account.id, params.refresh === true);
        // Used, not remaining: the desktop's own preference lives in its
        // browser storage, which a host has none of.
        return [account.id, mobileUsageSnapshot(limits, Date.now(), false)];
      }),
    );
    return { accounts: Object.fromEntries(readings) };
  };
}
