import { describe, expect, it } from "vitest";
import {
  getExtraUsage,
  parseAntigravityQuota,
  parseDeepseekBalance,
  parseMuseUsage,
} from "./extraUsage";

describe("parseMuseUsage", () => {
  it("reads the rolling and weekly windows from `muse usage --json`", () => {
    const usage = parseMuseUsage(
      JSON.stringify({
        schemaVersion: 1,
        allowance: {
          tier: "Muse Code Power Usage",
          window: { usedPercent: 60, resetsAtMs: 1793102467000 },
          weekly: { usedPercent: 20, resetsAtMs: 1793577600000 },
          asOfMs: 1793098741345,
          source: "mint",
        },
        reason: null,
        hint: null,
      }),
    );
    expect(usage).toMatchObject({
      status: "ok",
      detail: "Muse Code Power Usage",
      bars: [
        { label: "now", usedPercent: 60, resetsAt: 1793102467000 },
        { label: "wk", usedPercent: 20, resetsAt: 1793577600000 },
      ],
    });
  });

  it("reports an error when Muse has no allowance", () => {
    expect(
      parseMuseUsage(JSON.stringify({ allowance: null, reason: "signed out" })),
    ).toMatchObject({ status: "error" });
  });
});

describe("parseAntigravityQuota", () => {
  it("turns each group's remaining fraction into used percent", () => {
    const usage = parseAntigravityQuota(
      JSON.stringify({
        status: "SUCCESS",
        num_turns: 0,
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    window: "weekly",
                    remaining_fraction: 0.75,
                    reset_time: "2026-10-31T04:32:29Z",
                  },
                  {
                    id: "gemini-5h",
                    window: "5h",
                    remaining_fraction: 1,
                    reset_time: "2026-10-27T16:01:02Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    id: "third-party-5h",
                    window: "5h",
                    remaining_fraction: 0.1,
                    reset_time: "2026-10-27T16:01:39Z",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(usage).toMatchObject({
      status: "ok",
      bars: [
        {
          label: "wk",
          group: "Gemini",
          usedPercent: 25,
          resetsAt: Date.parse("2026-10-31T04:32:29Z"),
        },
        { label: "5h", group: "Gemini", usedPercent: 0 },
        { label: "5h", group: "Claude and GPT" },
      ],
    });
    expect(usage.status === "ok" && usage.bars[2]!.usedPercent).toBeCloseTo(90);
  });

  it("reports an error when agy prints no quota", () => {
    expect(
      parseAntigravityQuota(JSON.stringify({ status: "SUCCESS" })),
    ).toMatchObject({ status: "error" });
  });
});

describe("parseDeepseekBalance", () => {
  it("shows the prepaid balance with its currency", () => {
    expect(
      parseDeepseekBalance(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "1.95",
              granted_balance: "0.00",
              topped_up_balance: "1.95",
            },
            { currency: "CNY", total_balance: "10" },
          ],
        }),
      ),
    ).toMatchObject({ status: "ok", bars: [], detail: "$1.95 · ¥10.00 left" });
  });

  it("reports an error without a balance", () => {
    expect(
      parseDeepseekBalance(JSON.stringify({ balance_infos: [] })),
    ).toMatchObject({ status: "error" });
  });
});

it("hands React the same idle snapshot until a read lands", () => {
  expect(getExtraUsage("muse")).toBe(getExtraUsage("muse"));
});
