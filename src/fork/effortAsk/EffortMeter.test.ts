import { describe, expect, it } from "vitest";
import { effortMeterLevel, effortStepDelays } from "./EffortMeter";

describe("effortMeterLevel", () => {
  it("fills one bar per step from low to max", () => {
    expect(
      ["low", "medium", "high", "xhigh", "max"].map(effortMeterLevel),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("cannot show a level outside the five", () => {
    expect(effortMeterLevel("ultracode")).toBeNull();
    expect(effortMeterLevel(undefined)).toBeNull();
  });
});

describe("effortStepDelays", () => {
  it("fills upward, lowest changed bar first", () => {
    expect(effortStepDelays(1, 4)).toEqual([0, 0, 70, 140, 0]);
  });

  it("drains downward, highest changed bar first", () => {
    expect(effortStepDelays(4, 1)).toEqual([0, 140, 70, 0, 0]);
  });

  it("does not wait when nothing changes", () => {
    expect(effortStepDelays(3, 3)).toEqual([0, 0, 0, 0, 0]);
  });

  it("finishes the longest walk inside the 450 ms budget", () => {
    expect(Math.max(...effortStepDelays(1, 5)) + 150).toBeLessThanOrEqual(450);
  });
});
