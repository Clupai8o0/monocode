import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number | null) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveGrokBinary: async () => ({ path: "/fake/grok" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (c: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  bindGrokSession,
  compactGrokContext,
  forgetGrokSession,
  sendGrokTurn,
  respondGrokApproval,
  steerGrokTurn,
  stopGrokSession,
} = await import("./grok");
import { TurnNotReadyError, type HarnessEvent } from "../../core/types";

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
const parse = () => sent.map((s) => JSON.parse(s));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse().map((m) => m.method ?? `reply:${m.id}`))}`,
  );
};

const initResult = {
  protocolVersion: 1,
  authMethods: [{ id: "cached_token" }],
  _meta: {
    defaultAuthMethodId: "cached_token",
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: { totalContextTokens: 500000 },
        },
      ],
    },
  },
};

async function handshake() {
  await waitFor(
    () => parse().some((m) => m.method === "initialize"),
    "initialize",
  );
  reply(parse().find((m) => m.method === "initialize")!.id, initResult);
  await waitFor(
    () => parse().some((m) => m.method === "authenticate"),
    "authenticate",
  );
  reply(parse().find((m) => m.method === "authenticate")!.id, {});
  await waitFor(
    () => parse().some((m) => m.method === "session/new"),
    "session/new",
  );
  reply(parse().find((m) => m.method === "session/new")!.id, {
    sessionId: "S1",
    models: { currentModelId: "grok-4.6" },
  });
}

describe("grok live turn sequence", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("authenticates, selects the model, and prompts", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendGrokTurn({
      sessionId: "t1",
      cwd: "/repo",
      model: "grok:grok-4.6",
      modelSettings: { effort: "high" },
      runtimeMode: "supervised",
      text: "hey",
      attachments: [
        {
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          kind: "image",
          size: 3,
          data: "YWJj",
        },
      ],
      onEvent: (e) => events.push(e),
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/set_config_option"),
      "set_config_option",
    );
    const effort = parse().find(
      (m) => m.method === "session/set_config_option",
    )!;
    // Grok's session modes are permission modes; effort is a config option.
    expect(effort.params).toEqual({
      sessionId: "S1",
      configId: "reasoning_effort",
      value: "high",
    });
    expect(parse().some((m) => m.method === "session/set_mode")).toBe(false);
    reply(effort.id, {});
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const promptRequest = parse().find((m) => m.method === "session/prompt")!;
    expect(promptRequest.params.prompt).toEqual([
      { type: "text", text: "hey" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
    ]);
    reply(promptRequest.id, {
      stopReason: "end_turn",
    });
    await turn;
    expect(events.some((e) => e.type === "session.providerBound")).toBe(true);
    expect(parse().some((m) => m.method === "authenticate")).toBe(true);
    await stopGrokSession("t1");
  });

  it("surfaces a supervised permission request instead of auto-approving", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendGrokTurn({
      sessionId: "t2",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised",
      text: "run git",
      attachments: [],
      onEvent: (e) => events.push(e),
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const promptId = parse().find((m) => m.method === "session/prompt")!.id;
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_a",
            title: "Execute `git status`",
            kind: "execute",
            rawInput: { variant: "Bash", command: "git status" },
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      }),
    );
    await waitFor(
      () => events.some((e) => e.type === "approval.requested"),
      "approval.requested",
    );
    respondGrokApproval("t2", 1, "allow");
    await waitFor(
      () => parse().some((m) => m.id === 1 && m.result),
      "permission response",
    );
    const response = parse().find((m) => m.id === 1 && m.result);
    expect(response.result.outcome.optionId).toBe("allow-once");
    reply(promptId, { stopReason: "end_turn" });
    await turn;
    await stopGrokSession("t2");
  });

  it("routes a late exit to the current turn's listener", async () => {
    const turn1Events: HarnessEvent[] = [];
    const turn2Events: HarnessEvent[] = [];
    const base = {
      sessionId: "t3",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
      attachments: [],
    };

    const turn1 = sendGrokTurn({
      ...base,
      text: "hey",
      onEvent: (e) => turn1Events.push(e),
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt t1",
    );
    reply(parse().find((m) => m.method === "session/prompt")!.id, {
      stopReason: "end_turn",
    });
    await turn1;

    sent.length = 0;
    const turn2 = sendGrokTurn({
      ...base,
      text: "again",
      onEvent: (e) => turn2Events.push(e),
    });
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt t2",
    );
    onExit!(1);
    await turn2.catch(() => undefined);

    expect(turn2Events.some((e) => e.type === "session.ended")).toBe(true);
    expect(turn1Events.some((e) => e.type === "session.ended")).toBe(false);
    await stopGrokSession("t3");
  });

  it("compacts with Grok's ACP extension instead of a slash-command prompt", async () => {
    const turn = sendGrokTurn({
      sessionId: "t4",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised",
      text: "hey",
      attachments: [],
      onEvent: () => undefined,
    });
    await handshake();
    await waitFor(
      () => parse().some((message) => message.method === "session/prompt"),
      "session/prompt",
    );
    const prompt = parse().find(
      (message) => message.method === "session/prompt",
    )!;
    reply(prompt.id, { stopReason: "end_turn" });
    await turn;
    sent.length = 0;

    const compact = compactGrokContext({
      sessionId: "t4",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });
    await waitFor(
      () =>
        parse().some(
          (message) => message.method === "_x.ai/compact_conversation",
        ),
      "compact_conversation",
    );
    const request = parse().find(
      (message) => message.method === "_x.ai/compact_conversation",
    )!;
    expect(request.params).toEqual({ sessionId: "S1" });
    expect(parse().some((message) => message.method === "session/prompt")).toBe(
      false,
    );
    reply(request.id, {});
    await compact;
    await stopGrokSession("t4");
  });

  it("sends files Grok cannot inline as paths its tools can read", async () => {
    const turn = sendGrokTurn({
      sessionId: "t5",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised",
      text: "what is in it?",
      attachments: [
        {
          id: "pdf-1",
          name: "note.pdf",
          mimeType: "application/pdf",
          kind: "file",
          size: 600,
          path: "/tmp/note.pdf",
        },
      ],
      onEvent: () => undefined,
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const request = parse().find((m) => m.method === "session/prompt")!;
    // A binary resource_link is dropped by Grok without a word.
    expect(request.params.prompt).toEqual([
      { type: "text", text: "what is in it?" },
      { type: "text", text: 'Attached file (read from disk): "/tmp/note.pdf"' },
    ]);
    reply(request.id, { stopReason: "end_turn" });
    await turn;
    await stopGrokSession("t5");
  });

  it("resumes a saved session with the cwd Grok requires", async () => {
    bindGrokSession("t6", "OLD", "/repo");
    const turn = sendGrokTurn({
      sessionId: "t6",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised",
      text: "again",
      attachments: [],
      onEvent: () => undefined,
    });
    await waitFor(
      () => parse().some((m) => m.method === "initialize"),
      "initialize",
    );
    reply(parse().find((m) => m.method === "initialize")!.id, initResult);
    await waitFor(
      () => parse().some((m) => m.method === "authenticate"),
      "authenticate",
    );
    reply(parse().find((m) => m.method === "authenticate")!.id, {});
    await waitFor(
      () => parse().some((m) => m.method === "session/resume"),
      "session/resume",
    );
    const resume = parse().find((m) => m.method === "session/resume")!;
    expect(resume.params).toEqual({
      sessionId: "OLD",
      cwd: "/repo",
      mcpServers: [],
    });
    reply(resume.id, { models: { currentModelId: "grok-4.6" } });
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const request = parse().find((m) => m.method === "session/prompt")!;
    expect(request.params.sessionId).toBe("OLD");
    expect(parse().some((m) => m.method === "session/new")).toBe(false);
    reply(request.id, { stopReason: "end_turn" });
    await turn;
    await forgetGrokSession("t6");
  });

  it("steers a running turn with Grok's interjection", async () => {
    let accepted = false;
    const base = {
      sessionId: "t7",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
    };
    const turn = sendGrokTurn({
      ...base,
      text: "run the tests",
      attachments: [],
      onEvent: () => undefined,
      onAccepted: () => {
        accepted = true;
      },
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    expect(accepted).toBe(true);
    const promptId = parse().find((m) => m.method === "session/prompt")!.id;

    const steer = steerGrokTurn({
      ...base,
      text: "only the unit tests",
      attachments: [
        {
          id: "log-1",
          name: "out.log",
          mimeType: "text/plain",
          kind: "file",
          size: 10,
          path: "/tmp/out.log",
        },
      ],
    });
    await waitFor(
      () => parse().some((m) => m.method === "_x.ai/interject"),
      "interject",
    );
    const interject = parse().find((m) => m.method === "_x.ai/interject")!;
    expect(interject.params).toEqual({
      sessionId: "S1",
      text: 'only the unit tests\n\nAttached file (read from disk): "/tmp/out.log"',
    });
    reply(interject.id, { result: { status: "queued" } });
    await steer;

    // An image cannot ride an interjection; it waits for the next turn.
    await expect(
      steerGrokTurn({
        ...base,
        text: "look",
        attachments: [
          {
            id: "image-1",
            name: "shot.png",
            mimeType: "image/png",
            kind: "image",
            size: 3,
            data: "YWJj",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(TurnNotReadyError);

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    // Once the turn is over the follow-up becomes the next turn instead.
    await expect(
      steerGrokTurn({ ...base, text: "late", attachments: [] }),
    ).rejects.toBeInstanceOf(TurnNotReadyError);
    expect(parse().filter((m) => m.method === "_x.ai/interject")).toHaveLength(
      1,
    );
    await stopGrokSession("t7");
  });

  it("stays busy while Grok answers a late interjection in its own turn", async () => {
    const events: HarnessEvent[] = [];
    const base = {
      sessionId: "t8",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
    };
    let finished = false;
    const turn = sendGrokTurn({
      ...base,
      text: "say hi",
      attachments: [],
      onEvent: (e) => events.push(e),
    }).then(() => {
      finished = true;
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const promptId = parse().find((m) => m.method === "session/prompt")!.id;
    const steer = steerGrokTurn({ ...base, text: "and bye", attachments: [] });
    await waitFor(
      () => parse().some((m) => m.method === "_x.ai/interject"),
      "interject",
    );
    reply(parse().find((m) => m.method === "_x.ai/interject")!.id, {
      result: { status: "queued" },
    });
    await steer;

    // Our turn ends before Grok read the interjection, so Grok runs it.
    const queue = (params: Record<string, unknown>) =>
      onLine!(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "_x.ai/queue/changed",
          params: { sessionId: "S1", entries: [], ...params },
        }),
      );
    queue({ runningPromptId: "interject-fallback-1", runningText: "and bye" });
    reply(promptId, { stopReason: "end_turn" });
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "S1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "bye" },
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect(finished).toBe(false);
    expect(events).toContainEqual({ type: "message.delta", text: "bye" });

    queue({});
    await turn;
    expect(finished).toBe(true);
    await stopGrokSession("t8");
  });

  it("holds a follow-up sent while Grok starts, and waits for one in flight", async () => {
    const base = {
      sessionId: "t9",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
    };
    let finished = false;
    const turn = sendGrokTurn({
      ...base,
      text: "say hi",
      attachments: [],
      onEvent: () => undefined,
    }).then(() => {
      finished = true;
    });
    // Steered before Grok has even started: it waits instead of failing.
    const steer = steerGrokTurn({
      ...base,
      text: "read this",
      attachments: [
        {
          id: "pdf-1",
          name: "spec.pdf",
          mimeType: "application/pdf",
          kind: "file",
          size: 10,
          path: "/tmp/spec.pdf",
        },
      ],
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "_x.ai/interject"),
      "interject",
    );
    const methods = parse().map((m) => m.method);
    expect(methods.indexOf("session/prompt")).toBeLessThan(
      methods.indexOf("_x.ai/interject"),
    );
    const interject = parse().find((m) => m.method === "_x.ai/interject")!;
    expect(interject.params.text).toBe(
      'read this\n\nAttached file (read from disk): "/tmp/spec.pdf"',
    );

    // The turn ends while the interjection is still in flight: stay busy.
    const promptId = parse().find((m) => m.method === "session/prompt")!.id;
    reply(promptId, { stopReason: "end_turn" });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(finished).toBe(false);

    reply(interject.id, { result: { status: "queued" } });
    await steer;
    await turn;
    expect(finished).toBe(true);

    // A pasted image with no file can't ride along, with a plain reason.
    await expect(
      steerGrokTurn({
        ...base,
        text: "look",
        attachments: [
          {
            id: "image-1",
            name: "shot.png",
            mimeType: "image/png",
            kind: "image",
            size: 3,
            data: "YWJj",
          },
        ],
      }),
    ).rejects.toThrow(/pasted image/);
    await stopGrokSession("t9");
  });

  it("keeps the auto-compacted size over the prompt result's", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendGrokTurn({
      sessionId: "t10",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised",
      text: "go",
      attachments: [],
      onEvent: (e) => events.push(e),
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "S1",
          update: {
            sessionUpdate: "auto_compact_completed",
            tokens_before: 180000,
            tokens_after: 42000,
          },
        },
      }),
    );
    reply(parse().find((m) => m.method === "session/prompt")!.id, {
      stopReason: "end_turn",
      _meta: { totalTokens: 181000 },
    });
    await turn;
    const sizes = events.flatMap((e) => (e.type === "context" ? [e.used] : []));
    expect(sizes).toEqual([42000]);
    await stopGrokSession("t10");
  });

  it("ends the wait quietly when the session stops during a fallback turn", async () => {
    const events: HarnessEvent[] = [];
    const base = {
      sessionId: "t11",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
    };
    const turn = sendGrokTurn({
      ...base,
      text: "say hi",
      attachments: [],
      onEvent: (e) => events.push(e),
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const steer = steerGrokTurn({ ...base, text: "and bye", attachments: [] });
    await waitFor(
      () => parse().some((m) => m.method === "_x.ai/interject"),
      "interject",
    );
    reply(parse().find((m) => m.method === "_x.ai/interject")!.id, {
      result: { status: "queued" },
    });
    await steer;
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_x.ai/queue/changed",
        params: { sessionId: "S1", runningPromptId: "interject-fallback-1" },
      }),
    );
    reply(parse().find((m) => m.method === "session/prompt")!.id, {
      stopReason: "end_turn",
    });
    await new Promise((r) => setTimeout(r, 50));
    await stopGrokSession("t11");
    await turn;
    expect(events.map((e) => e.type)).not.toContain("message.completed");
  });

  it("drops a follow-up held for a starting turn once the user stops", async () => {
    const base = {
      sessionId: "t12",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
    };
    const turn = sendGrokTurn({
      ...base,
      text: "say hi",
      attachments: [],
      onEvent: () => undefined,
    }).catch(() => undefined);
    const steer = steerGrokTurn({ ...base, text: "and bye", attachments: [] });
    await new Promise((r) => setTimeout(r, 20));
    await stopGrokSession("t12");
    const started = Date.now();
    await expect(steer).rejects.toBeInstanceOf(TurnNotReadyError);
    expect(Date.now() - started).toBeLessThan(500);
    onExit?.(null);
    await turn;
  });

  it("fails the turn when Grok exits during a fallback turn", async () => {
    const events: HarnessEvent[] = [];
    const base = {
      sessionId: "t13",
      cwd: "/repo",
      model: "grok:grok-4.6",
      runtimeMode: "supervised" as const,
    };
    const turn = sendGrokTurn({
      ...base,
      text: "say hi",
      attachments: [],
      onEvent: (e) => events.push(e),
    });
    await handshake();
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt",
    );
    const steer = steerGrokTurn({ ...base, text: "and bye", attachments: [] });
    await waitFor(
      () => parse().some((m) => m.method === "_x.ai/interject"),
      "interject",
    );
    reply(parse().find((m) => m.method === "_x.ai/interject")!.id, {
      result: { status: "queued" },
    });
    await steer;
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_x.ai/queue/changed",
        params: { sessionId: "S1", runningPromptId: "interject-fallback-1" },
      }),
    );
    reply(parse().find((m) => m.method === "session/prompt")!.id, {
      stopReason: "end_turn",
    });
    await new Promise((r) => setTimeout(r, 50));
    onExit!(1);
    await expect(turn).rejects.toThrow(/exited/);
    expect(events.map((e) => e.type)).not.toContain("message.completed");
  });
});
