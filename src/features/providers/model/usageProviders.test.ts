import { describe, expect, it } from "vitest";
import {
  supportsFirstClassCliUpdates,
  supportsFirstClassUsage,
} from "../../../integrations/harness/core/firstClassProviders";
import { UPDATABLE_HARNESSES } from "./harnessUpdates";
import { monoUsageProviders } from "./usageProviders";

describe("usage footer and CLI updates from profiles", () => {
  it("excludes Grok from CLI updates", () => {
    expect(supportsFirstClassCliUpdates("grok")).toBe(false);
    expect(UPDATABLE_HARNESSES.has("grok")).toBe(false);
  });

  it("keeps first-class CLI-updatable harnesses plus opencode/pi", () => {
    expect(UPDATABLE_HARNESSES.has("claude")).toBe(true);
    expect(UPDATABLE_HARNESSES.has("codex")).toBe(true);
    expect(UPDATABLE_HARNESSES.has("opencode")).toBe(true);
    expect(UPDATABLE_HARNESSES.has("pi")).toBe(true);
  });

  it("excludes Grok from usage footer probes", () => {
    expect(supportsFirstClassUsage("grok")).toBe(false);
    expect(monoUsageProviders("grok")).toEqual([]);
  });

  it("keeps usage for first-class supported and opencode/devin extras", () => {
    expect(monoUsageProviders("claude")).toEqual(["claude"]);
    expect(monoUsageProviders("codex")).toEqual(["codex"]);
    expect(monoUsageProviders("opencode")).toEqual(["opencode"]);
    expect(monoUsageProviders("devin")).toEqual(["devin"]);
    expect(monoUsageProviders("cursor")).toEqual([]);
  });
});
