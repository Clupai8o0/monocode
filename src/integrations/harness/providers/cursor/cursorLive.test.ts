import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const processControl = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }));
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveCursorBinary: async () => ({ path: "/fake/cursor-agent" }),
  spawnChild: processControl.spawn,
  killChild: processControl.kill,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (value: string) => void,
    exit: (code: number) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const stores = vi.hoisted(() => ({ tools: vi.fn(), subagents: vi.fn() }));
vi.mock("./cursorStore", () => ({
  readStoredCursorToolCalls: stores.tools,
  readStoredCursorSubagentRuns: stores.subagents,
}));

const {
  sendCursorTurn,
  cancelCursorTurn,
  stopCursorSession,
  compactCursorContext,
  respondCursorApproval,
  __cursorTestReset,
} = await import("./cursor");
import type { HarnessEvent } from "../../core/types";
import { newSession } from "../../../../features/sessions/model/session";
import { applyHarnessEvent } from "../../core/apply";

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function notify(method: string, params: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

function request(id: number, method: string, params: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse())}`,
  );
};

function outboundRequest(method: string) {
  return parse().find((message) => message.method === method);
}

async function startTurn(
  sessionId: string,
  intent?: "plan",
  onEvent?: (event: HarnessEvent) => void,
) {
  const events: HarnessEvent[] = [];
  const accepted = vi.fn();
  const turn = sendCursorTurn({
    sessionId,
    cwd: "/repo",
    model: "cursor:composer-2.5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "explore the codebase",
    attachments: [],
    intent,
    onAccepted: accepted,
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
  });

  await waitFor(() => !!outboundRequest("initialize"), "initialize");
  reply(outboundRequest("initialize")!.id as number, {});

  await waitFor(() => !!outboundRequest("authenticate"), "authenticate");
  reply(outboundRequest("authenticate")!.id as number, {});

  await waitFor(() => !!outboundRequest("session/new"), "session/new");
  reply(outboundRequest("session/new")!.id as number, {
    sessionId: "cursor_1",
    modes: {
      currentModeId: "agent",
      availableModes: [{ id: "agent" }, { id: "plan" }],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "composer-2.5",
      },
    ],
  });

  await waitFor(
    () =>
      !!outboundRequest("session/prompt") ||
      !!outboundRequest("session/set_mode"),
    "mode or prompt",
  );
  if (outboundRequest("session/set_mode")) {
    reply(outboundRequest("session/set_mode")!.id as number, {});
  }
  await waitFor(() => !!outboundRequest("session/prompt"), "session/prompt");
  const promptId = outboundRequest("session/prompt")!.id as number;
  return { events, promptId, turn, accepted };
}

const transportErrorText =
  "\n\nError: RetriableError: [unavailable] read ETIMEDOUT";

function emitText(text: string) {
  notify("session/update", {
    sessionId: "cursor_1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

function emitTool(status: string | undefined, child = false) {
  notify("session/update", {
    sessionId: "cursor_1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "command",
      kind: "execute",
      status,
      ...(child ? { _meta: { parentToolCallId: "call_agent" } } : {}),
    },
  });
}

function prompts() {
  return parse().filter((message) => message.method === "session/prompt");
}

function emitAgentStart() {
  notify("session/update", {
    sessionId: "cursor_1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call_agent",
      title: "Task: Explore auth",
      kind: "other",
      status: "pending",
      rawInput: {
        _toolName: "task",
        description: "Explore auth",
        subagentType: "explore",
      },
    },
  });
}

function agentEvents(events: HarnessEvent[]) {
  return events.filter(
    (event) => event.type === "tool.updated" && event.callId === "call_agent",
  );
}

beforeEach(() => {
  processControl.spawn.mockReset().mockResolvedValue(undefined);
  processControl.kill.mockReset().mockResolvedValue(undefined);
  stores.tools.mockReset().mockResolvedValue([]);
  stores.subagents.mockReset().mockResolvedValue([]);
  sent.length = 0;
  onLine = undefined;
  __cursorTestReset();
});

afterEach(async () => {
  await stopCursorSession("cursor-live");
  __cursorTestReset();
});

describe("cursor session controls", () => {
  it("rechecks unfinished work after awaiting the final child refresh", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    let finishRefresh!: (value: unknown[]) => void;
    stores.subagents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    emitAgentStart();
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
      },
    });
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(() => !!finishRefresh, "final child refresh");
    emitTool("in_progress");
    finishRefresh([]);
    expect(await outcome).toBeInstanceOf(Error);
    expect(prompts()).toHaveLength(1);
  });
  it("refreshes completed child results before beginning the continuation", async () => {
    const first = await startTurn("cursor-live");
    stores.subagents.mockResolvedValue([
      {
        agentId: "child_1",
        toolCallId: "call_agent",
        revision: "final",
        prompt: "review",
        steps: [
          { id: "final-step", kind: "message", text: "Final child finding." },
        ],
      },
    ]);
    emitAgentStart();
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
      },
    });
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(() => prompts().length === 2, "continuation");
    expect(
      first.events.some(
        (event) =>
          event.type === "agent.step" && event.text === "Final child finding.",
      ),
    ).toBe(true);
    emitText("Checked and finished.");
    reply(prompts()[1].id as number, { stopReason: "end_turn" });
    await first.turn;
  });
  it("keeps the diagnostic terminal across late usage updates", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    emitText(transportErrorText);
    notify("session/update", {
      sessionId: "cursor_1",
      update: { sessionUpdate: "usage_update", used: 4, size: 100 },
    });
    reply(first.promptId, { stopReason: "end_turn" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(
      first.events.some((event) => event.type === "message.completed"),
    ).toBe(false);
  });

  it.each(["end_turn", "max_tokens", "refusal", "cancelled"])(
    "does not accept a blank or incomplete continuation (%s)",
    async (stopReason) => {
      const first = await startTurn("cursor-live");
      const outcome = first.turn.catch((error) => error);
      emitTool("completed");
      emitText(transportErrorText);
      reply(first.promptId, { stopReason: "end_turn" });
      await waitFor(() => prompts().length === 2, "continuation");
      if (stopReason !== "end_turn") emitText("Partial response");
      reply(prompts()[1].id as number, { stopReason });
      expect(await outcome).toBeInstanceOf(Error);
      expect(
        first.events.some((event) => event.type === "message.completed"),
      ).toBe(false);
    },
  );

  it("rejects already queued requests after an uncertain tool outcome", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    const next = sendCursorTurn({
      sessionId: "cursor-live",
      cwd: "/repo",
      model: "cursor:composer-2.5",
      runtimeMode: "supervised",
      text: "queued work",
      attachments: [],
      onEvent: () => undefined,
    }).catch((error) => error);
    emitTool("in_progress");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(await next).toMatchObject({
      message: expect.stringContaining("queued"),
    });
    expect(prompts()).toHaveLength(1);
    const manual = sendCursorTurn({
      sessionId: "cursor-live",
      cwd: "/repo",
      model: "cursor:composer-2.5",
      runtimeMode: "supervised",
      text: "I checked the command; continue",
      attachments: [],
      onEvent: () => undefined,
    });
    await waitFor(() => prompts().length === 2, "new user turn");
    reply(prompts()[1].id as number, { stopReason: "end_turn" });
    await manual;
  });

  it("continues once in the same process after Cursor reports its terminal timeout as successful assistant text", async () => {
    const first = await startTurn("cursor-live", "plan");
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edited",
        kind: "edit",
        status: "completed",
      },
    });
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "\n\nError: RetriableError: [unavailable] read ETIMEDOUT",
        },
      },
    });
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(
      () =>
        parse().filter((message) => message.method === "session/prompt")
          .length === 2,
      "same-session continuation",
    );
    const continuation = parse().filter(
      (message) => message.method === "session/prompt",
    )[1];
    expect(continuation.params).toMatchObject({ sessionId: "cursor_1" });
    expect(JSON.stringify(continuation.params)).toMatch(/inspect|check/i);
    expect(JSON.stringify(continuation.params)).not.toContain(
      "explore the codebase",
    );
    expect(processControl.spawn).toHaveBeenCalledTimes(1);
    expect(processControl.kill).not.toHaveBeenCalled();
    expect(
      first.events.some(
        (event) =>
          event.type === "message.completed" || event.type === "session.error",
      ),
    ).toBe(false);
    expect(
      first.events.some(
        (event) =>
          event.type === "message.delta" &&
          event.text.includes("RetriableError"),
      ),
    ).toBe(false);
    emitText("Checked completed work and finished the remaining task.");
    reply(continuation.id as number, { stopReason: "end_turn" });
    await first.turn;
    expect(
      first.events.filter((event) => event.type === "message.completed"),
    ).toHaveLength(1);
    expect(
      parse().filter((message) => message.method === "session/set_mode"),
    ).toHaveLength(1);
    expect(first.accepted).toHaveBeenCalledTimes(1);
  });

  it.each([
    "\n\nError: RetriableError: [unavailable] PING timed out",
    "\n\nError: RetriableError: Connection stalled",
    "\n\nError: RetriableError: Connection stalled repeatedly",
  ])("recognizes the exact earlier transport diagnostic: %s", async (text) => {
    const first = await startTurn("cursor-live");
    emitTool("completed");
    emitText(text);
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(() => prompts().length === 2, "continuation");
    emitText("Checked completed work and finished the remaining task.");
    reply(prompts()[1].id as number, { stopReason: "end_turn" });
    await first.turn;
  });

  it.each(["approval", "question", "background"])(
    "blocks continuation with unresolved %s",
    async (kind) => {
      const first = await startTurn("cursor-live");
      const outcome = first.turn.catch((error) => error);
      emitTool("completed");
      if (kind === "approval") {
        request(91, "session/request_permission", {
          sessionId: "cursor_1",
          toolCall: {
            toolCallId: "permission",
            kind: "execute",
            title: "command",
          },
          options: [{ optionId: "allow", kind: "allow_once" }],
        });
      } else if (kind === "question") {
        request(91, "cursor/ask_question", {
          questions: [{ id: "choice", question: "Which?", options: [] }],
        });
      } else {
        emitAgentStart();
        notify("session/update", {
          sessionId: "cursor_1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_agent",
            status: "completed",
            rawOutput: { isBackground: true },
          },
        });
      }
      emitText(transportErrorText);
      reply(first.promptId, { stopReason: "end_turn" });
      expect(await outcome).toBeInstanceOf(Error);
      expect(prompts()).toHaveLength(1);
      if (kind === "background") {
        expect(agentEvents(first.events).at(-1)).toMatchObject({
          status: "in_progress",
        });
      }
    },
  );

  it("honors cancellation before submitting the continuation", async () => {
    const first = await startTurn("cursor-live", undefined, (event) => {
      if (event.type === "status" && event.key === "cursor-recovery")
        void cancelCursorTurn("cursor-live");
    });
    emitTool("completed");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    await first.turn;
    expect(prompts()).toHaveLength(1);
    expect(
      first.events.some(
        (event) =>
          event.type === "session.error" || event.type === "message.completed",
      ),
    ).toBe(false);
  });

  it("honors cancellation while the continuation is running", async () => {
    const first = await startTurn("cursor-live");
    emitTool("completed");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(() => prompts().length === 2, "continuation");
    await cancelCursorTurn("cursor-live");
    await first.turn;
    expect(prompts()).toHaveLength(2);
    expect(
      first.events.some(
        (event) =>
          event.type === "session.error" || event.type === "message.completed",
      ),
    ).toBe(false);
  });

  it("does not mark a cancelled terminal response complete", async () => {
    const first = await startTurn("cursor-live");
    emitTool("completed");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "cancelled" });
    await first.turn;
    expect(prompts()).toHaveLength(1);
    expect(
      first.events.some(
        (event) =>
          event.type === "session.error" || event.type === "message.completed",
      ),
    ).toBe(false);
  });
  it.each(["in_progress", "pending", undefined])(
    "requires manual continuation for an unfinished command (%s)",
    async (status) => {
      const first = await startTurn("cursor-live");
      const outcome = first.turn.catch((error) => error);
      emitTool(status);
      emitText(transportErrorText);
      reply(first.promptId, { stopReason: "end_turn" });
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("Check unfinished tool results"),
      });
      expect(prompts()).toHaveLength(1);
      expect(
        first.events.some((event) => event.type === "message.completed"),
      ).toBe(false);
      expect(first.events.some((event) => event.type === "session.error")).toBe(
        true,
      );
    },
  );

  it("blocks continuation for an unresolved child command", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    emitAgentStart();
    emitTool("in_progress", true);
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
      },
    });
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(prompts()).toHaveLength(1);
  });

  it("blocks continuation without observable progress", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(prompts()).toHaveLength(1);
  });

  it("stops after a second terminal timeout", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    emitTool("completed");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(() => prompts().length === 2, "continuation");
    emitText(transportErrorText);
    reply(prompts()[1].id as number, { stopReason: "end_turn" });
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("ETIMEDOUT"),
    });
    expect(prompts()).toHaveLength(2);
    expect(
      first.events.filter((event) => event.type === "session.error"),
    ).toHaveLength(1);
    expect(
      first.events.some((event) => event.type === "message.completed"),
    ).toBe(false);
  });

  it.each([
    `The error was ${transportErrorText} but the task succeeded.`,
    "Error: RetriableError: [unavailable] read ETIMEDOUT",
    "\n\nerror: retriableerror: [unavailable] read ETIMEDOUT",
    "\n\nError: NonRetriableError: [unavailable] read ETIMEDOUT",
    "\n\nError: RetriableError: [unauthenticated] read ETIMEDOUT",
    "\n\nError: RetriableError: [resource_exhausted] quota exceeded",
    "\n\nError: RetriableError: [unavailable] billing required",
  ])("preserves ordinary text: %s", async (text) => {
    const first = await startTurn("cursor-live");
    emitText(text);
    reply(first.promptId, { stopReason: "end_turn" });
    await first.turn;
    expect(prompts()).toHaveLength(1);
    expect(first.events).toContainEqual({ type: "message.delta", text });
    expect(first.events.some((event) => event.type === "session.error")).toBe(
      false,
    );
  });

  it("flushes an error-looking chunk if a later update arrives", async () => {
    const first = await startTurn("cursor-live");
    emitText(transportErrorText);
    expect(first.events).not.toContainEqual({
      type: "message.delta",
      text: transportErrorText,
    });
    emitText("The retry succeeded.");
    reply(first.promptId, { stopReason: "end_turn" });
    await first.turn;
    expect(prompts()).toHaveLength(1);
    expect(
      first.events.filter((event) => event.type === "message.delta"),
    ).toEqual([
      { type: "message.delta", text: transportErrorText },
      { type: "message.delta", text: "The retry succeeded." },
    ]);
  });

  it("requires end_turn before interpreting a diagnostic chunk as failure", async () => {
    const first = await startTurn("cursor-live");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "max_tokens" });
    await first.turn;
    expect(prompts()).toHaveLength(1);
    expect(first.events).toContainEqual({
      type: "message.delta",
      text: transportErrorText,
    });
  });

  it("does not restart or replay a rejected prompt RPC", async () => {
    const first = await startTurn("cursor-live");
    const outcome = first.turn.catch((error) => error);
    onLine!(
      JSON.stringify({
        id: first.promptId,
        error: { code: -32603, message: "read ETIMEDOUT" },
      }),
    );
    expect(await outcome).toMatchObject({ message: "read ETIMEDOUT" });
    expect(prompts()).toHaveLength(1);
    expect(processControl.spawn).toHaveBeenCalledTimes(1);
    expect(processControl.kill).not.toHaveBeenCalled();
  });

  it("keeps queued turns behind the same-session continuation", async () => {
    const first = await startTurn("cursor-live");
    const next = sendCursorTurn({
      sessionId: "cursor-live",
      cwd: "/repo",
      model: "cursor:composer-2.5",
      runtimeMode: "supervised",
      text: "next request",
      attachments: [],
      onEvent: () => undefined,
    });
    emitTool("completed");
    emitText(transportErrorText);
    reply(first.promptId, { stopReason: "end_turn" });
    await waitFor(() => prompts().length === 2, "continuation");
    expect(JSON.stringify(prompts()[1].params)).not.toContain("next request");
    emitText("Checked completed work and finished the remaining task.");
    reply(prompts()[1].id as number, { stopReason: "end_turn" });
    await first.turn;
    await waitFor(() => prompts().length === 3, "queued turn");
    expect(JSON.stringify(prompts()[2].params)).toContain("next request");
    reply(prompts()[2].id as number, {});
    await next;
  });

  it("keeps a queued Plan turn from changing the running turn mode", async () => {
    const first = await startTurn("cursor-live");
    reply(first.promptId, {});
    await first.turn;
    sent.length = 0;
    const send = (model: string, intent?: "plan") =>
      sendCursorTurn({
        sessionId: "cursor-live",
        cwd: "/repo",
        model,
        intent,
        runtimeMode: "supervised",
        text: "hello",
        attachments: [],
        onEvent: () => undefined,
      });
    const agent = send("cursor:gpt-5.4");
    await waitFor(
      () => !!outboundRequest("session/set_config_option"),
      "model selection",
    );
    const plan = send("cursor:gpt-5.4", "plan");
    await Promise.resolve();
    reply(outboundRequest("session/set_config_option")!.id as number, {});
    await waitFor(
      () =>
        !!outboundRequest("session/prompt") ||
        !!outboundRequest("session/set_mode"),
      "mode or prompt",
    );
    const prematureMode = outboundRequest("session/set_mode");
    if (prematureMode) reply(prematureMode.id as number, {});
    await waitFor(() => !!outboundRequest("session/prompt"), "agent prompt");
    reply(outboundRequest("session/prompt")!.id as number, {});
    await agent;
    sent.length = 0;
    await waitFor(
      () =>
        !!outboundRequest("session/set_mode") ||
        !!outboundRequest("session/prompt"),
      "plan mode",
    );
    if (outboundRequest("session/set_mode"))
      reply(outboundRequest("session/set_mode")!.id as number, {});
    await waitFor(() => !!outboundRequest("session/prompt"), "plan prompt");
    reply(outboundRequest("session/prompt")!.id as number, {});
    await plan;
    expect(prematureMode).toBeUndefined();
  });

  it("rejects unsupported explicit settings before prompting", async () => {
    const first = await startTurn("cursor-live");
    reply(first.promptId, {});
    await first.turn;
    sent.length = 0;
    const next = sendCursorTurn({
      sessionId: "cursor-live",
      cwd: "/repo",
      model: "cursor:composer-2.5",
      modelSettings: { effort: "high" },
      runtimeMode: "supervised",
      text: "hello",
      attachments: [],
      onEvent: () => undefined,
    });
    await expect(next).rejects.toThrow("Unsupported Cursor setting: effort");
    expect(outboundRequest("session/prompt")).toBeUndefined();
  });

  it.each([false, true])(
    "applies the original model again after a successful model change (legacy=%s)",
    async (legacy) => {
      const first = await startTurn("cursor-live");
      reply(first.promptId, {});
      await first.turn;
      const send = (model: string) =>
        sendCursorTurn({
          sessionId: "cursor-live",
          cwd: "/repo",
          model,
          runtimeMode: "supervised",
          text: "hello",
          attachments: [],
          onEvent: () => undefined,
        });
      for (const model of ["gpt-5.4", "composer-2.5"]) {
        sent.length = 0;
        const turn = send(`cursor:${model}`);
        await waitFor(
          () =>
            !!outboundRequest("session/set_config_option") ||
            !!outboundRequest("session/prompt"),
          "model or prompt",
        );
        const selection = outboundRequest("session/set_config_option");
        if (selection && legacy) {
          onLine!(
            JSON.stringify({
              id: selection.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
          await waitFor(
            () => !!outboundRequest("session/set_model"),
            "legacy selection",
          );
          reply(outboundRequest("session/set_model")!.id as number, {});
        } else if (selection) {
          reply(selection.id as number, {});
        }
        await waitFor(() => !!outboundRequest("session/prompt"), "prompt");
        reply(outboundRequest("session/prompt")!.id as number, {});
        await turn;
        expect(selection?.params).toMatchObject({
          configId: "model",
          value: model,
        });
      }
    },
  );

  it("reports rejected model selection instead of prompting with a different model", async () => {
    const first = await startTurn("cursor-live");
    reply(first.promptId, {});
    await first.turn;
    sent.length = 0;
    const next = sendCursorTurn({
      sessionId: "cursor-live",
      cwd: "/repo",
      model: "cursor:unavailable",
      runtimeMode: "supervised",
      text: "hello",
      attachments: [],
      onEvent: () => undefined,
    });
    const rejected = expect(next).rejects.toThrow("Invalid model");
    await waitFor(
      () => !!outboundRequest("session/set_config_option"),
      "model selection",
    );
    onLine!(
      JSON.stringify({
        id: outboundRequest("session/set_config_option")!.id,
        error: { code: -32602, message: "Invalid model" },
      }),
    );
    await waitFor(
      () => !!outboundRequest("session/set_model"),
      "legacy model selection",
    );
    onLine!(
      JSON.stringify({
        id: outboundRequest("session/set_model")!.id,
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await rejected;
    expect(outboundRequest("session/prompt")).toBeUndefined();
  });

  it("selects native Plan mode before prompting and restores Agent on the next turn", async () => {
    const { turn, promptId } = await startTurn("cursor-live", "plan");
    expect(outboundRequest("session/set_mode")?.params).toEqual({
      sessionId: "cursor_1",
      modeId: "plan",
    });
    reply(promptId, {});
    await turn;
    sent.length = 0;
    const next = sendCursorTurn({
      sessionId: "cursor-live",
      cwd: "/repo",
      model: "cursor:composer-2.5",
      runtimeMode: "supervised",
      text: "implement",
      attachments: [],
      onEvent: () => undefined,
    });
    await waitFor(() => !!outboundRequest("session/set_mode"), "agent mode");
    expect(outboundRequest("session/set_mode")?.params).toEqual({
      sessionId: "cursor_1",
      modeId: "agent",
    });
    reply(outboundRequest("session/set_mode")!.id as number, {});
    await waitFor(() => !!outboundRequest("session/prompt"), "next prompt");
    reply(outboundRequest("session/prompt")!.id as number, {});
    await next;
  });

  it("answers permissions using advertised opaque option IDs", async () => {
    const { turn, promptId, events } = await startTurn("cursor-live");
    request(901, "session/request_permission", {
      toolCall: { kind: "execute" },
      options: [
        { optionId: "yes-123", kind: "allow_once" },
        { optionId: "no-456", kind: "reject_once" },
      ],
    });
    await waitFor(
      () => events.some((event) => event.type === "approval.requested"),
      "approval",
    );
    respondCursorApproval("cursor-live", 901, "allow");
    await waitFor(
      () => parse().some((message) => message.id === 901),
      "permission response",
    );
    expect(parse().find((message) => message.id === 901)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "yes-123" },
    });
    reply(promptId, {});
    await turn;
  });

  it("cancels permission requests that provide no usable option", async () => {
    const { turn, promptId } = await startTurn("cursor-live", "plan");
    request(902, "session/request_permission", {
      toolCall: { kind: "execute" },
      options: [],
    });
    await waitFor(
      () => parse().some((message) => message.id === 902),
      "permission response",
    );
    expect(parse().find((message) => message.id === 902)?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    reply(promptId, {});
    await turn;
  });
});

describe("cursor background subagents", () => {
  it("recovers native child steps without parent-attributed ACP events and enriches foreground names", async () => {
    const run = {
      agentId: "child_1",
      toolCallId: "call_agent",
      revision: "12",
      prompt:
        "Perform a read-only, defect-first code review of ACP routing in /repo.",
      steps: [
        { id: "child_1:blob:0", kind: "message", text: "Checking routing." },
        {
          id: "child_1:tool:read",
          kind: "tool",
          text: "",
          toolName: "Read",
          args: { path: "/repo/acp.ts" },
          status: "completed",
          output: "export const route = true;",
        },
      ],
    };
    stores.subagents.mockResolvedValue([run]);
    const { events, promptId, turn } = await startTurn("cursor-live");
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_agent",
        title: "Task: Subagent task",
        kind: "other",
        status: "pending",
        rawInput: { _toolName: "task" },
      },
    });
    expect(agentEvents(events).at(-1)).toMatchObject({ title: "Subagent" });
    await waitFor(
      () => events.some((event) => event.type === "agent.step"),
      "stored child steps",
    );
    expect(stores.subagents).toHaveBeenCalledWith(
      "cursor_1",
      ["call_agent"],
      expect.any(Object),
    );
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
      },
    });
    request(101, "cursor/task", {
      toolCallId: "call_agent",
      agentId: "child_1",
      description: "Review ACP routing",
      durationMs: 25,
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;
    const session = events.reduce(
      applyHarnessEvent,
      newSession("cursor", "/repo"),
    );
    const row = session.blocks.find(
      (block) => block.tool?.callId === "call_agent",
    )!;
    expect(row.text).toBe("Review ACP routing");
    expect(row.tool?.status).toBe("completed");
    expect(row.agentRun?.name).toBe("Review ACP routing");
    expect(row.agentRun?.steps).toHaveLength(2);
    expect(row.agentRun?.steps[1]).toMatchObject({
      toolKind: "read",
      status: "completed",
      preview: { path: "/repo/acp.ts" },
    });
    expect(
      session.blocks.filter((block) => block.role === "assistant"),
    ).toEqual([]);
    expect(stores.subagents.mock.calls.at(-1)?.[2]).toEqual({ child_1: "12" });
  });

  it("keeps a task description received before its placeholder tool row", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    notify("cursor/task", {
      toolCallId: "call_agent",
      description: "Review UI events",
      agentId: "child_1",
    });
    notify("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_agent",
        title: "Task: Subagent task",
        rawInput: { _toolName: "task" },
        status: "in_progress",
      },
    });
    expect(agentEvents(events).at(-1)).toMatchObject({
      title: "Review UI events",
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it.each(["cancel", "stop", "exit"])(
    "ignores an in-flight child read after %s",
    async (action) => {
      let resolve!: (runs: unknown[]) => void;
      stores.subagents.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { events, promptId, turn } = await startTurn("cursor-live");
      emitAgentStart();
      await waitFor(() => !!resolve, "child read");
      if (action === "cancel") await cancelCursorTurn("cursor-live");
      else if (action === "stop") await stopCursorSession("cursor-live");
      else onExit!(1);
      const count = events.length;
      resolve([
        {
          agentId: "child_1",
          toolCallId: "call_agent",
          revision: "1",
          steps: [{ id: "late", kind: "message", text: "Late result" }],
        },
      ]);
      // A stopped ACP client rejects its prompt; cancellation still receives a reply.
      if (action === "cancel") reply(promptId, { stopReason: "cancelled" });
      await turn.catch(() => undefined);
      await new Promise((done) => setTimeout(done, 5));
      expect(
        events
          .slice(count)
          .some(
            (event) =>
              event.type === "agent.step" || event.type === "message.completed",
          ),
      ).toBe(false);
    },
  );

  it("routes attributed child work to its row and leaves parent narration separate", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    emitAgentStart();
    const meta = { parentToolCallId: "call_agent" };
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        _meta: meta,
        content: { type: "text", text: "Child narration" },
      },
    });
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call",
        _meta: meta,
        toolCallId: "child_read",
        title: "Read auth.ts",
        kind: "read",
        status: "in_progress",
      },
    });
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "child_read",
        status: "completed",
      },
    });
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Parent narration" },
      },
    });
    expect(events.filter((event) => event.type === "message.delta")).toEqual([
      { type: "message.delta", text: "Parent narration" },
    ]);
    expect(events.filter((event) => event.type === "agent.step")).toEqual([
      expect.objectContaining({
        callId: "call_agent",
        kind: "message",
        text: "Child narration",
      }),
      expect.objectContaining({
        callId: "call_agent",
        stepId: "tool:child_read",
        status: "in_progress",
      }),
      expect.objectContaining({
        callId: "call_agent",
        stepId: "tool:child_read",
        status: "completed",
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "tool.updated" && event.callId === "child_read",
      ),
    ).toBe(false);
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("keeps a failed child tool's error text on its step", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    emitAgentStart();
    const meta = { parentToolCallId: "call_agent" };
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call",
        _meta: meta,
        toolCallId: "child_bash",
        title: "npm test",
        kind: "execute",
        status: "in_progress",
      },
    });
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "child_bash",
        status: "failed",
        content: [{ type: "text", text: "Tests failed: assertion error" }],
      },
    });
    expect(
      events.filter((event) => event.type === "agent.step").at(-1),
    ).toMatchObject({
      callId: "call_agent",
      stepId: "tool:child_bash",
      status: "failed",
      detail: "Tests failed: assertion error",
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("does not pass a child tool's command off as its error output", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    emitAgentStart();
    const meta = { parentToolCallId: "call_agent" };
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call",
        _meta: meta,
        toolCallId: "child_bash",
        title: "npm test",
        kind: "execute",
        rawInput: { command: "npm test" },
        status: "in_progress",
      },
    });
    // Failed with nothing to say, but the update still carries the call: the
    // command is the title, not the reason it failed.
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "child_bash",
        status: "failed",
        rawInput: { command: "npm test" },
      },
    });
    const step = events.filter((event) => event.type === "agent.step").at(-1);
    expect(step).toMatchObject({
      callId: "call_agent",
      stepId: "tool:child_bash",
      status: "failed",
    });
    expect(step).not.toHaveProperty("detail");
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("emits request-shaped Cursor todo updates as structured task lists", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    request(71, "cursor/update_todos", {
      toolCallId: "call_todos",
      todos: [
        { content: "Inspect", status: "completed" },
        { content: "Implement", status: "in_progress" },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: "tasks.updated",
      items: [
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "in_progress" },
      ],
    });
    await waitFor(
      () => parse().some((message) => message.id === 71 && "result" in message),
      "cursor/update_todos response",
    );
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("keeps notification-shaped Cursor todo updates compatible", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    notify("_cursor/update_todos", {
      todos: [{ content: "Inspect", status: "pending" }],
    });
    expect(events.at(-1)).toEqual({
      type: "tasks.updated",
      items: [{ text: "Inspect", status: "pending" }],
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("preserves Cursor's partial-update signal and task identities", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    request(72, "cursor/update_todos", {
      toolCallId: "call_todos",
      merge: true,
      todos: [
        { id: "2", content: "Implementing the fix", status: "completed" },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: "tasks.updated",
      merge: true,
      items: [
        {
          id: "2",
          text: "Implementing the fix",
          status: "completed",
        },
      ],
    });
    await waitFor(
      () => parse().some((message) => message.id === 72 && "result" in message),
      "partial cursor/update_todos response",
    );
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("marks Cursor's redundant todo tool call as internal task activity", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_todos",
        title: "Update TODOs",
        kind: "other",
        status: "pending",
        rawInput: { _toolName: "updateTodos", todos: [] },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool.updated",
      callId: "call_todos",
      kind: "tasks",
    });
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_todos",
        kind: "other",
        status: "completed",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool.updated",
      callId: "call_todos",
      kind: "tasks",
      status: "completed",
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("reports background.updated while a background agent is waiting", async () => {
    const { events, promptId, turn } = await startTurn("cursor-bg-wait");
    emitAgentStart();
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
        rawOutput: { isBackground: true },
      },
    });
    expect(
      events.some((e) => e.type === "background.updated" && e.tasks.length > 0),
    ).toBe(true);
    reply(promptId, { stopReason: "end_turn" });
    await turn;
    expect(
      events.some(
        (e) => e.type === "background.updated" && e.tasks.length === 0,
      ),
    ).toBe(true);
  });

  it("keeps an ACP background task active until the prompt completes", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitAgentStart();
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
        rawOutput: { isBackground: true },
      },
    });

    expect(agentEvents(events).at(-1)).toMatchObject({
      type: "tool.updated",
      title: "Explore auth",
      kind: "agent",
      status: "in_progress",
    });
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    reply(promptId, { stopReason: "end_turn" });
    await turn;

    expect(agentEvents(events).at(-1)).toMatchObject({
      type: "tool.updated",
      kind: "agent",
      status: "completed",
    });
    expect(settled).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      true,
    );
  });

  it("uses Cursor's task request when raw ACP output omits the background flag", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    emitAgentStart();
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
      },
    });
    request(99, "cursor/task", {
      toolCallId: "call_agent",
      description: "Explore auth",
      subagentType: "explore",
      agentId: "child_1",
    });

    expect(agentEvents(events).at(-1)).toMatchObject({
      type: "tool.updated",
      title: "Explore auth",
      kind: "agent",
      status: "in_progress",
      detail: "explore subagent",
    });
    await waitFor(
      () => parse().some((message) => message.id === 99 && "result" in message),
      "cursor/task response",
    );

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    expect(agentEvents(events).at(-1)).toMatchObject({ status: "completed" });
  });

  it("does not reopen a foreground task after Cursor reports its duration", async () => {
    const { events, promptId, turn } = await startTurn("cursor-live");
    emitAgentStart();
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_agent",
        status: "completed",
        rawOutput: { isBackground: false, durationMs: 25 },
      },
    });
    request(100, "cursor/task", {
      toolCallId: "call_agent",
      description: "Explore auth",
      subagentType: "explore",
      agentId: "child_1",
      durationMs: 25,
    });

    expect(agentEvents(events).at(-1)).toMatchObject({
      type: "tool.updated",
      kind: "agent",
      status: "completed",
    });

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    expect(agentEvents(events).at(-1)).toMatchObject({ status: "completed" });
  });
});

describe("cursor context usage", () => {
  it("emits context from ACP usage_update", async () => {
    const { events, promptId, turn } = await startTurn("cursor-context");
    notify("session/update", {
      sessionId: "cursor_1",
      update: {
        sessionUpdate: "usage_update",
        used: 53_000,
        size: 200_000,
      },
    });
    expect(events.some((e) => e.type === "context")).toBe(true);
    expect(events.find((e) => e.type === "context")).toMatchObject({
      type: "context",
      used: 53_000,
      window: 200_000,
    });
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });

  it("ignores usage_update without numeric used/size", async () => {
    const { events, promptId, turn } = await startTurn("cursor-context-empty");
    notify("session/update", {
      sessionId: "cursor_1",
      update: { sessionUpdate: "usage_update" },
    });
    expect(events.some((e) => e.type === "context")).toBe(false);
    reply(promptId, { stopReason: "end_turn" });
    await turn;
  });
});

describe("cursor context compaction", () => {
  it("compacts by prompting /compact on the live ACP session", async () => {
    const {
      events: _events,
      promptId,
      turn,
    } = await startTurn("cursor-compact");
    reply(promptId, { stopReason: "end_turn" });
    await turn;

    const compact = compactCursorContext({
      sessionId: "cursor-compact",
      cwd: "/repo",
      model: "cursor:composer-2.5",
      modelSettings: {},
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });

    await waitFor(
      () =>
        parse().some(
          (message) =>
            message.method === "session/prompt" &&
            JSON.stringify(message.params).includes("/compact"),
        ),
      "compact prompt",
    );
    const compactId = parse().find(
      (message) =>
        message.method === "session/prompt" &&
        JSON.stringify(message.params).includes("/compact"),
    )!.id as number;
    reply(compactId, { stopReason: "end_turn" });
    await compact;
  });
});
