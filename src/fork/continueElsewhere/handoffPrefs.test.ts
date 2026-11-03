import { describe, expect, it } from "vitest";
import { buildHandoffTarget, sourceHandoffPrefs } from "./handoffPrefs";

const helpers = {
  defaultModelId: (harness: "claude" | "codex" | "grok") =>
    ({ claude: "claude:default", codex: "codex:default", grok: "grok:grok-4.7" })[
      harness
    ],
  isKnownModel: (harness: string, model: string) => model.startsWith(`${harness}:`),
};

describe("handoffPrefs", () => {
  it("copies source-native prefs", () => {
    expect(
      sourceHandoffPrefs({
        harness: "claude",
        model: "claude:opus",
        modelSettings: { effort: "high" },
        runtimeMode: "supervised",
        providerAccountId: "work",
        mcpServerIds: ["filesystem"],
      }),
    ).toMatchObject({
      model: "claude:opus",
      modelSettings: { effort: "high" },
      accessMode: "supervised",
      providerAccountId: "work",
      mcpServerIds: ["filesystem"],
    });
  });

  it("maps to Codex with full-access and drops unknown models", () => {
    const target = buildHandoffTarget(
      "codex",
      {
        model: "claude:opus",
        modelSettings: { effort: "high" },
        accessMode: "supervised",
        mcpServerIds: ["filesystem"],
      },
      helpers,
    );
    expect(target.model).toBe("codex:default");
    expect(target.runtimeMode).toBe("full-access");
    expect(target.modelSettings.effort).toBe("high");
  });

  it("keeps a known Grok model when continuing to Grok", () => {
    const target = buildHandoffTarget(
      "grok",
      { model: "grok:grok-4.7", modelSettings: { effort: "low" }, accessMode: "auto" },
      helpers,
    );
    expect(target.model).toBe("grok:grok-4.7");
    expect(target.runtimeMode).toBe("auto");
  });
});
