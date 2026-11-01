import { describe, expect, it } from "vitest";
import { cappedAutoOption, cappedStartSettings } from "./effortCap";

describe("cappedStartSettings", () => {
  it("starts a new session on High at most", () => {
    expect(
      cappedStartSettings(
        { effort: "max", fast: "true" },
        "effort",
        undefined,
        true,
      ),
    ).toEqual({ effort: "high", fast: "true" });
    expect(
      cappedStartSettings({ effort: "xhigh" }, "effort", undefined, true),
    ).toEqual({
      effort: "high",
    });
  });

  it("keeps a stored effort at or under High", () => {
    const stored = { effort: "medium" };
    expect(cappedStartSettings(stored, "effort", undefined, true)).toBe(stored);
  });

  it("keeps a session's own higher effort across a model switch", () => {
    expect(
      cappedStartSettings(
        { effort: "max" },
        "effort",
        { effort: "xhigh" },
        true,
      ),
    ).toEqual({ effort: "xhigh" });
    expect(
      cappedStartSettings({ effort: "max" }, "effort", { effort: "max" }, true),
    ).toEqual({ effort: "max" });
  });

  it("uses the model's own effort setting id", () => {
    expect(
      cappedStartSettings({ variant: "max" }, "variant", undefined, true),
    ).toEqual({ variant: "high" });
  });

  it("does nothing when off or the model has no effort setting", () => {
    const stored = { effort: "max" };
    expect(cappedStartSettings(stored, "effort", undefined, false)).toBe(
      stored,
    );
    expect(cappedStartSettings(stored, undefined, undefined, true)).toBe(
      stored,
    );
  });
});

describe("cappedAutoOption", () => {
  const claude = ["max", "xhigh", "high", "medium", "low"].map((value) => ({
    value,
  }));
  const deepseek = ["off", "low", "high", "max"].map((value) => ({ value }));

  it("holds a switch to Max at Extra High", () => {
    expect(cappedAutoOption(claude, "max", "high")).toBe("xhigh");
    expect(cappedAutoOption(claude, "max", "xhigh")).toBe("xhigh");
  });

  it("does not round up to Max on a model without Extra High", () => {
    expect(cappedAutoOption(deepseek, "max", "low")).toBe("high");
    expect(cappedAutoOption(deepseek, "max", "high")).toBe("high");
  });

  it("leaves a session the user put on Max there", () => {
    expect(cappedAutoOption(claude, "max", "max")).toBe("max");
  });

  it("passes lower levels through", () => {
    expect(cappedAutoOption(claude, "high", "max")).toBe("high");
    expect(cappedAutoOption(claude, "xhigh", "low")).toBe("xhigh");
  });
});

describe("rank names", () => {
  it("caps Cursor's extra-high and Claude's ultrathink at the start", () => {
    expect(
      cappedStartSettings({ effort: "extra-high" }, "effort", undefined, true),
    ).toEqual({ effort: "high" });
    expect(
      cappedStartSettings({ effort: "ultrathink" }, "effort", undefined, true),
    ).toEqual({ effort: "high" });
  });
});
