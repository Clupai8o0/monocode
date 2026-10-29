import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves the Memory manager's park is safe: parking an idle Claude session
// kills its process, and the next message respawns Claude with --resume and
// the same provider session id, so the conversation carries on.

const sent: string[] = [];
const spawned: string[][] = [];
const killed: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));

vi.mock("../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async (id: string) => {
    killed.push(id);
  },
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const { stopClaudeSession, __claudeTestReset } = await import(
  "../../integrations/harness/providers/claude/claude"
);
const { claudeAdapter } = await import(
  "../../integrations/harness/providers/claude/claudeAdapter"
);
const {
  harnessIdleSince,
  parkIdleHarnessSession,
  registerHarness,
  resetHarnessIdlePark,
  sendHarnessTurn,
} = await import("../../integrations/harness/core/registry");

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const userCount = () => parse().filter((m) => m.type === "user").length;

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function turn(text: string) {
  return sendHarnessTurn({
    harness: "claude",
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text,
    attachments: [],
    onEvent: () => undefined,
  });
}

/** Answer the initialize handshake, wait for the prompt, then finish the turn. */
async function finishTurn(before: number, initRequestId: string | null) {
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  if (initRequestId) {
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: initRequestId },
    });
  }
  await waitFor(() => userCount() > before, "user prompt");
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  killed.length = 0;
  onLine = undefined;
  __claudeTestReset();
  resetHarnessIdlePark();
  registerHarness(claudeAdapter);
});

afterEach(async () => {
  await stopClaudeSession("s1");
  resetHarnessIdlePark();
  __claudeTestReset();
});

describe("memory park", () => {
  it("parks an idle Claude session and resumes the same conversation on the next message", async () => {
    const first = turn("remember the number 7");
    await waitFor(() => spawned.length === 1, "first spawn");
    await waitFor(() => onLine !== undefined && sent.length > 0, "initialize");
    await finishTurn(0, "monocode_1");
    await first;
    // The settled turn leaves the operation queue on the next tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(harnessIdleSince("s1")).toEqual(expect.any(Number));
    expect(await parkIdleHarnessSession("s1")).toBe(true);
    expect(killed).toContain("s1");
    expect(harnessIdleSince("s1")).toBeUndefined();
    // A parked session is not parked twice.
    expect(await parkIdleHarnessSession("s1")).toBe(false);

    const before = userCount();
    const second = turn("what was the number?");
    await waitFor(() => spawned.length === 2, "respawn");
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    expect(spawned[1]).not.toContain("--session-id");
    await waitFor(() => sent.length > 0 && parse().some((m) => {
      const request = m.request as Record<string, unknown> | undefined;
      return request?.subtype === "initialize" && m.request_id !== "monocode_1";
    }), "second initialize");
    const init = parse().filter((m) => {
      const request = m.request as Record<string, unknown> | undefined;
      return request?.subtype === "initialize";
    }).at(-1)!;
    await finishTurn(before, String(init.request_id));
    await second;
  });

  it("refuses a session whose turn is still running", async () => {
    const running = turn("long job");
    await waitFor(() => spawned.length === 1, "spawn");
    expect(await parkIdleHarnessSession("s1")).toBe(false);
    expect(killed).not.toContain("s1");
    await waitFor(() => onLine !== undefined && sent.length > 0, "initialize");
    await finishTurn(0, "monocode_1");
    await running;
  });

  it("makes a message sent while parking wait, then resume", async () => {
    const first = turn("hello");
    await waitFor(() => spawned.length === 1, "first spawn");
    await waitFor(() => onLine !== undefined && sent.length > 0, "initialize");
    await finishTurn(0, "monocode_1");
    await first;
    await new Promise((r) => setTimeout(r, 0));

    const parking = parkIdleHarnessSession("s1");
    const before = userCount();
    const next = turn("are you there?");
    expect(await parking).toBe(true);
    await waitFor(() => spawned.length === 2, "respawn after park");
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    await waitFor(() => parse().filter((m) => {
      const request = m.request as Record<string, unknown> | undefined;
      return request?.subtype === "initialize";
    }).length === 2, "second initialize");
    const init = parse().filter((m) => {
      const request = m.request as Record<string, unknown> | undefined;
      return request?.subtype === "initialize";
    }).at(-1)!;
    await finishTurn(before, String(init.request_id));
    await next;
  });

  it("refuses a session it has never seen", async () => {
    expect(await parkIdleHarnessSession("nobody")).toBe(false);
  });
});
