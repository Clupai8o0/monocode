// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  alertTab,
  closeMachines,
  currentMachineTab,
  machinesHover,
  openMachines,
  pickMachineTab,
  publishMachineSignal,
  resetMachines,
  worstTone,
  type MachineSignal,
  type MachineSignals,
} from "./machinesStore";

const quiet: MachineSignal = { tone: null, why: "", detail: "" };
const signals = (over: Partial<MachineSignals>): MachineSignals => ({
  lab: quiet,
  stacks: quiet,
  memory: quiet,
  ...over,
});
const amber = (why: string): MachineSignal => ({ tone: "amber", why, detail: "" });
const red = (why: string): MachineSignal => ({ tone: "red", why, detail: "" });

describe("the worst of the three", () => {
  it("is quiet when all are", () => {
    expect(worstTone(signals({}))).toBeNull();
    expect(alertTab(signals({}))).toBeNull();
  });

  it("takes red over amber, whichever tab has it", () => {
    const mixed = signals({ lab: amber("a"), memory: red("b") });
    expect(worstTone(mixed)).toBe("red");
    expect(alertTab(mixed)).toBe("memory");
  });

  it("takes the first tab on a tie", () => {
    expect(alertTab(signals({ stacks: amber("a"), memory: amber("b") }))).toBe("stacks");
  });
});

describe("the hover text", () => {
  it("names why, worst first", () => {
    expect(machinesHover(signals({ lab: amber("Lab is slow."), memory: red("Memory is very tight") }))).toBe(
      "Memory is very tight Lab is slow.",
    );
  });

  it("says how things stand when all is well", () => {
    expect(
      machinesHover(
        signals({
          lab: { ...quiet, detail: "Vivobook · 3 running" },
          memory: { ...quiet, detail: "Memory · 1.2 GB" },
        }),
      ),
    ).toBe("Vivobook · 3 running, Memory · 1.2 GB");
    expect(machinesHover(signals({}))).toBe("Machines");
  });
});

describe("which tab it opens on", () => {
  beforeEach(() => {
    localStorage.clear();
    resetMachines();
  });

  it("opens on the last tab used, and remembers it across a reload", () => {
    pickMachineTab("stacks");
    resetMachines();
    openMachines();
    expect(currentMachineTab()).toBe("stacks");
  });

  it("an alert wins, without becoming the last tab used", () => {
    pickMachineTab("stacks");
    publishMachineSignal("memory", red("tight"));
    openMachines();
    expect(currentMachineTab()).toBe("memory");
    closeMachines();
    publishMachineSignal("memory", quiet);
    openMachines();
    expect(currentMachineTab()).toBe("stacks");
  });
});
