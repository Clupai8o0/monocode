import { describe, expect, it } from "vitest";

import { choiceFor, ultracodeOn, withoutUltracode } from "@/features/models/modelChoice";
import type { ModelPick } from "@/features/models/types";

const on: ModelPick = {
  harness: "claude",
  model: "claude:opus",
  modelSettings: { effort: "xhigh", ultracode: "true" },
};
const off: ModelPick = { ...on, modelSettings: { effort: "xhigh", ultracode: "false" } };

describe("Ultracode", () => {
  it("reads whether a choice has it on", () => {
    expect(ultracodeOn(on)).toBe(true);
    expect(ultracodeOn(off)).toBe(false);
    expect(ultracodeOn(undefined)).toBe(false);
  });

  it("turns it off and keeps the other settings", () => {
    expect(withoutUltracode(on).modelSettings).toEqual({ effort: "xhigh", ultracode: "false" });
    expect(withoutUltracode(off)).toBe(off);
  });

  it("starts a new session with it off, even when the desktop's default has it on", () => {
    expect(ultracodeOn(choiceFor(null, on, true))).toBe(false);
  });

  it("keeps it on when turned on for the new session, and for an existing session", () => {
    expect(choiceFor(on, off, true)).toBe(on);
    expect(choiceFor(null, on, false)).toBe(on);
    expect(choiceFor(null, null, true)).toBeNull();
  });
});
