import { describe, expect, it } from "vitest";
import { buildTurnStartParams } from "../../integrations/harness/providers/codex/codexProtocol";

describe("Codex MonoCode turn context", () => {
  it("uses the current effort, preserves the user's text and native plan instructions", () => {
    const params = buildTurnStartParams({
      threadId: "t",
      runtimeMode: "auto",
      model: "codex-model",
      effort: "high",
      prompt: "Review @src/main.ts",
      intent: "plan",
      monoCodeContext: true,
    });
    expect(params.effort).toBe("high");
    expect(params.collaborationMode).toMatchObject({
      mode: "plan",
      settings: { reasoning_effort: "high", developer_instructions: null },
    });
    const input = params.input as Array<{ text: string }>;
    expect(input[0].text).toContain('reasoning effort "high" for this turn');
    expect(input[0].text).toContain("/operator when the user enables it");
    expect(input[1]).toEqual({ type: "text", text: "Review @src/main.ts" });
  });

  it("does not create a turn from context alone or guess an unspecified effort", () => {
    expect(
      buildTurnStartParams({
        threadId: "t",
        runtimeMode: "auto",
        monoCodeContext: true,
      }).input,
    ).toEqual([]);
    const params = buildTurnStartParams({
      threadId: "t",
      runtimeMode: "auto",
      prompt: "Continue",
      monoCodeContext: true,
    });
    expect((params.input as Array<{ text: string }>)[0].text).toContain(
      "did not override reasoning effort",
    );
  });

  it("takes each turn's effort rather than keeping the previous setting", () => {
    for (const effort of ["high", "low"]) {
      const params = buildTurnStartParams({
        threadId: "same",
        runtimeMode: "auto",
        effort,
        prompt: "Next task",
        monoCodeContext: true,
      });
      expect((params.input as Array<{ text: string }>)[0].text).toContain(
        `reasoning effort "${effort}" for this turn`,
      );
    }
  });
});
