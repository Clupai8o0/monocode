// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  newSession,
  type Session,
} from "../../features/sessions/model/session";
import { saveProviderAccount } from "../../features/providers/model/providerAccounts";
import type { ProviderRateLimits } from "../../features/providers/model/rateLimits";
import { loadRateLimits } from "../../features/providers/model/rateLimitsCache";
import { useAutoAccountSwitch } from "./useAutoAccountSwitch";

vi.mock("../../features/providers/model/rateLimitsCache", () => ({
  loadRateLimits: vi.fn(),
}));
let root: Root;
const move = vi.fn(async (_id: string, _account: string) => {});
const connected = () => true;
let current: Session[];
let revision = 0;
const read = () => current;
function Harness() {
  useAutoAccountSwitch(current, read, move, connected, () => revision);
  return null;
}
function usage(
  provider: "claude" | "codex",
  usedPercent = 20,
): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: Date.now() + 3_600_000,
    },
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}
function limited(provider: "claude" | "codex"): Session {
  return {
    ...newSession(provider, "/repo"),
    providerAccountId: "default",
    usageLimit: { resetsAt: Date.now() + 3_600_000 },
  };
}
async function render(session: Session) {
  current = [session];
  await act(async () => {
    root.render(createElement(Harness));
  });
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  vi.clearAllMocks();
  revision = 0;
  root = createRoot(document.createElement("div"));
  for (const provider of ["claude", "codex"] as const) {
    saveProviderAccount({ id: "second", provider, label: "Second" });
  }
  vi.mocked(loadRateLimits).mockImplementation(async (provider) =>
    usage(provider as "claude" | "codex"),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it.each(["claude", "codex"] as const)(
  "automatically moves a limited %s conversation once",
  async (provider) => {
    const session = limited(provider);
    await render(session);
    await render({ ...session, usageLimit: { ...session.usageLimit! } });
    expect(move).toHaveBeenCalledExactlyOnceWith(session.id, "second");
  },
);
it("does not switch because cached usage is low, or during a running turn", async () => {
  const session = limited("codex");
  await render({ ...session, usageLimit: undefined });
  await render({ ...session, busy: true });
  expect(move).not.toHaveBeenCalled();
  await render(session);
  expect(move).toHaveBeenCalledTimes(1);
});
it("stays paused when both accounts are exhausted or the probe fails", async () => {
  vi.mocked(loadRateLimits).mockResolvedValue(usage("codex", 100));
  await render(limited("codex"));
  vi.mocked(loadRateLimits).mockResolvedValue({
    ...usage("claude"),
    status: "error",
    error: "offline",
  });
  await render(limited("claude"));
  expect(move).not.toHaveBeenCalled();
});
it("never bounces back to an account that just reported a limit", async () => {
  const session = limited("codex");
  await render(session);
  await render({ ...session, providerAccountId: "second", usageLimit: {} });
  expect(move).toHaveBeenCalledTimes(1);
});
it("abandons a probe if the user resumed or changed the session", async () => {
  let resolve!: (limits: ProviderRateLimits) => void;
  vi.mocked(loadRateLimits).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const session = limited("codex");
  await render(session);
  await render({ ...session, usageLimit: undefined });
  await act(async () => {
    resolve(usage("codex"));
  });
  expect(move).not.toHaveBeenCalled();
});
it("does not resume removed worktrees, remote sessions or unanswered questions", async () => {
  const session = limited("claude");
  for (const extra of [
    { worktreeRemoved: true },
    { cwd: "remote://host/repo" },
    { pendingQuestion: {} },
    { ephemeral: true },
    { orchestrationLeadId: "lead" },
    { blocks: [{ id: "draft", role: "user", text: "unsent", draft: true }] },
  ]) {
    await render({ ...session, ...extra } as Session);
  }
  expect(move).not.toHaveBeenCalled();
});

it("does not confuse a rejected app continuation with exhausted allowance", async () => {
  const session = limited("codex");
  await render({
    ...session,
    providerAccountId: "second",
    usageLimit: { recoveryFailed: true },
  });
  expect(move).not.toHaveBeenCalled();
  await render(session);
  expect(move).toHaveBeenCalledExactlyOnceWith(session.id, "second");
});
it("does not retry a failed account move on unrelated renders", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  move.mockRejectedValueOnce(new Error("copy failed"));
  const session = limited("codex");
  await render(session);
  await render({ ...session });
  expect(move).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledOnce();
  warning.mockRestore();
});

it("does not move a deleted session during a probe", async () => {
  let resolve!: (limits: ProviderRateLimits) => void;
  vi.mocked(loadRateLimits).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render(limited("codex"));
  current = [];
  await act(async () => {
    root.render(createElement(Harness));
    resolve(usage("codex"));
  });
  expect(move).not.toHaveBeenCalled();
});

it("does not move a session after the controller unmounts", async () => {
  let resolve!: (limits: ProviderRateLimits) => void;
  vi.mocked(loadRateLimits).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render(limited("claude"));
  await act(async () => {
    root.render(null);
  });
  await act(async () => {
    resolve(usage("claude"));
  });
  expect(move).not.toHaveBeenCalled();
});

it("ignores a target removed while its usage was being checked", async () => {
  let resolve!: (limits: ProviderRateLimits) => void;
  vi.mocked(loadRateLimits).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render(limited("codex"));
  localStorage.setItem("monocode.providerAccounts.v1", "{}");
  await act(async () => {
    resolve(usage("codex"));
  });
  expect(move).not.toHaveBeenCalled();
});

it("honors Stop while the usage probe is pending even if the limit notice remains", async () => {
  let resolve!: (limits: ProviderRateLimits) => void;
  vi.mocked(loadRateLimits).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render(limited("codex"));
  revision += 1;
  await act(async () => {
    resolve(usage("codex"));
  });
  expect(move).not.toHaveBeenCalled();
});

it("retries after a workspace move temporarily suspends the probe", async () => {
  let resolve!: (limits: ProviderRateLimits) => void;
  vi.mocked(loadRateLimits).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const session = limited("codex");
  await render(session);
  await render({ ...session, worktreePreparing: true });
  await act(async () => {
    resolve(usage("codex"));
  });
  expect(move).not.toHaveBeenCalled();
  await render(session);
  expect(move).toHaveBeenCalledExactlyOnceWith(session.id, "second");
});

it("honors a reset time discovered after the first attempt", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const session = { ...limited("codex"), usageLimit: {} };
    await render(session);
    await render({ ...session, usageLimit: { resetsAt: now + 3_600_000 } });
    clock.mockReturnValue(now + 360_000);
    await render({ ...session, providerAccountId: "second" });
    expect(move).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

it("lets another session use a recovered account even while an old limit notice remains", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const first = {
      ...limited("codex"),
      usageLimit: { resetsAt: now + 60_000 },
    };
    await render(first);
    clock.mockReturnValue(now + 120_000);
    await render({ ...first });
    await render({
      ...first,
      id: "another-session",
      providerAccountId: "second",
      usageLimit: {},
    });
    expect(move).toHaveBeenLastCalledWith("another-session", "default");
  } finally {
    clock.mockRestore();
  }
});

it("does not let a remote account's limit block the local default login", async () => {
  await render({ ...limited("codex"), cwd: "remote://other/repo" });
  const local = { ...limited("codex"), providerAccountId: "second" };
  await render(local);
  expect(move).toHaveBeenCalledExactlyOnceWith(local.id, "default");
});
