import { afterEach, describe, expect, it } from "vitest";
import {
  costBars,
  costSummary,
  formatTokens,
  formatUsd,
  modelLabel,
  zoneOffsets,
  type CostReport,
} from "./costModel";

const day = (date: string, opus: number, saved = 0, extra = {}) => ({
  date,
  byFamily: { opus, ...extra },
  savedUsd: saved,
});
const report = (days: CostReport["days"]): CostReport => ({
  days,
  models: [],
  accounts: {},
  unpriced: [],
  unreadable: 0,
});
const TODAY = "2026-10-31";

describe("costBars", () => {
  it("ends on today and keeps empty days", () => {
    const bars = costBars(report([day(TODAY, 2)]), "day", TODAY);
    expect(bars).toHaveLength(14);
    expect(bars.at(-1)?.date).toBe(TODAY);
    expect(bars.at(-1)?.total).toBe(2);
    expect(bars[0].date).toBe("2026-10-18");
    expect(bars[0].total).toBe(0);
    expect(bars[0].segments).toEqual([]);
  });

  it("adds whole weeks up, the last ending today", () => {
    const bars = costBars(
      report([
        day("2026-10-25", 1, 0.5),
        day(TODAY, 2, 0.25),
        day("2026-10-24", 8),
      ]),
      "week",
      TODAY,
    );
    expect(bars).toHaveLength(8);
    expect(bars.at(-1)?.total).toBe(3);
    expect(bars.at(-1)?.saved).toBe(0.75);
    expect(bars.at(-2)?.total).toBe(8);
    expect(bars.at(-1)?.date).toBe("2026-10-25");
  });

  it("keeps models in a fixed order, whichever came first", () => {
    const bars = costBars(
      report([{ date: TODAY, byFamily: { haiku: 1, opus: 1, odd: 1 }, savedUsd: 0 }]),
      "day",
      TODAY,
    );
    expect(bars.at(-1)?.segments.map((segment) => segment.family)).toEqual([
      "opus",
      "haiku",
      "other",
    ]);
  });

  it("crosses a daylight-saving change without a duplicate or a gap", () => {
    const bars = costBars(report([]), "day", "2026-10-06");
    const dates = bars.map((bar) => bar.date);
    expect(new Set(dates).size).toBe(14);
    expect(dates[0]).toBe("2026-09-23");
  });
});

describe("costSummary", () => {
  it("compares the last seven days with the seven before", () => {
    const summary = costSummary(
      report([
        day(TODAY, 30, 5),
        day("2026-10-25", 10, 1),
        day("2026-10-24", 20),
        day("2026-10-18", 5),
        day("2026-10-17", 100),
      ]),
      TODAY,
    );
    expect(summary.usd).toBe(40);
    expect(summary.saved).toBe(6);
    expect(summary.previousUsd).toBe(25);
    expect(summary.change).toBeCloseTo(0.6);
  });

  it("has no change to show without a previous week", () => {
    expect(costSummary(report([day(TODAY, 1)]), TODAY).change).toBeNull();
  });
});

describe("formatting", () => {
  it("rounds money to what's worth reading", () => {
    expect(formatUsd(3.456)).toBe("$3.46");
    expect(formatUsd(123.4)).toBe("$123");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("shortens token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12K");
    expect(formatTokens(3_400_000)).toBe("3.4M");
    expect(formatTokens(2_100_000_000)).toBe("2.1B");
  });

  it("names models plainly", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("something-else")).toBe("something-else");
  });
});

describe("zoneOffsets", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it("finds Melbourne's change to daylight time", () => {
    process.env.TZ = "Australia/Melbourne";
    const offsets = zoneOffsets(Date.parse("2026-10-31T12:00:00Z"), 56);
    expect(offsets.map(([, seconds]) => seconds)).toEqual([36_000, 39_600]);
    // Clocks went forward at 16:00 UTC on 3 October 2026.
    expect(offsets[1][0]).toBe(Date.parse("2026-10-03T16:00:00Z") / 1000);
  });

  it("has one entry where nothing changes", () => {
    process.env.TZ = "Asia/Kolkata";
    const offsets = zoneOffsets(Date.parse("2026-10-31T12:00:00Z"), 56);
    expect(offsets).toHaveLength(1);
    expect(offsets[0][1]).toBe(19_800);
  });
});
