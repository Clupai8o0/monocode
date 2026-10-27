import { beforeEach, expect, it, vi } from "vitest";
import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
} from "../src/features/providers/model/rateLimitsFetch";
import { hostAccounts } from "./accounts";
import { createMobileUsage } from "./mobile-usage";

vi.mock("./accounts", () => ({ hostAccounts: vi.fn() }));

vi.mock("../src/features/providers/model/rateLimitsFetch", () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchCodexRateLimits: vi.fn(),
}));

const claude = vi.mocked(fetchClaudeRateLimits);
const codex = vi.mocked(fetchCodexRateLimits);

function limits(provider: "claude" | "codex", usedPercent: number | null) {
  const window =
    usedPercent === null
      ? null
      : { usedPercent, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 };
  return {
    provider,
    session: window,
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: Date.now(),
    error: usedPercent === null ? "Claude sign-in expired" : null,
    status: usedPercent === null ? ("error" as const) : ("ok" as const),
  };
}

const account = (provider: "claude" | "codex", id: string) => ({
  id,
  provider,
  label: id,
  dir: `/home/u/.${provider}-${id}`,
  isDefault: id === "default",
});

beforeEach(() => {
  claude.mockReset();
  codex.mockReset();
  vi.mocked(hostAccounts).mockReturnValue([
    account("claude", "default"),
    account("codex", "default"),
  ]);
});

it("answers from its cache until asked to refresh", async () => {
  claude.mockResolvedValue(limits("claude", 40) as never);
  const usage = createMobileUsage();
  const first = await usage({ provider: "claude" });
  await usage({ provider: "claude" });
  expect(claude).toHaveBeenCalledTimes(1);
  expect(first.accounts.default.meters[0]?.usedPercent).toBe(40);
  await usage({ provider: "claude", refresh: true });
  expect(claude).toHaveBeenCalledTimes(2);
});

it("probes once for two asks at the same time", async () => {
  let finish!: (value: never) => void;
  codex.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const usage = createMobileUsage();
  const both = Promise.all([
    usage({ provider: "codex" }),
    usage({ provider: "codex", refresh: true }),
  ]);
  finish(limits("codex", 10) as never);
  await both;
  expect(codex).toHaveBeenCalledTimes(1);
});

it("keeps the last reading, marked stale, when a probe fails", async () => {
  claude.mockResolvedValueOnce(limits("claude", 70) as never);
  claude.mockResolvedValueOnce(limits("claude", null) as never);
  claude.mockRejectedValueOnce(new Error("offline"));
  const usage = createMobileUsage();
  await usage({ provider: "claude" });
  const failed = await usage({ provider: "claude", refresh: true });
  expect(failed.accounts.default.meters[0]?.usedPercent).toBe(70);
  expect(failed.accounts.default.stale).toBe(true);
  const thrown = await usage({ provider: "claude", refresh: true });
  expect(thrown.accounts.default.meters[0]?.usedPercent).toBe(70);
});

it("refuses providers that report no usage", async () => {
  await expect(createMobileUsage()({ provider: "opencode" })).rejects.toThrow(
    /only available/,
  );
});

it("reads every account the provider is signed in with", async () => {
  vi.mocked(hostAccounts).mockReturnValue([
    account("claude", "default"),
    account("claude", "exec"),
    account("codex", "default"),
  ]);
  claude.mockImplementation(async (id) =>
    limits("claude", id === "exec" ? 90 : 5) as never,
  );
  const usage = await createMobileUsage()({ provider: "claude" });
  expect(claude.mock.calls.map(([id]) => id).sort()).toEqual(["default", "exec"]);
  expect(usage.accounts.exec.meters[0]?.usedPercent).toBe(90);
  expect(usage.accounts.default.meters[0]?.usedPercent).toBe(5);
});
