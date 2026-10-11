import { describe, expect, it } from "vitest";
import { eventsFromAcpUpdate } from "../grok/grokProtocol";
import {
  deepseekConfigOptions,
  deepseekModelValue,
  deepseekNativeModelId,
  deepseekSessionId,
  modelsFromDeepSeekSession,
  withDeepSeekToolKind,
} from "./deepseekProtocol";

// Trimmed from a real `dsh --profile acp` session/new reply (dsh 0.1.5-rc.2).
const SESSION_NEW = {
  sessionId: "41f9a119-abe7-4767-9d1f-bd527cdfc881",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: [
            { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V41-Flash" },
            { value: '["deepseek-official","deepseek-v4-flash"]', name: "DeepSeek-V4-Flash" },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
          ],
        },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
  ],
};

describe("DeepSeek Harness ACP protocol", () => {
  it("reads the session id and flattens grouped config options", () => {
    expect(deepseekSessionId(SESSION_NEW)).toBe(
      "41f9a119-abe7-4767-9d1f-bd527cdfc881",
    );
    const options = deepseekConfigOptions(SESSION_NEW);
    expect(options.map((option) => option.id)).toEqual([
      "model",
      "reasoning_effort",
    ]);
    expect(options[0].choices).toHaveLength(3);
  });

  it("round-trips model values through readable ids", () => {
    const value = '["deepseek-official","deepseek-v4-pro"]';
    expect(deepseekNativeModelId(value)).toBe("deepseek-official/deepseek-v4-pro");
    const choices = deepseekConfigOptions(SESSION_NEW)[0].choices;
    expect(deepseekModelValue("deepseek-official/deepseek-v4-pro", choices)).toBe(
      value,
    );
    expect(deepseekModelValue("nope/nope", choices)).toBeUndefined();
  });

  it("lists models with the profile default first and an effort setting", () => {
    const models = modelsFromDeepSeekSession(SESSION_NEW);
    expect(models.map((model) => model.id)).toEqual([
      "deepseek:deepseek-official/deepseek-v4-flash",
      "deepseek:deepseek-official/deepseek-flash",
      "deepseek:deepseek-official/deepseek-v4-pro",
    ]);
    expect(models[0].name).toBe("DeepSeek V4 Flash");
    expect(models[0].settings?.[0]).toMatchObject({
      id: "effort",
      value: "high",
    });
    expect(models[0].settings?.[0].options.map((option) => option.value)).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
  });

  it("gives dsh's untyped tool calls a kind from their title", () => {
    const params = {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "bash",
        kind: "other",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
    };
    const [event] = eventsFromAcpUpdate(withDeepSeekToolKind(params));
    expect(event).toMatchObject({ type: "tool.updated", kind: "execute" });

    const unknown = { update: { ...params.update, title: "mystery" } };
    expect(withDeepSeekToolKind(unknown)).toBe(unknown);
  });
});
