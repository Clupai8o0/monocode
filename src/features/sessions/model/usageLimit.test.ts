import { describe, expect, it } from "vitest";
import { newSession, type Session } from "./session";
import {
  accountPickAction,
  formatUsageLimitReset,
  USAGE_LIMIT_RESUME_GRACE_MS,
  usageLimitResumeDue,
  usageLimitFromError,
  resumeUsageLimitedSession,
  withUsageLimitAccount,
  cancelledAccountTransferSession,
} from "./usageLimit";

describe("cancelled account transfer binding", () => {
  it.each(["claude", "codex"] as const)("keeps the %s conversation when its settings change during copying", (harness) => {
    const original = { ...newSession(harness, "/repo"), providerSessionId: "conversation", providerAccountId: "default" };
    const latest = { ...original, modelSettings: { effort: "high" }, usageLimit: undefined };
    const restored = cancelledAccountTransferSession(original, latest);
    expect(restored).toBe(latest);
    expect(restored?.providerSessionId).toBe("conversation");
    expect(restored?.providerAccountId).toBe("default");
    expect(restored?.modelSettings).toEqual({ effort: "high" });
  });
  it("never restores over a different provider, account, thread or deleted session", () => {
    const original = { ...newSession("codex", "/repo"), providerSessionId: "conversation", providerAccountId: "default" };
    for (const latest of [undefined, { ...original, id: "different-session" }, { ...original, harness: "claude" as const }, { ...original, providerAccountId: "second" }, { ...original, providerSessionId: "different-thread" }]) {
      expect(cancelledAccountTransferSession(original, latest)).toBeUndefined();
    }
  });
});

function limited(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("codex", "/tmp/project"),
    usageLimit: { resetsAt: 10_000, resumeAtReset: true },
    ...patch,
  };
}

describe("usageLimitResumeDue", () => {
  it("waits for the reset plus a grace period", () => {
    expect(usageLimitResumeDue(limited(), 10_000)).toBe(false);
    expect(
      usageLimitResumeDue(limited(), 10_000 + USAGE_LIMIT_RESUME_GRACE_MS),
    ).toBe(true);
  });

  it("only resumes idle sessions the user armed", () => {
    const later = 10_000 + USAGE_LIMIT_RESUME_GRACE_MS;
    expect(usageLimitResumeDue(limited({ busy: true }), later)).toBe(false);
    expect(
      usageLimitResumeDue(limited({ usageLimit: { resetsAt: 10_000 } }), later),
    ).toBe(false);
    expect(
      usageLimitResumeDue(
        limited({ usageLimit: { resumeAtReset: true } }),
        later,
      ),
    ).toBe(false);
  });
});

describe("provider error fallback", () => {
  it.each([
    "You've hit your usage limit.",
    "Quota exceeded for this account",
    "insufficient_quota",
    "Credit balance is too low",
    "Monthly limit exceeded",
    "usage_limit_exceeded",
    "You've used 100% of your included usage",
    "Your on-demand usage limit was reached",
  ])("recognizes an exhausted account: %s", (message) => {
    expect(usageLimitFromError(message)).toEqual({});
  });

  it("keeps a known reset time on the limit", () => {
    expect(usageLimitFromError("You've hit your usage limit.", 1_800)).toEqual({
      resetsAt: 1_800,
    });
  });

  it.each([
    "429: rate limit exceeded, retry in 3 seconds",
    "Server overloaded",
    "Context window exceeded",
    "Invalid API key",
    "Network timeout",
  ])("keeps other failures out of usage recovery: %s", (message) => {
    expect(usageLimitFromError(message)).toBeUndefined();
  });
});

it("only releases the outbox of an idle usage-limited session", () => {
  const session = limited({
    queueStatus: "paused",
    queuedMessages: [
      {
        id: "head",
        text: "Check tests",
        attachments: [],
        error: "Quota exceeded",
      },
    ],
  });
  const resumed = resumeUsageLimitedSession(session);
  expect(resumed.usageLimit).toBeUndefined();
  expect(resumed.queueStatus).toBe("active");
  expect(resumed.queuedMessages).toEqual([
    { id: "head", text: "Check tests", attachments: [], error: undefined },
  ]);
  expect(resumeUsageLimitedSession({ ...session, busy: true }).usageLimit).toBe(
    session.usageLimit,
  );
  const ordinary = { ...session, usageLimit: undefined };
  expect(resumeUsageLimitedSession(ordinary)).toBe(ordinary);
});

describe("formatUsageLimitReset", () => {
  it("shows the time and what is left", () => {
    const now = new Date(2026, 8, 25, 22, 34).getTime();
    const today = new Date(2026, 8, 25, 23, 50).getTime();
    expect(formatUsageLimitReset(today, now)).toMatch(/ · in 1h 16m$/);
    const tomorrow = new Date(2026, 8, 26, 3, 16).getTime();
    expect(formatUsageLimitReset(tomorrow, now)).toMatch(/26.* · in 4h 42m$/);
  });
});

describe("withUsageLimitAccount", () => {
  it("keeps the provider session when the transcript was carried over", () => {
    const original = limited({
      providerSessionId: "thread-1",
      providerAccountId: "personal",
    });
    const next = withUsageLimitAccount(original, "work", true);
    expect(next.providerAccountId).toBe("work");
    expect(next.providerSessionId).toBe("thread-1");
    expect(next.pendingSwitch).toBeUndefined();
  });

  it("hands off to a new provider session without asking the limited account", () => {
    const original = limited({
      providerSessionId: "thread-1",
      providerAccountId: "personal",
    });
    const next = withUsageLimitAccount(original, "work", false);
    expect(next.providerAccountId).toBe("work");
    expect(next.providerSessionId).toBeUndefined();
    expect(next.pendingSwitch).toMatchObject({
      from: "codex",
      fromProviderSessionId: "thread-1",
      fromProviderAccountId: "personal",
      skipOutgoingRecap: true,
    });
  });
});

describe("accountPickAction", () => {
  const talked = (patch: Partial<Session> = {}): Session => ({
    ...newSession("claude", "/tmp/project"),
    blocks: [{ id: "u1", role: "user", text: "hi" }],
    providerSessionId: "sess_1",
    ...patch,
  });

  it("moves an idle conversation to the picked account", () => {
    expect(accountPickAction(talked(), "account-b", false)).toBe("move");
  });

  it("moves a limited conversation, Mono or not", () => {
    expect(
      accountPickAction(talked({ usageLimit: {} }), "account-b", true),
    ).toBe("move");
  });

  it("keeps a running turn on its account and opens a fresh session", () => {
    expect(accountPickAction(talked({ busy: true }), "account-b", false)).toBe(
      "open",
    );
    expect(accountPickAction(talked(), "account-b", true)).toBe("open");
  });

  it("gives an empty session the account and ignores the same account", () => {
    expect(accountPickAction(talked({ blocks: [] }), "account-b", false)).toBe(
      "assign",
    );
    expect(accountPickAction(talked(), "default", false)).toBe("none");
  });
});
