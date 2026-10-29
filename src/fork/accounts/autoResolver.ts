import { useEffect, useSyncExternalStore } from "react";
import {
  accountHeadroom,
  accountStatus,
} from "../../features/providers/model/accountUsage";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerAccounts,
  setAutoProviderAccountResolver,
  type ProviderAccountProvider,
} from "../../features/providers/model/providerAccounts";
import {
  getAllRateLimits,
  getCachedRateLimits,
  loadRateLimits,
  subscribeRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import {
  exhaustedSwitchTarget,
  pickAutoAccount,
  type AutoCandidate,
} from "./autoAccount";

/**
 * Fork: connects the Auto choice to the usage cache, so
 * selectedProviderAccountId can turn "auto" into a real account at spawn.
 * Imported once for its side effect by App.
 */

export function autoCandidates(
  provider: ProviderAccountProvider,
  now = Date.now(),
): AutoCandidate[] {
  return providerAccounts(provider).map((account) => {
    const limits = getCachedRateLimits(provider, account.id);
    const headroom = accountHeadroom(limits, now) ?? undefined;
    return {
      id: account.id,
      tone: accountStatus(limits, now).tone,
      ...(headroom === undefined ? {} : { headroom }),
    };
  });
}

export function resolveAutoAccount(
  provider: ProviderAccountProvider,
  now = Date.now(),
): string {
  return (
    pickAutoAccount(autoCandidates(provider, now), DEFAULT_PROVIDER_ACCOUNT_ID) ??
    DEFAULT_PROVIDER_ACCOUNT_ID
  );
}

/** The account to offer when `currentId` is exhausted, or null. */
export function exhaustedSwitchFor(
  provider: ProviderAccountProvider,
  currentId: string,
  now = Date.now(),
): string | null {
  const candidates = autoCandidates(provider, now);
  const current = candidates.find((candidate) => candidate.id === currentId);
  if (current?.tone !== "exhausted") {
    return null;
  }
  return exhaustedSwitchTarget(
    currentId,
    candidates,
    DEFAULT_PROVIDER_ACCOUNT_ID,
  );
}

export function installAutoAccountResolver(): void {
  setAutoProviderAccountResolver((provider) => resolveAutoAccount(provider));
}

installAutoAccountResolver();

/**
 * Keep every account's usage loaded while `enabled`, so Auto and the
 * exhausted suggestion compare real numbers. The shared cache dedupes.
 */
export function useAutoAccountUsage(
  provider: ProviderAccountProvider,
  enabled: boolean,
): void {
  // Re-render when any account's usage changes.
  useSyncExternalStore(subscribeRateLimits, getAllRateLimits, getAllRateLimits);
  const ids = enabled
    ? providerAccounts(provider)
        .map((account) => account.id)
        .join("|")
    : "";
  useEffect(() => {
    if (!ids) {
      return;
    }
    for (const id of ids.split("|")) {
      void loadRateLimits(provider, id, false);
    }
  }, [ids, provider]);
}
