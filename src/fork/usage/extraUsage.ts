import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * Fork feature: usage for agents MonoCode has no usage API for, read by
 * `fork_extra_usage` (Rust) and parsed here. Muse and Antigravity report
 * windows like Claude's; DeepSeek reports a prepaid balance.
 */
export type ExtraUsageProvider = "muse" | "antigravity" | "deepseek";

export type UsageBar = {
  /** Short window name, e.g. "5h" or "wk". */
  label: string;
  /** What the bar covers when the provider splits it, e.g. "Gemini". */
  group?: string;
  usedPercent: number;
  resetsAt: number | null;
};

export type ExtraUsage =
  | {
      status: "ok";
      bars: UsageBar[];
      /** Plan name, or the balance for DeepSeek. */
      detail?: string;
      checkedAt: number;
    }
  | { status: "unavailable" | "error"; message: string; checkedAt: number }
  | { status: "idle" | "fetching" };

type RawUsage =
  | { status: "ok"; body: string }
  | { status: "unavailable" | "error"; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

/** `muse usage --json`: a rolling window and a weekly one, in used percent. */
export function parseMuseUsage(body: string): ExtraUsage {
  const allowance = record(record(JSON.parse(body))?.allowance);
  const bars: UsageBar[] = [];
  for (const [key, label] of [
    ["window", "now"],
    ["weekly", "wk"],
  ] as const) {
    const window = record(allowance?.[key]);
    const used = percent(window?.usedPercent);
    if (used == null) continue;
    const resetsAt = window?.resetsAtMs;
    bars.push({
      label,
      usedPercent: used,
      resetsAt: typeof resetsAt === "number" ? resetsAt : null,
    });
  }
  if (bars.length === 0) {
    return {
      status: "error",
      message: "Muse did not report an allowance",
      checkedAt: Date.now(),
    };
  }
  const tier = allowance?.tier;
  return {
    status: "ok",
    bars,
    detail: typeof tier === "string" ? tier : undefined,
    checkedAt: Date.now(),
  };
}

/** `agy -p /quota --output-format json`: model groups, each with a 5h and a weekly bucket. */
export function parseAntigravityQuota(body: string): ExtraUsage {
  const data = record(record(record(JSON.parse(body))?.command)?.data);
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const bars: UsageBar[] = [];
  for (const entry of groups) {
    const group = record(entry);
    const name = typeof group?.name === "string" ? group.name : undefined;
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const raw of buckets) {
      const bucket = record(raw);
      const remaining = bucket?.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
        continue;
      }
      const reset =
        typeof bucket?.reset_time === "string"
          ? Date.parse(bucket.reset_time)
          : NaN;
      bars.push({
        label:
          bucket?.window === "weekly" ? "wk" : String(bucket?.window ?? ""),
        group: name?.replace(/ models?$/i, ""),
        usedPercent: Math.min(100, Math.max(0, (1 - remaining) * 100)),
        resetsAt: Number.isFinite(reset) ? reset : null,
      });
    }
  }
  if (bars.length === 0) {
    return {
      status: "error",
      message: "Antigravity did not report a quota",
      checkedAt: Date.now(),
    };
  }
  return { status: "ok", bars, checkedAt: Date.now() };
}

const CURRENCY: Record<string, string> = { USD: "$", CNY: "¥" };

/** DeepSeek `/user/balance`: one prepaid balance per currency, no windows. */
export function parseDeepseekBalance(body: string): ExtraUsage {
  const data = record(JSON.parse(body));
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const balances = infos.flatMap((raw) => {
    const info = record(raw);
    const amount = Number(info?.total_balance);
    const currency = typeof info?.currency === "string" ? info.currency : "";
    if (!Number.isFinite(amount) || !currency) return [];
    const symbol = CURRENCY[currency];
    return [
      symbol
        ? `${symbol}${amount.toFixed(2)}`
        : `${amount.toFixed(2)} ${currency}`,
    ];
  });
  if (balances.length === 0) {
    return {
      status: "error",
      message: "DeepSeek did not report a balance",
      checkedAt: Date.now(),
    };
  }
  return {
    status: "ok",
    bars: [],
    detail: `${balances.join(" · ")} left`,
    checkedAt: Date.now(),
  };
}

const PARSERS: Record<ExtraUsageProvider, (body: string) => ExtraUsage> = {
  muse: parseMuseUsage,
  antigravity: parseAntigravityQuota,
  deepseek: parseDeepseekBalance,
};

/** Each read runs a CLI or calls an API, so a footer opening reuses it a while. */
export const EXTRA_USAGE_MAX_AGE_MS = 5 * 60_000;

const cache = new Map<ExtraUsageProvider, ExtraUsage>();
const pending = new Map<ExtraUsageProvider, Promise<void>>();
const listeners = new Set<() => void>();

function publish(provider: ExtraUsageProvider, value: ExtraUsage): void {
  cache.set(provider, value);
  for (const listener of listeners) listener();
}

/** One object, so `useSyncExternalStore` sees an unchanged snapshot. */
const IDLE: ExtraUsage = { status: "idle" };

export function getExtraUsage(provider: ExtraUsageProvider): ExtraUsage {
  return cache.get(provider) ?? IDLE;
}

export function useExtraUsage(provider: ExtraUsageProvider): ExtraUsage {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getExtraUsage(provider),
    () => getExtraUsage(provider),
  );
}

/** Read again unless a recent answer is cached; `force` always reads. */
export function loadExtraUsage(
  provider: ExtraUsageProvider,
  force = false,
): Promise<void> {
  const running = pending.get(provider);
  if (running) return running;
  const current = cache.get(provider);
  if (
    !force &&
    current &&
    "checkedAt" in current &&
    Date.now() - current.checkedAt < EXTRA_USAGE_MAX_AGE_MS
  ) {
    return Promise.resolve();
  }
  if (!current || !("checkedAt" in current)) {
    publish(provider, { status: "fetching" });
  }
  const task = invoke<RawUsage>("fork_extra_usage", { provider })
    .then((raw) => {
      if (raw.status !== "ok") {
        publish(provider, { ...raw, checkedAt: Date.now() });
        return;
      }
      try {
        publish(provider, PARSERS[provider](raw.body));
      } catch {
        publish(provider, {
          status: "error",
          message: "The usage report was not JSON",
          checkedAt: Date.now(),
        });
      }
    })
    .catch((error: unknown) => {
      publish(provider, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      });
    })
    .finally(() => {
      pending.delete(provider);
    });
  pending.set(provider, task);
  return task;
}
