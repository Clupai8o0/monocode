import { describe, expect, it } from "vitest";
import type { HarnessId } from "../../../features/sessions/model/session";
import {
  firstClassProviders,
  getFirstClassProfile,
  handoffTargets,
  supportsFirstClassAccounts,
  supportsFirstClassAccountProfiles,
  supportsFirstClassHandoff,
  supportsFirstClassMcpDiscovery,
  supportsFirstClassUsage,
  supportsFirstClassCliUpdates,
} from "./firstClassProviders";

const handoffHelpers = {
  defaultModelId: (harness: HarnessId) => `${harness}:default`,
  isKnownModel: (_harness: HarnessId, model: string) =>
    model.endsWith(":known"),
};

describe("firstClassProviders", () => {
  it("registers claude, codex, and grok only", () => {
    expect(firstClassProviders().sort()).toEqual(["claude", "codex", "grok"]);
  });

  it("exposes honest capabilities", () => {
    expect(getFirstClassProfile("claude")?.accounts).toBe("profiles");
    expect(getFirstClassProfile("codex")?.accounts).toBe("profiles");
    expect(getFirstClassProfile("grok")?.accounts).toBe("default-only");
    expect(supportsFirstClassUsage("claude")).toBe(true);
    expect(supportsFirstClassUsage("grok")).toBe(false);
    expect(supportsFirstClassCliUpdates("codex")).toBe(true);
    expect(supportsFirstClassCliUpdates("grok")).toBe(false);
    expect(supportsFirstClassMcpDiscovery("grok")).toBe(true);
    expect(supportsFirstClassAccounts("devin")).toBe(false);
    expect(supportsFirstClassAccountProfiles("claude")).toBe(true);
    expect(supportsFirstClassAccountProfiles("grok")).toBe(false);
  });

  it("toHandoffPrefs copies model, settings, accessMode, account, and mcpServerIds", () => {
    const profile = getFirstClassProfile("claude");
    expect(profile).toBeDefined();

    const prefs = profile!.toHandoffPrefs({
      model: "claude:known",
      modelSettings: { effort: "high" },
      runtimeMode: "supervised",
      providerAccountId: "acct-1",
      mcpServerIds: ["fs", "git"],
    });

    expect(prefs).toEqual({
      model: "claude:known",
      modelSettings: { effort: "high" },
      accessMode: "supervised",
      providerAccountId: "acct-1",
      mcpServerIds: ["fs", "git"],
    });
    expect(prefs.modelSettings).not.toBe({ effort: "high" });
  });

  it("fromHandoffPrefs drops unknown models via defaultModelId", () => {
    const profile = getFirstClassProfile("claude");
    expect(profile).toBeDefined();

    const unknown = profile!.fromHandoffPrefs(
      {
        model: "codex:unknown",
        modelSettings: { effort: "low" },
        accessMode: "auto",
        mcpServerIds: ["fs"],
      },
      handoffHelpers,
    );
    expect(unknown).toEqual({
      model: "claude:default",
      modelSettings: { effort: "low" },
      runtimeMode: "auto",
      mcpServerIds: ["fs"],
    });

    const known = profile!.fromHandoffPrefs(
      { model: "claude:known", accessMode: "supervised" },
      handoffHelpers,
    );
    expect(known.model).toBe("claude:known");
  });

  it("codex fromHandoffPrefs forces runtimeMode full-access", () => {
    const profile = getFirstClassProfile("codex");
    expect(profile).toBeDefined();

    const mapped = profile!.fromHandoffPrefs(
      {
        model: "codex:known",
        modelSettings: {},
        accessMode: "supervised",
      },
      handoffHelpers,
    );

    expect(mapped.runtimeMode).toBe("full-access");
  });

  it("offers every other handoff peer", () => {
    expect(handoffTargets("claude").sort()).toEqual(["codex", "grok"]);
    expect(handoffTargets("codex").sort()).toEqual(["claude", "grok"]);
    expect(handoffTargets("grok").sort()).toEqual(["claude", "codex"]);
    expect(supportsFirstClassHandoff("fx")).toBe(false);
    expect(handoffTargets("fx")).toEqual([]);
  });
});
