import { describe, expect, it } from "vitest";
import {
  firstClassProviders,
  getFirstClassProfile,
  handoffTargets,
  supportsFirstClassAccounts,
  supportsFirstClassHandoff,
  supportsFirstClassMcpDiscovery,
  supportsFirstClassUsage,
  supportsFirstClassCliUpdates,
} from "./firstClassProviders";

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
  });

  it("offers every other handoff peer", () => {
    expect(handoffTargets("claude").sort()).toEqual(["codex", "grok"]);
    expect(handoffTargets("codex").sort()).toEqual(["claude", "grok"]);
    expect(handoffTargets("grok").sort()).toEqual(["claude", "codex"]);
    expect(supportsFirstClassHandoff("fx")).toBe(false);
    expect(handoffTargets("fx")).toEqual([]);
  });
});
