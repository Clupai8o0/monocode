import type {
  ProviderRateLimits,
  RateLimitWindow,
} from "../../features/providers/model/rateLimits";

export const SHARED_USAGE_PREFIX = "monocode.usageSnapshot.v1:";
const EPOCH_PREFIX = "monocode.usageEpoch.v1:";

export type SharedUsage = {
  /** Changes only on invalidation, so an older read cannot restore a removed account. */
  epoch: string;
  id: string;
  checkedAt: number;
  value: ProviderRateLimits | null;
};

function snapshotKey(key: string, epoch: string): string {
  return `${SHARED_USAGE_PREFIX}${encodeURIComponent(key)}:${encodeURIComponent(epoch)}`;
}

/** Maps either a quota payload or its invalidation marker to one account. */
export function sharedUsageAccountKey(
  storageKey: string | null,
): string | null {
  if (storageKey?.startsWith(EPOCH_PREFIX)) {
    return storageKey.slice(EPOCH_PREFIX.length);
  }
  if (!storageKey?.startsWith(SHARED_USAGE_PREFIX)) return null;
  const suffix = storageKey.slice(SHARED_USAGE_PREFIX.length);
  const split = suffix.lastIndexOf(":");
  if (split < 0) return null;
  try {
    const key = decodeURIComponent(suffix.slice(0, split));
    return key.includes(":") ? key : null;
  } catch {
    return null;
  }
}

function currentEpoch(key: string): string {
  return localStorage.getItem(EPOCH_PREFIX + key) ?? "";
}

function invalidated(epoch: string): SharedUsage {
  return { epoch, id: epoch, checkedAt: 0, value: null };
}

/** Reclaim retired payloads on every write; markers remain as invalidation fences. */
function removeObsoleteSnapshots(key: string): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const storageKey = localStorage.key(i);
    if (
      storageKey?.startsWith(SHARED_USAGE_PREFIX) &&
      sharedUsageAccountKey(storageKey) === key
    ) {
      keys.push(storageKey);
    }
  }
  for (const storageKey of keys) {
    // Epochs are unique and never reused. Check the latest marker for each
    // deletion so cleanup cannot remove another window's new active payload.
    if (storageKey !== snapshotKey(key, currentEpoch(key))) {
      localStorage.removeItem(storageKey);
    }
  }
}

function validWindow(value: RateLimitWindow | null): boolean {
  return (
    value === null ||
    Boolean(
      value &&
      Number.isFinite(value.usedPercent) &&
      Number.isFinite(value.windowMinutes) &&
      value.windowMinutes > 0 &&
      (value.resetsAt === null || Number.isFinite(value.resetsAt)),
    )
  );
}

/** Only quota/status values, never credentials. Invalid storage is ignored. */
export function readSharedUsage(key: string): SharedUsage | null {
  let epoch = "";
  try {
    epoch = currentEpoch(key);
    const raw = localStorage.getItem(snapshotKey(key, epoch));
    const latest = currentEpoch(key);
    if (latest !== epoch) return invalidated(latest);
    if (!raw) return invalidated(epoch);
    const entry = JSON.parse(raw) as SharedUsage;
    if (
      !entry ||
      entry.epoch !== epoch ||
      typeof entry.id !== "string" ||
      !Number.isFinite(entry.checkedAt) ||
      entry.checkedAt > Date.now() + 60_000
    )
      return invalidated(epoch);
    const value = entry.value;
    if (value === null) return entry;
    if (
      !value ||
      value.provider !== key.split(":", 1)[0] ||
      !["ok", "error", "unavailable"].includes(value.status) ||
      !Number.isFinite(value.updatedAt) ||
      !validWindow(value.session) ||
      !validWindow(value.weekly) ||
      !validWindow(value.monthly) ||
      !(value.error === null || typeof value.error === "string") ||
      !(
        value.resetCredits === null ||
        (value.resetCredits &&
          Number.isFinite(value.resetCredits.availableCount) &&
          value.resetCredits.availableCount >= 0 &&
          (value.resetCredits.credits === null ||
            (Array.isArray(value.resetCredits.credits) &&
              value.resetCredits.credits.every(
                (credit) =>
                  credit &&
                  typeof credit.id === "string" &&
                  ["codexRateLimits", "unknown"].includes(credit.resetType) &&
                  ["available", "redeeming", "redeemed", "unknown"].includes(
                    credit.status,
                  ),
              ))))
      )
    )
      return invalidated(epoch);
    return entry;
  } catch {
    return invalidated(epoch);
  }
}

export function writeSharedUsage(key: string, entry: SharedUsage): void {
  try {
    // Never write the epoch marker here. Even if another window invalidates
    // between the caller's last check and this commit, this payload belongs
    // only to the old epoch and cannot restore or overwrite current data.
    localStorage.setItem(snapshotKey(key, entry.epoch), JSON.stringify(entry));
    removeObsoleteSnapshots(key);
  } catch {
    // Blocked/full storage: the window's ordinary in-memory cache still works.
  }
}

export function invalidateSharedUsage(key: string): void {
  try {
    localStorage.setItem(EPOCH_PREFIX + key, crypto.randomUUID());
    removeObsoleteSnapshots(key);
  } catch {
    // The calling window also invalidates its in-memory cache synchronously.
  }
}

/** Webviews share their origin's locks. Older engines keep local deduplication. */
export async function withUsageLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request)
    return work();
  let entered = false;
  try {
    return await navigator.locks.request(SHARED_USAGE_PREFIX + key, () => {
      entered = true;
      return work();
    });
  } catch (error) {
    if (entered) throw error;
    // Some embedded contexts expose the API but deny access to it.
    return work();
  }
}
