import { describe, expect, it } from "vitest";
import {
  askQuestionResponse,
  askQuestionsFromAcp,
  contextFromPromptResult,
  eventsFromAcpUpdate,
  fallbackGrokModels,
  grokAuthMethodId,
  grokEffort,
  grokPromptBlocks,
  grokSessionNewParams,
  grokSpawnArgs,
  grokTextSpawnArgs,
  modelsFromGrokModelsOutput,
  modelsFromInitialize,
  modelsFromSessionNew,
  permissionOptionId,
  permissionRequestFromAcp,
  pickAutoOption,
  planFromExitPlan,
  sessionIdFromResult,
} from "./grokProtocol";
import { harnessSupportsAttachments } from "../../../../features/sessions/model/session";

describe("grok protocol", () => {
  it("supports attachments despite Grok's stale advertised capability", () => {
    expect(harnessSupportsAttachments("grok")).toBe(true);
    expect(harnessSupportsAttachments("cursor")).toBe(true);
  });

  it("sends text and image prompt blocks", () => {
    expect(
      grokPromptBlocks("  describe this  ", [
        {
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          kind: "image",
          size: 3,
          data: "YWJj",
        },
      ]),
    ).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
    ]);
    expect(grokPromptBlocks("   ")).toEqual([]);
  });

  it("links text files for Grok to inline, and sends binaries as paths", () => {
    const file = (name: string, mimeType: string) => ({
      id: name,
      name,
      mimeType,
      kind: "file" as const,
      size: 10,
      path: `/tmp/${name}`,
    });
    const blocks = grokPromptBlocks("check", [
      file("app.ts", "text/plain; charset=utf-8"),
      file("data.json", "application/json"),
      file("spec.pdf", "application/pdf"),
    ]);
    expect(blocks.map((b) => b.type)).toEqual([
      "text",
      "resource_link",
      "resource_link",
      "text",
    ]);
    expect(blocks[3]).toEqual({
      type: "text",
      text: 'Attached file (read from disk): "/tmp/spec.pdf"',
    });
  });

  it("puts global flags before agent and stdio last", () => {
    expect(
      grokSpawnArgs({
        model: "grok:grok-4.6",
        effort: "high",
        fullAccess: true,
      }),
    ).toEqual([
      "--no-auto-update",
      "agent",
      "--no-leader",
      "--model",
      "grok-4.6",
      "--reasoning-effort",
      "high",
      "--always-approve",
      "stdio",
    ]);
    expect(grokTextSpawnArgs()[0]).toBe("--no-auto-update");
    expect(grokTextSpawnArgs().at(-1)).toBe("stdio");
    expect(grokTextSpawnArgs()).toContain("dontAsk");
    expect(grokSpawnArgs({ model: "grok:grok-4.6", plan: true })).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "plan",
      "agent",
      "--no-leader",
      "--model",
      "grok-4.6",
      "stdio",
    ]);
  });

  it("sets yoloMode only for full access", () => {
    expect(grokSessionNewParams("/repo", "supervised")).toEqual({
      cwd: "/repo",
      mcpServers: [],
    });
    expect(grokSessionNewParams("/repo", "full-access")).toEqual({
      cwd: "/repo",
      mcpServers: [],
      _meta: { yoloMode: true },
    });
    expect(grokSessionNewParams("/repo", "auto")).toEqual({
      cwd: "/repo",
      mcpServers: [],
      _meta: { autoMode: true },
    });
  });

  it("never authenticates with the browser grok.com method", () => {
    expect(
      grokAuthMethodId({
        authMethods: [
          { id: "grok.com" },
          { id: "cached_token" },
          { id: "xai.api_key" },
        ],
        _meta: { defaultAuthMethodId: "grok.com" },
      }),
    ).toBe("xai.api_key");
    expect(
      grokAuthMethodId({
        authMethods: [{ id: "cached_token" }, { id: "grok.com" }],
        _meta: { defaultAuthMethodId: "cached_token" },
      }),
    ).toBe("cached_token");
    expect(grokAuthMethodId({ authMethods: [{ id: "grok.com" }] })).toBeNull();
  });

  it("parks supervised permissions and auto-allows full access", () => {
    const options = ["allow-once", "reject-once"];
    expect(pickAutoOption("supervised", "execute", options)).toBeNull();
    expect(pickAutoOption("auto-accept-edits", "edit", options)).toBe(
      "allow-once",
    );
    expect(pickAutoOption("auto-accept-edits", "execute", options)).toBeNull();
    expect(pickAutoOption("full-access", "execute", options)).toBe(
      "allow-once",
    );
  });

  it("picks allow/reject option ids from ACP permission options", () => {
    expect(permissionOptionId("allow", ["allow_once", "reject_once"])).toBe(
      "allow_once",
    );
    expect(permissionOptionId("deny", ["allow-once", "reject-once"])).toBe(
      "reject-once",
    );
  });

  it("reads grok tool metadata from permission payloads", () => {
    const request = permissionRequestFromAcp({
      toolCall: {
        toolCallId: "call-1",
        kind: "execute",
        title: "Execute `git status`",
        rawInput: { variant: "Bash", command: "git status" },
      },
      options: [{ optionId: "allow-once" }, { optionId: "reject-once" }],
    });
    expect(request.callId).toBe("call-1");
    expect(request.title).toContain("git status");
    expect(request.optionIds).toEqual(["allow-once", "reject-once"]);
  });

  it("maps agent message, thought, and grok tool updates", () => {
    expect(
      eventsFromAcpUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hi" },
      }),
    ).toEqual([{ type: "message.delta", text: "Hi" }]);

    expect(
      eventsFromAcpUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Hmm" },
      }),
    ).toEqual([{ type: "reasoning.delta", text: "Hmm" }]);

    const early = eventsFromAcpUpdate({
      sessionUpdate: "tool_call_delta_chunk",
      tool_call_id: "call-0",
      name: "read_file",
    });
    expect(early[0]).toMatchObject({
      type: "tool.updated",
      callId: "call-0",
      kind: "read",
      status: "pending",
    });

    const tools = eventsFromAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      kind: "read",
      title: "Read README.md",
      status: "in_progress",
      _meta: {
        "x.ai/tool": {
          name: "read_file",
          kind: "read",
          label: "Read",
          input: { path: "README.md" },
        },
      },
    });
    expect(tools[0]).toMatchObject({
      type: "tool.updated",
      callId: "call-1",
      kind: "read",
      preview: { kind: "read", path: "README.md", fileName: "README.md" },
    });
  });

  // Payloads below are from a real Grok Build 4.7 turn with four model calls.
  it("sizes the context from each model call, cache included", () => {
    expect(
      eventsFromAcpUpdate({
        sessionId: "S1",
        update: {
          sessionUpdate: "response_completed",
          usage: {
            input_tokens: 797,
            output_tokens: 238,
            cache_read_input_tokens: 36224,
            cache_creation_input_tokens: 0,
            reasoning_tokens: 180,
          },
        },
      }),
    ).toEqual([{ type: "context", used: 37259 }]);
  });

  it("reports turn totals as metrics, not as the context size", () => {
    expect(
      eventsFromAcpUpdate({
        sessionId: "S1",
        update: {
          sessionUpdate: "turn_completed",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 148189,
            outputTokens: 605,
            totalTokens: 148794,
            cachedReadTokens: 111744,
            cacheCreationTokens: 0,
            reasoningTokens: 356,
            modelCalls: 4,
          },
        },
      }),
    ).toEqual([
      {
        type: "turn.metrics",
        // Grok's turn inputTokens include the cached part.
        inputTokens: 36445,
        outputTokens: 605,
        cacheReadTokens: 111744,
        cacheWriteTokens: 0,
        cacheHitPercent: (111744 / 148189) * 100,
      },
    ]);
  });

  it("takes the context after auto-compaction", () => {
    expect(
      eventsFromAcpUpdate({
        sessionUpdate: "auto_compact_completed",
        tokens_before: 180000,
        tokens_after: 42000,
        summary_preview: null,
      }),
    ).toEqual([{ type: "context", used: 42000 }]);
  });

  it("backs the meter up with the prompt result's last call size", () => {
    expect(
      contextFromPromptResult({
        stopReason: "end_turn",
        _meta: {
          totalTokens: 37563,
          inputTokens: 37509,
          usage: { totalTokens: 148794 },
        },
      }),
    ).toEqual([{ type: "context", used: 37563 }]);
    expect(contextFromPromptResult({ stopReason: "end_turn" })).toEqual([]);
  });

  it("sends files Grok cannot inline as paths", () => {
    expect(
      grokPromptBlocks("read it", [
        {
          id: "pdf-1",
          name: "note.pdf",
          mimeType: "application/pdf",
          kind: "file",
          size: 600,
          path: "/tmp/note.pdf",
        },
      ]),
    ).toEqual([
      { type: "text", text: "read it" },
      { type: "text", text: 'Attached file (read from disk): "/tmp/note.pdf"' },
    ]);
  });

  it("does not mistake a shell command for a file to read", () => {
    const [event] = eventsFromAcpUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-9",
        title: "run_terminal_command",
        rawInput: {
          command:
            "command find . -name '*.pdf' -not -path './.git/*' 2>/dev/null | sort -nr | head -30",
          description: "List PDFs",
        },
        _meta: {
          "x.ai/tool": {
            name: "run_terminal_command",
            kind: "execute",
            label: "Run Command",
          },
        },
      },
    });
    expect(event).toMatchObject({ type: "tool.updated", kind: "execute" });
    const preview = (event as { preview?: { kind: string; path?: string } })
      .preview;
    expect(preview?.kind).not.toBe("read");
    expect(preview?.path ?? "").not.toContain("sort -nr");
  });

  it("strips terminal colours from tool output", () => {
    const [event] = eventsFromAcpUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "\u001b[32mok\u001b[0m 3 passed" },
          },
        ],
      },
    });
    expect(event).toMatchObject({ detail: "ok 3 passed" });
  });

  it("accepts Hermes-style ACP usage size as the context window", () => {
    expect(
      eventsFromAcpUpdate({
        sessionUpdate: "usage_update",
        size: 131072,
        used: 32768,
      }),
    ).toEqual([{ type: "context", used: 32768, window: 131072 }]);
  });

  it("maps plan entries", () => {
    expect(
      eventsFromAcpUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect router", status: "completed" },
          { content: "Add test", status: "pending" },
        ],
      }),
    ).toEqual([
      {
        type: "tasks.updated",
        items: [
          { text: "Inspect router", status: "completed" },
          { text: "Add test", status: "pending" },
        ],
      },
    ]);
    expect(
      eventsFromAcpUpdate({ sessionUpdate: "plan", text: "# Approach" }),
    ).toEqual([{ type: "plan", text: "# Approach" }]);
  });

  it("parses initialize and session/new model catalogs", () => {
    const models = modelsFromInitialize({
      _meta: {
        modelState: {
          currentModelId: "grok-4.6",
          availableModels: [
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              _meta: {
                totalContextTokens: 500000,
                supportsReasoningEffort: true,
                reasoningEffort: "high",
                reasoningEfforts: [
                  { id: "xhigh", value: "xhigh", label: "Extra High Effort" },
                  {
                    id: "high",
                    value: "high",
                    label: "High Effort",
                    default: true,
                  },
                  { id: "low", value: "low", label: "Low Effort" },
                ],
              },
            },
          ],
        },
      },
    });
    expect(models[0]).toMatchObject({
      id: "grok:grok-4.6",
      harness: "grok",
      name: "Grok 4.6",
      nativeId: "grok-4.6",
      contextWindow: 500000,
    });
    expect(models[0]?.settings?.[0]).toMatchObject({
      id: "effort",
      value: "high",
    });
    expect(
      modelsFromSessionNew({
        models: {
          currentModelId: "grok-4.6",
          availableModels: [{ modelId: "grok-4.5", name: "Grok 4.5" }],
        },
      }).map((model) => model.nativeId),
    ).toEqual(["grok-4.5"]);
  });

  it("parses grok models text output", () => {
    const models = modelsFromGrokModelsOutput(
      "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n",
    );
    expect(models.map((model) => model.nativeId)).toEqual([
      "grok-4.6",
      "grok-4.5",
    ]);
  });

  it("ships a newest-first fallback catalog", () => {
    expect(fallbackGrokModels().map((model) => model.nativeId)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
    ]);
  });

  it("reads a session id from ACP setup results", () => {
    expect(sessionIdFromResult({ sessionId: "  abc  " })).toBe("abc");
    expect(sessionIdFromResult({ session_id: "xyz" })).toBe("xyz");
    expect(sessionIdFromResult({})).toBeUndefined();
  });

  it("reads effort from model settings", () => {
    expect(grokEffort({ effort: "xhigh" })).toBe("xhigh");
    expect(grokEffort({})).toBeUndefined();
  });

  it("answers ask-user questions from the form reply", () => {
    const questions = askQuestionsFromAcp({
      questions: [
        {
          question: "Which colour?",
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
    });
    expect(questions[0]?.prompt).toBe("Which colour?");
    expect(
      askQuestionResponse(
        {
          kind: "answered",
          answers: { "Which colour?": ["Blue"] },
        },
        questions,
      ),
    ).toEqual({
      outcome: "accepted",
      answers: { "Which colour?": "Blue" },
    });
    expect(askQuestionResponse({ kind: "skipped" }, questions)).toEqual({
      outcome: "skip_interview",
    });
  });

  it("extracts plan text from exit_plan_mode", () => {
    expect(planFromExitPlan({ planContent: "Ship it" })).toBe("Ship it");
  });
});
