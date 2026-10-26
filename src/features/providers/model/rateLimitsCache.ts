import { useSyncExternalStore } from "react";
import {
  errorRateLimits,
  fetchingRateLimits,
  idleRateLimits,
  RATE_LIMIT_MIN_REFETCH_MS,
  RATE_LIMIT_POLL_MS,
  type ProviderRateLimits,
  type RateLimitProvider,
} from "./rateLimits";
import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
  fetchDevinRateLimits,
  fetchOpencodeGoRateLimits,
} from "./rateLimitsFetch";
import {
  invalidateSharedUsage,
  readSharedUsage,
  sharedUsageAccountKey,
  withUsageLock,
  writeSharedUsage,
} from "../../../fork/usage/sharedUsage"; // Fork

const snapshots = new Map<string, ProviderRateLimits>();
const pending = new Map<string, Promise<ProviderRateLimits>>();
const queuedRefreshes = new Map<string, Promise<ProviderRateLimits>>();
const checkedAt = new Map<string, number>();
const generations = new Map<string, number>();
const epochs = new Map<string, string>();
const listeners = new Set<() => void>();
let allSnapshots: Record<string, ProviderRateLimits> = {};

function keyFor(provider: RateLimitProvider, accountId: string): string {
  return `${provider}:${accountId}`;
}

function publish(key: string, value: ProviderRateLimits): void {
  snapshots.set(key, value);
  allSnapshots = { ...allSnapshots, [key]: value };
  for (const listener of listeners) listener();
}

export function subscribeRateLimits(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", sharedUsageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", sharedUsageChanged);
    }
  };
}

function sharedUsageChanged(event: StorageEvent): void {
  const key = sharedUsageAccountKey(event.key);
  if (!key) return;
  const entry = readSharedUsage(key);
  reconcileEpoch(key, entry?.epoch ?? "");
  if (entry?.value && entry.checkedAt >= (checkedAt.get(key) ?? 0)) {
    checkedAt.set(key, entry.checkedAt);
    publish(key, entry.value);
  }
}

function reconcileEpoch(key: string, epoch: string): void {
  const previous = epochs.get(key);
  epochs.set(key, epoch);
  // One invalidation can emit several storage events (the marker and removed
  // payloads). Only its first event may cancel work from the previous epoch.
  if (previous !== undefined && previous !== epoch) forgetLocalUsage(key);
}

function forgetLocalUsage(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  snapshots.delete(key);
  checkedAt.delete(key);
  pending.delete(key);
  queuedRefreshes.delete(key);
  const { [key]: _removed, ...rest } = allSnapshots;
  allSnapshots = rest;
  for (const listener of listeners) listener();
}

export function getAllRateLimits(): Record<string, ProviderRateLimits> {
  return allSnapshots;
}

export function getCachedRateLimits(
  provider: RateLimitProvider,
  accountId = "default",
): ProviderRateLimits {
  return snapshots.get(keyFor(provider, accountId)) ?? idle[provider];
}

const idle: Record<RateLimitProvider, ProviderRateLimits> = {
  claude: idleRateLimits("claude"),
  codex: idleRateLimits("codex"),
  opencode: idleRateLimits("opencode"),
  devin: idleRateLimits("devin"),
};

export function useCachedRateLimits(
  provider: RateLimitProvider,
  accountId = "default",
): ProviderRateLimits {
  return useSyncExternalStore(
    subscribeRateLimits,
    () => getCachedRateLimits(provider, accountId),
    () => getCachedRateLimits(provider, accountId),
  );
}

export function setCachedRateLimits(
  provider: RateLimitProvider,
  accountId: string,
  value: ProviderRateLimits,
): void {
  const key = keyFor(provider, accountId);
  const epoch = readSharedUsage(key)?.epoch ?? "";
  reconcileEpoch(key, epoch);
  const generation = generations.get(key) ?? 0;
  const checked = value.status === "error" ? Date.now() : value.updatedAt;
  checkedAt.set(key, checked);
  publish(key, value);
  if (
    ["ok", "error", "unavailable"].includes(value.status) &&
    generation === (generations.get(key) ?? 0)
  ) {
    writeSharedUsage(key, {
      epoch,
      id: crypto.randomUUID(),
      checkedAt: checked,
      value,
    });
  }
}

/** Reuse fresh account data; explicit Refresh always asks the provider again. */
export function loadRateLimits(
  provider: RateLimitProvider,
  accountId = "default",
  force = false,
  maxAgeMs = RATE_LIMIT_POLL_MS,
): Promise<ProviderRateLimits> {
  const key = keyFor(provider, accountId);
  // The footer may have been unmounted while another window reset or removed
  // this account, so storage events alone cannot validate a local cache hit.
  const previousShared = readSharedUsage(key);
  reconcileEpoch(key, previousShared?.epoch ?? "");
  const running = pending.get(key);
  if (running) {
    if (!force) return running;
    const queued = queuedRefreshes.get(key);
    if (queued) return queued;
    const generation = generations.get(key) ?? 0;
    const next = running.then(() =>
      generation === (generations.get(key) ?? 0)
        ? loadRateLimits(provider, accountId, true, maxAgeMs)
        : getCachedRateLimits(provider, accountId),
    );
    queuedRefreshes.set(key, next);
    void next.finally(() => {
      if (queuedRefreshes.get(key) === next) queuedRefreshes.delete(key);
    });
    return next;
  }
  const cached = snapshots.get(key);
  const maxAge = Math.max(0, Math.min(maxAgeMs, RATE_LIMIT_POLL_MS));
  const fresh = (value: ProviderRateLimits, at: number) =>
    at > 0 &&
    Date.now() >= at &&
    Date.now() - at <
      (value.status === "error"
        ? Math.min(maxAge, RATE_LIMIT_MIN_REFETCH_MS)
        : maxAge);
  if (
    cached &&
    !force &&
    fresh(cached, checkedAt.get(key) ?? cached.updatedAt)
  ) {
    return Promise.resolve(cached);
  }

  const generation = generations.get(key) ?? 0;
  publish(key, fetchingRateLimits(provider, cached));
  const run = withUsageLock(key, async () => {
    const shared = readSharedUsage(key);
    if (generation !== (generations.get(key) ?? 0)) {
      return getCachedRateLimits(provider, accountId);
    }
    if ((previousShared?.epoch ?? "") !== (shared?.epoch ?? "")) {
      // The account changed while this window waited for another window's
      // read. Don't adopt its data or start a probe for the removed account.
      reconcileEpoch(key, shared?.epoch ?? "");
      return getCachedRateLimits(provider, accountId);
    }
    if (
      shared?.value &&
      fresh(shared.value, shared.checkedAt) &&
      (!force || shared.id !== previousShared?.id)
    ) {
      checkedAt.set(key, shared.checkedAt);
      publish(key, shared.value);
      return shared.value;
    }
    const epoch = shared?.epoch ?? "";
    let result: ProviderRateLimits;
    try {
      result =
        provider === "claude"
          ? await fetchClaudeRateLimits(accountId)
          : provider === "codex"
            ? await fetchCodexRateLimits(accountId)
            : provider === "devin"
              ? await fetchDevinRateLimits()
              : await fetchOpencodeGoRateLimits();
      if (result.status === "error") {
        result = errorRateLimits(
          provider,
          result.error || "Usage unavailable",
          cached,
        );
      }
    } catch (error) {
      result = errorRateLimits(
        provider,
        error instanceof Error ? error.message : String(error),
        cached,
      );
    }
    if (
      generation === (generations.get(key) ?? 0) &&
      epoch === (readSharedUsage(key)?.epoch ?? "")
    ) {
      const completed = Date.now();
      checkedAt.set(key, completed);
      publish(key, result);
      writeSharedUsage(key, {
        epoch,
        id: crypto.randomUUID(),
        checkedAt: completed,
        value: result,
      });
    }
    return result;
  }).finally(() => {
    if (pending.get(key) === run) pending.delete(key);
  });
  pending.set(key, run);
  return run;
}

/** Also used when an account is removed and by tests that need a clean cache. */
export function clearCachedRateLimits(
  provider?: RateLimitProvider,
  accountId?: string,
): void {
  if (provider && accountId) {
    const key = keyFor(provider, accountId);
    invalidateSharedUsage(key);
    epochs.set(key, readSharedUsage(key)?.epoch ?? "");
    forgetLocalUsage(key);
  } else {
    const keys = new Set([...snapshots.keys(), ...pending.keys()]);
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = sharedUsageAccountKey(localStorage.key(i));
        if (key) keys.add(key);
      }
    } catch {
      /* No storage outside the webview. */
    }
    for (const key of keys) {
      generations.set(key, (generations.get(key) ?? 0) + 1);
      invalidateSharedUsage(key);
      epochs.set(key, readSharedUsage(key)?.epoch ?? "");
    }
    snapshots.clear();
    checkedAt.clear();
    pending.clear();
    queuedRefreshes.clear();
    allSnapshots = {};
  }
  for (const listener of listeners) listener();
}
