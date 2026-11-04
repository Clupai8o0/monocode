import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const {
  cursorUsageResetsAt,
  getExtraUsage,
  loadExtraUsage,
  parseAntigravityQuota,
  parseCursorUsage,
  parseDeepseekBalance,
  parseMuseUsage,
  parseGrokUsage,
} = await import("./extraUsage");

describe("parseGrokUsage", () => {
  it("reads the shared weekly allowance and reset from Grok credits", () => {
    expect(parseGrokUsage(JSON.stringify({ config: {
      creditUsagePercent: 24,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-09T09:16:22.490Z" },
    } }))).toMatchObject({ status: "ok", bars: [
      { label: "wk", usedPercent: 24, resetsAt: Date.parse("2026-11-09T09:16:22.490Z") },
    ] });
  });

  it("accepts zero usage without mistaking a missing allowance for zero", () => {
    expect(parseGrokUsage('{"config":{"creditUsagePercent":0}}')).toMatchObject({
      status: "ok", bars: [{ label: "Plan", usedPercent: 0, resetsAt: null }],
    });
    expect(parseGrokUsage('{"config":{}}').status).toBe("error");
  });

  it("handles monthly periods and invalid reset dates", () => {
    expect(parseGrokUsage(JSON.stringify({ config: {
      creditUsagePercent: 120,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" },
    } }))).toMatchObject({ status: "ok", bars: [
      { label: "mo", usedPercent: 100, resetsAt: null },
    ] });
  });
});

beforeEach(() => {
  invoke.mockReset();
});

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

describe("parseCursorUsage", () => {
  it("reads Auto and API pools from GetCurrentPeriodUsage", () => {
    const usage = parseCursorUsage(
      JSON.stringify({
        billingCycleStart: "1793610982490",
        billingCycleEnd: "1794215782490",
        planUsage: {
          autoPercentUsed: 22.6,
          apiPercentUsed: 0,
          totalPercentUsed: 22.6,
        },
        displayMessage: "You've used 23% of your included usage",
      }),
    );
    expect(usage).toMatchObject({
      status: "ok",
      detail: "You've used 23% of your included usage",
      bars: [
        { label: "Auto", usedPercent: 22.6, resetsAt: 1794215782490 },
        { label: "API", usedPercent: 0, resetsAt: 1794215782490 },
      ],
    });
  });

  it("falls back to the total when Auto and API are missing", () => {
    expect(
      parseCursorUsage(
        JSON.stringify({
          billingCycleEnd: "2026-11-10T12:00:00.000Z",
          planUsage: { totalPercentUsed: 41 },
        }),
      ),
    ).toMatchObject({
      status: "ok",
      bars: [
        {
          label: "plan",
          usedPercent: 41,
          resetsAt: Date.parse("2026-11-10T12:00:00.000Z"),
        },
      ],
    });
  });

  it("reports an error when Cursor has no plan meters", () => {
    expect(parseCursorUsage(JSON.stringify({ planUsage: {} }))).toMatchObject({
      status: "error",
      message: "Cursor did not report usage",
    });
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

it("exposes Cursor's next billing-cycle end after a successful read", async () => {
  const end = Date.now() + 86_400_000;
  invoke.mockResolvedValue({
    status: "ok",
    body: JSON.stringify({
      billingCycleEnd: String(end),
      planUsage: { autoPercentUsed: 40, apiPercentUsed: 10 },
    }),
  });
  await loadExtraUsage("cursor", true);
  expect(cursorUsageResetsAt(Date.now())).toBe(end);
});
