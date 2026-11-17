import { describe, expect, it } from "vitest";
import { RUNTIME_MODE_HINT, runtimeModeHints } from "./session";

describe("runtimeModeHints", () => {
  it("says Grok runs its Auto-review under Supervised", () => {
    expect(runtimeModeHints("grok").supervised).toMatch(/Auto-review/);
    expect(runtimeModeHints("grok").auto).toBe(RUNTIME_MODE_HINT.auto);
  });

  it("keeps the general wording for other harnesses", () => {
    expect(runtimeModeHints("claude")).toBe(RUNTIME_MODE_HINT);
    expect(runtimeModeHints(undefined)).toBe(RUNTIME_MODE_HINT);
  });
});
