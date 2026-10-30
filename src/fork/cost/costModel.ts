import { invoke } from "@tauri-apps/api/core";

export type CostModel = {
  model: string;
  family: string;
  usd: number;
  savedUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type CostDay = {
  date: string;
  byFamily: Record<string, number>;
  savedUsd: number;
};

export type CostReport = {
  days: CostDay[];
  models: CostModel[];
  accounts: Record<string, number>;
  unpriced: string[];
  unreadable: number;
};

/** Fixed, so a model keeps its colour whichever others are in view. */
export const COST_FAMILIES = ["opus", "sonnet", "haiku", "fable", "other"] as const;
export type CostFamily = (typeof COST_FAMILIES)[number];

export const FAMILY_LABEL: Record<CostFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  other: "Other",
};

export type CostPeriod = "day" | "week";

export type CostBar = {
  /** First date it covers, `YYYY-MM-DD`. */
  date: string;
  label: string;
  segments: { family: CostFamily; usd: number }[];
  total: number;
  saved: number;
};

const DAY_BARS = 14;
const WEEK_BARS = 8;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEKS_ASKED = WEEK_BARS * 7;

/**
 * This zone's UTC offsets over the period, as `[from, seconds]` pairs oldest
 * first, in epoch seconds. Rust dates each call with the offset of that moment,
 * since a date across a daylight-saving change has a different one.
 */
export function zoneOffsets(now: number, days: number): [number, number][] {
  const offsetAt = (ms: number) => -new Date(ms).getTimezoneOffset() * 60;
  // A day extra: the start of the period is local midnight, a little earlier.
  const start = now - (days + 1) * DAY_MS;
  const offsets: [number, number][] = [
    [Math.floor(start / 1000), offsetAt(start)],
  ];
  for (let at = start + HOUR_MS; at <= now; at += HOUR_MS) {
    const offset = offsetAt(at);
    if (offset !== offsets[offsets.length - 1][1]) {
      offsets.push([Math.floor(at / 1000), offset]);
    }
  }
  return offsets;
}

export const loadCostReport = () =>
  invoke<CostReport>("fork_cost_report", {
    days: WEEKS_ASKED,
    offsets: zoneOffsets(Date.now(), WEEKS_ASKED),
  });

const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fromKey = (date: string) => Date.parse(`${date}T00:00:00Z`);

function shortDate(date: string): string {
  return new Date(fromKey(date)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Bars ending today, with empty days kept: a gap in the work should look like a
 * gap. A week is the seven days ending that day, so this week is always whole.
 */
export function costBars(
  report: CostReport,
  period: CostPeriod,
  today: string,
): CostBar[] {
  const size = period === "day" ? 1 : 7;
  const count = period === "day" ? DAY_BARS : WEEK_BARS;
  const byDate = new Map(report.days.map((day) => [day.date, day]));
  const end = fromKey(today);
  const bars: CostBar[] = [];
  for (let bar = count - 1; bar >= 0; bar--) {
    const last = end - bar * size * DAY_MS;
    const first = last - (size - 1) * DAY_MS;
    const totals = new Map<CostFamily, number>();
    let saved = 0;
    for (let at = first; at <= last; at += DAY_MS) {
      const day = byDate.get(dateKey(at));
      if (!day) continue;
      saved += day.savedUsd;
      for (const [family, usd] of Object.entries(day.byFamily)) {
        const known = COST_FAMILIES.includes(family as CostFamily)
          ? (family as CostFamily)
          : "other";
        totals.set(known, (totals.get(known) ?? 0) + usd);
      }
    }
    const segments = COST_FAMILIES.flatMap((family) => {
      const usd = totals.get(family) ?? 0;
      return usd > 0 ? [{ family, usd }] : [];
    });
    bars.push({
      date: dateKey(first),
      label:
        size === 1
          ? shortDate(dateKey(first))
          : `${shortDate(dateKey(first))} to ${shortDate(dateKey(last))}`,
      segments,
      total: segments.reduce((sum, segment) => sum + segment.usd, 0),
      saved,
    });
  }
  return bars;
}

/** The headline: the last seven days, against the seven before. */
export function costSummary(report: CostReport, today: string) {
  const end = fromKey(today);
  const sum = (from: number, to: number) => {
    let usd = 0;
    let saved = 0;
    for (const day of report.days) {
      const at = fromKey(day.date);
      if (at < from || at > to) continue;
      usd += Object.values(day.byFamily).reduce((all, value) => all + value, 0);
      saved += day.savedUsd;
    }
    return { usd, saved };
  };
  const week = sum(end - 6 * DAY_MS, end);
  const before = sum(end - 13 * DAY_MS, end - 7 * DAY_MS);
  return {
    usd: week.usd,
    saved: week.saved,
    previousUsd: before.usd,
    change: before.usd > 0 ? (week.usd - before.usd) / before.usd : null,
  };
}

export function formatUsd(usd: number): string {
  if (usd >= 1000) {
    return `$${Math.round(usd).toLocaleString("en-US")}`;
  }
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function localToday(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A model's short name for the table: `claude-opus-5-5` reads `Opus 5.5`. */
export function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!match) return model;
  const name = match[1][0].toUpperCase() + match[1].slice(1);
  return match[3] ? `${name} ${match[2]}.${match[3]}` : `${name} ${match[2]}`;
}
