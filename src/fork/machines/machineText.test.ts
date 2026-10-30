import { describe, expect, it } from "vitest";
import type { Where } from "./machineLabel";
import { deviceChipText, titleWithMachine, whereText } from "./machineText";

const remote: Where = {
  remote: true,
  label: "Vivobook · Linux",
  name: "Vivobook",
  info: { platform: "linux", checkedAt: 0 },
};
const local: Where = { remote: false, label: "This Mac", show: true };

describe("whereText", () => {
  it("labels remote paths and gated local ones", () => {
    expect(whereText(remote, { enabled: true })).toBe("Vivobook · Linux");
    expect(whereText(local, { enabled: true })).toBeUndefined();
    expect(whereText(local, { enabled: true, local: true })).toBe("This Mac");
    expect(whereText({ ...local, show: false }, { enabled: true, local: true })).toBeUndefined();
    expect(whereText(remote, { enabled: false })).toBeUndefined();
  });
});

describe("deviceChipText", () => {
  it("says what the agent is doing on the device", () => {
    expect(deviceChipText("Vivobook · Linux", false, true)).toBe("Vivobook · Linux");
    expect(deviceChipText("Vivobook · Linux", true, true)).toBe("Running on Vivobook · Linux");
    expect(deviceChipText("This Mac", true, undefined)).toBe("Running on This Mac");
    expect(deviceChipText("Vivobook · Linux", true, false)).toBe("Vivobook · Linux, reconnecting");
  });
});

describe("titleWithMachine", () => {
  it("names the machine before the app name", () => {
    expect(titleWithMachine("a — p — MonoCode", remote, true)).toBe(
      "a — p — Vivobook (Linux) — MonoCode",
    );
    expect(titleWithMachine("p — MonoCode", { ...remote, info: undefined }, true)).toBe(
      "p — Vivobook — MonoCode",
    );
    expect(titleWithMachine("p — MonoCode", local, true)).toBe("p — MonoCode");
    expect(titleWithMachine("p — MonoCode", remote, false)).toBe("p — MonoCode");
  });
});
