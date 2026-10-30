import { describe, expect, it } from "vitest";
import {
  NO_RESPONSE_MS,
  QUIET_MS,
  SLOW_MIN_MODEL_SECONDS,
  SLOW_TOKENS_PER_SECOND,
  combineDots,
  gateLine,
  hostDot,
  machineLine,
  machineStrain,
  roundTripLine,
  sessionActivity,
  sessionLag,
  sessionLine,
  sessionRows,
  shortTime,
  sparkColumns,
} from "./labHealth";
import { dotFor, type HostHealth } from "./labHealthStore";
import type { LabHealth, LabHealthSession } from "./labProtocol";

function session(over: Partial<LabHealthSession> = {}): LabHealthSession {
  return {
    sessionId: "s1",
    name: "monocode-table",
    busy: true,
    quietMs: 4000,
    tokensPerSecond: 38,
    modelSeconds: 40,
    turnMs: 60_000,
    waitingOn: "model",
    ...over,
  };
}

function health(over: Partial<LabHealth> = {}): LabHealth {
  return {
    version: 1,
    machine: "vivobook",
    at: 1_000_000,
    cpu: { percent: 30, load1: 3.5, load5: 2, cores: 20 },
    memory: { totalMb: 24_000, availableMb: 12_000 },
    pressure: {
      memory: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
      cpu: null,
      io: null,
    },
    swap: { totalMb: 8192, usedMb: 1024, climbMbPerMin: 0 },
    temperatureC: 60,
    power: { source: "ac", batteryPercent: 80 },
    gate: {
      running: 10,
      max: 10,
      waiting: 1,
      agents: [
        { name: "a", memoryGb: 0.2 },
        { name: "b", memoryGb: 0.4 },
      ],
      sampledAt: 1,
    },
    sessions: [],
    history: [],
    ...over,
  };
}

describe("session lag", () => {
  it("leaves a healthy session alone", () => {
    expect(sessionLag(session())).toBeNull();
  });

  it("calls it slow under the line, with enough model time to judge", () => {
    expect(sessionLag(session({ tokensPerSecond: SLOW_TOKENS_PER_SECOND - 1 }))).toBe("slow");
    expect(sessionLag(session({ tokensPerSecond: SLOW_TOKENS_PER_SECOND }))).toBeNull();
    expect(
      sessionLag(session({ tokensPerSecond: 2, modelSeconds: SLOW_MIN_MODEL_SECONDS - 1 })),
    ).toBeNull();
  });

  it("calls 90 s of nothing slow, and 180 s no response", () => {
    const quiet = (quietMs: number) => session({ quietMs, tokensPerSecond: null });
    expect(sessionLag(quiet(QUIET_MS - 1))).toBeNull();
    expect(sessionLag(quiet(QUIET_MS))).toBe("slow");
    expect(sessionLag(quiet(NO_RESPONSE_MS - 1))).toBe("slow");
    expect(sessionLag(quiet(NO_RESPONSE_MS))).toBe("no-response");
  });

  it("no response beats slow", () => {
    expect(sessionLag(session({ quietMs: NO_RESPONSE_MS, tokensPerSecond: 1 }))).toBe("no-response");
  });

  it("never blames the model for a long tool or an idle session", () => {
    expect(sessionLag(session({ waitingOn: "tool", quietMs: 600_000, tokensPerSecond: 1 }))).toBeNull();
    expect(sessionLag(session({ busy: false, quietMs: 600_000, tokensPerSecond: 1 }))).toBeNull();
  });

  it("can't judge without a transcript", () => {
    expect(
      sessionLag(session({ quietMs: null, tokensPerSecond: null, waitingOn: null, modelSeconds: 0 })),
    ).toBeNull();
  });
});

describe("machine strain", () => {
  it("is quiet when all is well", () => {
    expect(machineStrain(health())).toEqual([]);
  });

  it("names each reason in plain words", () => {
    expect(
      machineStrain(
        health({
          pressure: {
            memory: { someAvg10: 0, someAvg60: 12, fullAvg10: 0, fullAvg60: 0 },
            cpu: null,
            io: null,
          },
          memory: { totalMb: 24_000, availableMb: 2400 },
          cpu: { percent: 99, load1: 24, load5: 20, cores: 20 },
          swap: { totalMb: 8192, usedMb: 4000, climbMbPerMin: 60 },
          temperatureC: 93,
        }),
      ),
    ).toEqual([
      "memory is under pressure",
      "only 10% of memory is free",
      "load is 24 on 20 cores",
      "swap is climbing",
      "it's running hot at 93°C",
    ]);
  });

  it("counts a short full stall as pressure", () => {
    expect(
      machineStrain(
        health({
          pressure: {
            memory: { someAvg10: 8, someAvg60: 1, fullAvg10: 6, fullAvg60: 1 },
            cpu: null,
            io: null,
          },
        }),
      ),
    ).toEqual(["memory is under pressure"]);
  });

  it("copes with what a machine can't tell", () => {
    expect(
      machineStrain(
        health({
          pressure: { memory: null, cpu: null, io: null },
          temperatureC: null,
          memory: { totalMb: 0, availableMb: 0 },
        }),
      ),
    ).toEqual([]);
  });
});

describe("words", () => {
  it("writes a session's row", () => {
    expect(sessionLine(session())).toBe("monocode-table · 38 tok/s · 4 s ago");
    expect(sessionLine(session({ waitingOn: "tool" }))).toBe("monocode-table · running a tool · 4 s ago");
    expect(sessionLine(session({ quietMs: null, tokensPerSecond: null }))).toBe("monocode-table · waiting");
    expect(sessionActivity(session({ tokensPerSecond: null }))).toBe("waiting");
  });

  it("shortens times", () => {
    expect(shortTime(4000)).toBe("4 s");
    expect(shortTime(120_000)).toBe("2 min");
    expect(shortTime(3 * 3_600_000)).toBe("3 h");
    expect(shortTime(72 * 3_600_000)).toBe("3 days");
  });

  it("writes the machine's lines", () => {
    expect(machineLine(health())).toBe("Load 3.5 on 20 cores · 60°C · Plugged in · Swap 1.0 GB");
    expect(
      machineLine(health({ power: { source: "battery", batteryPercent: 42 }, temperatureC: null })),
    ).toBe("Load 3.5 on 20 cores · On battery 42% · Swap 1.0 GB");
    expect(gateLine(health())).toBe("Agents 10 of 10 · 1 waiting · 0.3 GB each");
    expect(gateLine(health({ gate: null }))).toBeNull();
    expect(roundTripLine(41.6)).toBe("Round trip 42 ms");
    expect(roundTripLine(null)).toBeNull();
  });
});

describe("rows", () => {
  it("puts lagging sessions first and only counts idle ones", () => {
    const { rows, idle } = sessionRows(
      health({
        sessions: [
          session({ sessionId: "ok", name: "ok", turnMs: 500_000 }),
          session({ sessionId: "idle", name: "idle", busy: false }),
          session({ sessionId: "slow", name: "slow", tokensPerSecond: 2 }),
          session({ sessionId: "dead", name: "dead", quietMs: 200_000 }),
        ],
      }),
    );
    expect(rows.map((row) => row.session.name)).toEqual(["dead", "slow", "ok"]);
    expect(idle).toBe(1);
  });
});

describe("the chip's dot", () => {
  it("has nothing to say when all is well", () => {
    expect(hostDot(health({ sessions: [session()] }), "vivobook", false)).toEqual({ tone: null, reason: "" });
  });

  it("goes amber for slow and names the session", () => {
    const dot = hostDot(health({ sessions: [session({ tokensPerSecond: 3 })] }), "vivobook", false);
    expect(dot).toEqual({ tone: "amber", reason: "monocode-table: slow, 3 tok/s." });
  });

  it("says when a slow session has gone quiet", () => {
    const dot = hostDot(health({ sessions: [session({ quietMs: 120_000 })] }), "vivobook", false);
    expect(dot).toEqual({ tone: "amber", reason: "monocode-table: slow, nothing new for 2 min." });
  });

  it("goes amber when strained and says why", () => {
    const dot = hostDot(health({ temperatureC: 95 }), "vivobook", true);
    expect(dot).toEqual({ tone: "amber", reason: "vivobook is strained: it's running hot at 95°C." });
  });

  it("goes red for no response and says for how long", () => {
    const dot = hostDot(
      health({ temperatureC: 95, sessions: [session({ quietMs: 240_000 })] }),
      "vivobook",
      false,
    );
    expect(dot.tone).toBe("red");
    expect(dot.reason).toBe(
      "monocode-table: no response for 4 min. The machine is strained: it's running hot at 95°C.",
    );
  });

  it("takes the worst of several hosts", () => {
    expect(
      combineDots([
        { tone: "amber", reason: "A." },
        { tone: null, reason: "" },
        { tone: "red", reason: "B." },
      ]),
    ).toEqual({ tone: "red", reason: "A. B." });
    expect(combineDots([])).toEqual({ tone: null, reason: "" });
  });

  it("ignores old numbers from a host it can't reach", () => {
    const entry = (unreachable: boolean): HostHealth => ({
      health: health({ temperatureC: 95 }),
      roundTripMs: null,
      unreachable,
      error: "",
      failedAt: 0,
    });
    const names = [{ id: "m1", name: "vivobook" }];
    expect(dotFor(new Map([["m1", entry(false)]]), names).tone).toBe("amber");
    expect(dotFor(new Map([["m1", entry(true)]]), names).tone).toBeNull();
    expect(dotFor(new Map(), names).tone).toBeNull();
  });
});

describe("sparkline columns", () => {
  const read = (point: { cpu: number | null }) => point.cpu;

  it("places the newest on the right, snapped to pixel rows", () => {
    const columns = sparkColumns(
      [
        { at: 1000, cpu: 50, memoryAvailable: 0 },
        { at: 1000 - 10_000, cpu: 100, memoryAvailable: 0 },
      ],
      read,
      1000,
    );
    expect(columns).toHaveLength(60);
    expect(columns[59]).toBe(6);
    expect(columns[58]).toBe(12);
    expect(columns[57]).toBeNull();
  });

  it("drops what's older than 10 minutes and what has no value", () => {
    const columns = sparkColumns(
      [
        { at: 0, cpu: 50, memoryAvailable: 0 },
        { at: 700_000, cpu: null, memoryAvailable: 0 },
      ],
      read,
      700_000,
    );
    expect(columns.every((column) => column === null)).toBe(true);
  });

  it("keeps a small value visible and clamps a wild one", () => {
    const columns = sparkColumns(
      [
        { at: 1000, cpu: 0.5, memoryAvailable: 0 },
        { at: 1000 - 10_000, cpu: 400, memoryAvailable: 0 },
      ],
      read,
      1000,
    );
    expect(columns[59]).toBe(1);
    expect(columns[58]).toBe(12);
  });
});
