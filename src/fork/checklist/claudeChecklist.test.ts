import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import type { HarnessEvent } from "../../integrations/harness/core/types";
import { newSession } from "../../features/sessions/model/session";
import { checklistFromBlocks } from "./checklist";

// Drives the real Claude provider with a fake CLI, as claudeLive.test.ts does.
const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import(
  "../../integrations/harness/providers/claude/claude"
);

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTurn() {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "give me the steps",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(
    () =>
      parse().some(
        (m) =>
          (m.request as Record<string, unknown> | undefined)?.subtype ===
          "initialize",
      ),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

function emitTool(id: string, input: Record<string, unknown>, isError = false) {
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "mcp__side-checklist__checklist",
          input,
        },
      ],
    },
  });
  emit({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: "ok",
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  });
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("claude side-checklist calls", () => {
  it("build the sidebar list from the session's events", async () => {
    const { events, turn } = await startTurn();
    emitTool("toolu_1", {
      action: "set",
      title: "Release",
      items: [{ text: "Tag it", who: "Sam" }, "Announce"],
    });
    emitTool("toolu_2", { action: "check", numbers: [1] });
    emitTool("toolu_3", { action: "clear" }, true);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      (current, event) => applyHarnessEvent(current, event),
      newSession("claude", "/repo"),
    );
    expect(checklistFromBlocks(session.blocks)).toEqual({
      title: "Release",
      items: [
        { text: "Tag it", done: true, who: "Sam" },
        { text: "Announce", done: false },
      ],
    });
  });
});
