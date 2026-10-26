// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { idleRateLimits, RATE_LIMIT_POLL_MS } from "./rateLimits";

const fetches = vi.hoisted(() => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchCodexRateLimits: vi.fn(),
  fetchDevinRateLimits: vi.fn(),
  fetchOpencodeGoRateLimits: vi.fn(),
}));
vi.mock("./rateLimitsFetch", () => fetches);

function limits(percent = 41) {
  return {
    ...idleRateLimits("codex"),
    status: "ok" as const,
    session: { usedPercent: percent, windowMinutes: 300, resetsAt: null },
    updatedAt: Date.now(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  fetches.fetchCodexRateLimits
    .mockReset()
    .mockImplementation(async () => limits());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "does not overwrite a concurrent invalidation at commit time (new data: %s)",
  async (replace) => {
    vi.stubGlobal("navigator", {}); // The race must also be safe without Web Locks.
    const first = await import("./rateLimitsCache");
    vi.resetModules();
    const second = await import("./rateLimitsCache");
    const { readSharedUsage, SHARED_USAGE_PREFIX } =
      await import("../../../fork/usage/sharedUsage");
    const write = localStorage.setItem.bind(localStorage);
    let invalidated = false;
    vi.spyOn(localStorage, "setItem").mockImplementation((key, raw) => {
      // Suspend the old writer after its final epoch check, immediately before
      // committing. Another window resets/signs out and may publish fresh quota.
      if (
        !invalidated &&
        key.startsWith(SHARED_USAGE_PREFIX) &&
        JSON.parse(raw).value?.session?.usedPercent === 41
      ) {
        invalidated = true;
        second.clearCachedRateLimits("codex", "default");
        if (replace) second.setCachedRateLimits("codex", "default", limits(77));
      }
      write(key, raw);
    });
    await first.loadRateLimits("codex");
    expect(invalidated).toBe(true);
    expect(
      readSharedUsage("codex:default")?.value?.session?.usedPercent ?? null,
    ).toBe(replace ? 77 : null);
  },
);

it("reuses recent usage but refreshes an old snapshot", async () => {
  const cache = await import("./rateLimitsCache");
  await cache.loadRateLimits("codex");
  await cache.loadRateLimits("codex");
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + RATE_LIMIT_POLL_MS);
  await cache.loadRateLimits("codex");
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
});

it("keeps the successful timestamp and values when refresh fails", async () => {
  const cache = await import("./rateLimitsCache");
  const first = await cache.loadRateLimits("codex");
  vi.setSystemTime(Date.now() + 7 * 3_600_000);
  fetches.fetchCodexRateLimits.mockResolvedValue({
    ...idleRateLimits("codex"),
    status: "error",
    error: "Connection timed out",
    updatedAt: Date.now(),
  });
  const failed = await cache.loadRateLimits("codex", "default", true);
  expect(failed.session).toEqual(first.session);
  expect(failed.updatedAt).toBe(first.updatedAt);
  expect(failed.status).toBe("error");
  expect(failed.error).toBe("Connection timed out");
  await cache.loadRateLimits("codex");
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
});

it("coalesces simultaneous reads in independent windows using a shared lock", async () => {
  let tail = Promise.resolve<unknown>(undefined);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_key: string, work: () => Promise<unknown>) => {
        const next = tail.then(work);
        tail = next.catch(() => undefined);
        return next;
      },
    },
  });
  const first = await import("./rateLimitsCache");
  vi.resetModules();
  const second = await import("./rateLimitsCache");
  await Promise.all([
    first.loadRateLimits("codex"),
    second.loadRateLimits("codex"),
  ]);
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(1);
  expect(second.getCachedRateLimits("codex").session?.usedPercent).toBe(41);
});

it("does not reuse removed accounts or expired shared snapshots", async () => {
  const cache = await import("./rateLimitsCache");
  await cache.loadRateLimits("codex", "account-work");
  cache.clearCachedRateLimits("codex", "account-work");
  await cache.loadRateLimits("codex", "account-work");
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 7 * 3_600_000);
  vi.resetModules();
  const other = await import("./rateLimitsCache");
  await other.loadRateLimits("codex", "account-work");
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(3);
});

it("does not restore an account invalidated while waiting for another window's lock", async () => {
  let release!: () => void;
  vi.stubGlobal("navigator", {
    locks: {
      request: (_key: string, work: () => Promise<unknown>) =>
        new Promise((resolve) => {
          release = () => resolve(work());
        }),
    },
  });
  const first = await import("./rateLimitsCache");
  const pending = first.loadRateLimits("codex", "account-work");
  vi.resetModules();
  const second = await import("./rateLimitsCache");
  second.clearCachedRateLimits("codex", "account-work");
  second.setCachedRateLimits("codex", "account-work", limits(82));
  release();
  await pending;
  expect(first.getCachedRateLimits("codex", "account-work").status).toBe(
    "idle",
  );
  expect(fetches.fetchCodexRateLimits).not.toHaveBeenCalled();
});

it("does not repopulate a removed account when an already running fetch completes", async () => {
  let finish!: (value: ReturnType<typeof limits>) => void;
  fetches.fetchCodexRateLimits.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const cache = await import("./rateLimitsCache");
  const pending = cache.loadRateLimits("codex", "account-work");
  cache.clearCachedRateLimits("codex", "account-work");
  finish(limits());
  await pending;
  expect(cache.getCachedRateLimits("codex", "account-work").status).toBe(
    "idle",
  );
});

it("falls back safely if an embedded browser denies Web Locks", async () => {
  vi.stubGlobal("navigator", {
    locks: {
      request: async () => {
        throw new Error("Locks unavailable");
      },
    },
  });
  const cache = await import("./rateLimitsCache");
  expect((await cache.loadRateLimits("codex")).session?.usedPercent).toBe(41);
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(1);
});

it("shares explicit successful cache updates and receives another window's refresh", async () => {
  const first = await import("./rateLimitsCache");
  first.setCachedRateLimits("codex", "default", limits(12));
  vi.resetModules();
  const second = await import("./rateLimitsCache");
  await second.loadRateLimits("codex");
  expect(second.getCachedRateLimits("codex").session?.usedPercent).toBe(12);
  expect(fetches.fetchCodexRateLimits).not.toHaveBeenCalled();
  const changed = vi.fn();
  const unsubscribe = second.subscribeRateLimits(changed);
  first.setCachedRateLimits("codex", "default", limits(77));
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "monocode.usageSnapshot.v1:codex%3Adefault:",
    }),
  );
  expect(second.getCachedRateLimits("codex").session?.usedPercent).toBe(77);
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
});

it("checks the shared epoch before returning fresh local usage after missing storage events", async () => {
  const first = await import("./rateLimitsCache");
  await first.loadRateLimits("codex");
  vi.resetModules();
  const second = await import("./rateLimitsCache");
  second.clearCachedRateLimits("codex", "default");
  fetches.fetchCodexRateLimits.mockResolvedValue(limits(77));
  expect((await first.loadRateLimits("codex")).session?.usedPercent).toBe(77);
  expect(fetches.fetchCodexRateLimits).toHaveBeenCalledTimes(2);
});

it("does not cancel new-epoch usage when obsolete payload removal emits another storage event", async () => {
  const first = await import("./rateLimitsCache");
  await first.loadRateLimits("codex");
  const unsubscribe = first.subscribeRateLimits(() => {});
  vi.resetModules();
  const second = await import("./rateLimitsCache");
  second.clearCachedRateLimits("codex", "default");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "monocode.usageEpoch.v1:codex:default",
    }),
  );
  let finish!: (value: ReturnType<typeof limits>) => void;
  fetches.fetchCodexRateLimits.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = first.loadRateLimits("codex");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "monocode.usageSnapshot.v1:codex%3Adefault:",
    }),
  );
  finish(limits(77));
  await pending;
  expect(first.getCachedRateLimits("codex").session?.usedPercent).toBe(77);
  unsubscribe();
});

it("bounds retired payloads and clears every stored account without treating payload epochs as accounts", async () => {
  const cache = await import("./rateLimitsCache");
  for (let i = 0; i < 5; i += 1) {
    cache.clearCachedRateLimits("codex", "account:work");
    cache.setCachedRateLimits("codex", "account:work", limits(i));
  }
  cache.setCachedRateLimits("codex", "default", limits(77));
  const { readSharedUsage, SHARED_USAGE_PREFIX, sharedUsageAccountKey } =
    await import("../../../fork/usage/sharedUsage");
  const storedKeys = () =>
    Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
  expect(
    storedKeys().filter((key) => key.startsWith(SHARED_USAGE_PREFIX)),
  ).toHaveLength(2);
  vi.resetModules();
  const other = await import("./rateLimitsCache");
  other.clearCachedRateLimits();
  expect(readSharedUsage("codex:account:work")?.value).toBeNull();
  expect(readSharedUsage("codex:default")?.value).toBeNull();
  expect(
    storedKeys().filter((key) => key.startsWith(SHARED_USAGE_PREFIX)),
  ).toHaveLength(0);
  expect(storedKeys().map(sharedUsageAccountKey).sort()).toEqual([
    "codex:account:work",
    "codex:default",
  ]);
});
