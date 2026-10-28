// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import type { LocalRemoteControl } from "./labModel";
import type { LabParams, LabStatus, RemoteControlChoice } from "./labProtocol";
import { LAB_CHANGED, runLabPass, startLabWatcher, type LabDeps } from "./labWatcher";

const machine = (id: string): RemoteMachine => ({ id, name: id, endpoint: "http://x", environmentId: `env-${id}` });

function hostStatus(desired: RemoteControlChoice): LabStatus {
  return {
    version: 1,
    machine: "vivobook",
    platform: "linux",
    remoteControl: { desired, machines: [] },
    relay: { enabled: false, updatedAt: 0, peers: [], sessions: 0 },
    uresourced: null,
    remoteDesktop: null,
  };
}

function fakes(options: {
  machines?: RemoteMachine[];
  lab?: string[];
  local: LocalRemoteControl;
  hosts: Record<string, RemoteControlChoice>;
  failStatus?: string[];
}) {
  const calls: { machineId: string; method: string; params: unknown }[] = [];
  const applied: RemoteControlChoice[] = [];
  let local = { ...options.local };
  const failures: string[] = [];
  const deps: LabDeps = {
    machines: async () => options.machines ?? [machine("m1")],
    describe: async (id) => ({ capabilities: (options.lab ?? ["m1"]).includes(id) ? ["lab.v1"] : [] }),
    request: async <M extends keyof LabParams>(machineId: string, method: M, params: LabParams[M]) => {
      calls.push({ machineId, method, params });
      if (method === "lab.status" && options.failStatus?.includes(machineId)) {
        throw new Error("offline");
      }
      if (method === "lab.remoteControl.set") {
        const set = params as LabParams["lab.remoteControl.set"];
        if ((set.updatedAt ?? 0) >= options.hosts[machineId].updatedAt) {
          options.hosts[machineId] = { scope: set.scope, updatedAt: set.updatedAt ?? 0, by: "Mac" };
        }
      }
      return hostStatus(options.hosts[machineId]);
    },
    readLocal: async () => local,
    applyLocal: async (choice) => {
      applied.push(choice);
      local = { ...local, ...choice, accounts: local.accounts.map((a) => ({ ...a, enabled: choice.scope === "all" })) };
      return local;
    },
    platform: "darwin",
    fail: (step) => failures.push(step),
  };
  return { deps, calls, applied, failures };
}

const local: LocalRemoteControl = {
  scope: "all",
  updatedAt: 100,
  by: "Mac",
  lab: false,
  wanted: true,
  accounts: [{ account: "main", enabled: true }],
};

describe("runLabPass", () => {
  it("pushes this Mac's newer choice, then reports", async () => {
    const hosts = { m1: { scope: "lab" as const, updatedAt: 50, by: "Pixel" } };
    const { deps, calls, applied } = fakes({ local, hosts });
    const result = await runLabPass(deps);
    expect(result.pushed).toEqual(["m1"]);
    expect(applied).toEqual([]);
    expect(hosts.m1.scope).toBe("all");
    expect(calls.map((call) => call.method)).toEqual(["lab.status", "lab.remoteControl.set", "lab.report"]);
    expect(calls[2].params).toEqual({
      machine: "Mac",
      platform: "darwin",
      remoteControl: { scope: "all", updatedAt: 100, by: "Mac", accounts: [{ account: ".claude", enabled: true }] },
    });
  });

  it("applies the host's newer choice here and reports the result", async () => {
    const { deps, calls, applied } = fakes({ local, hosts: { m1: { scope: "lab", updatedAt: 200, by: "Pixel" } } });
    const result = await runLabPass(deps);
    expect(result.pulled).toEqual(["m1"]);
    expect(applied).toEqual([{ scope: "lab", updatedAt: 200, by: "Pixel" }]);
    const report = calls.find((call) => call.method === "lab.report")?.params as LabParams["lab.report"];
    expect(report.remoteControl).toMatchObject({ scope: "lab", updatedAt: 200, by: "Pixel" });
    expect(report.remoteControl.accounts).toEqual([{ account: ".claude", enabled: false }]);
  });

  it("carries a choice pulled from one host to the next", async () => {
    const hosts = {
      m1: { scope: "lab" as const, updatedAt: 300, by: "Pixel" },
      m2: { scope: "all" as const, updatedAt: 10, by: "old" },
    };
    const { deps } = fakes({ local, hosts, machines: [machine("m1"), machine("m2")], lab: ["m1", "m2"] });
    const result = await runLabPass(deps);
    expect(result.pulled).toEqual(["m1"]);
    expect(result.pushed).toEqual(["m2"]);
    expect(hosts.m2).toMatchObject({ scope: "lab", updatedAt: 300 });
  });

  it("takes the choice a host kept when it refuses the push, so the push does not repeat", async () => {
    const now = Date.now();
    // This Mac's stamp is a minute ahead; the host's clock runs an hour ahead, so it keeps its own.
    const hosts = { m1: { scope: "lab" as const, updatedAt: now + 3_600_000, by: "Pixel" } };
    const { deps, calls, applied } = fakes({ local: { ...local, updatedAt: now + 60_000 }, hosts });
    const result = await runLabPass(deps);
    expect(result.pushed).toEqual([]);
    expect(result.pulled).toEqual(["m1"]);
    expect(applied).toEqual([{ scope: "lab", updatedAt: now + 3_600_000, by: "Pixel" }]);
    const report = calls.find((call) => call.method === "lab.report")?.params as LabParams["lab.report"];
    expect(report.remoteControl.scope).toBe("lab");
    calls.length = 0;
    await runLabPass(deps);
    expect(calls.map((call) => call.method)).toEqual(["lab.status", "lab.report"]);
  });

  it("stamps a pulled choice past this Mac's later stamp, so its script keeps it", async () => {
    const now = Date.now();
    // Both stamps are far ahead, so both count as now and the host wins the tie.
    const hosts = { m1: { scope: "lab" as const, updatedAt: now + 600_000, by: "Pixel" } };
    const { deps, calls, applied } = fakes({ local: { ...local, updatedAt: now + 3_600_000 }, hosts });
    const apply = deps.applyLocal;
    // remote_control.py keeps the stored choice when the new one is older.
    const applyLocal: LabDeps["applyLocal"] = async (choice) => {
      const current = await deps.readLocal();
      return choice.updatedAt < current.updatedAt ? { ...current, changed: false } : apply(choice);
    };
    const result = await runLabPass({ ...deps, applyLocal });
    expect(result.pulled).toEqual(["m1"]);
    expect(applied).toEqual([{ scope: "lab", updatedAt: now + 3_600_001, by: "Pixel" }]);
    calls.length = 0;
    await runLabPass({ ...deps, applyLocal });
    expect(calls.map((call) => call.method)).toEqual(["lab.status", "lab.report"]);
  });

  it("skips machines without the lab capability and leaves this Mac alone", async () => {
    const readLocal = vi.fn();
    const { deps, calls } = fakes({ local, hosts: {}, lab: [] });
    const result = await runLabPass({ ...deps, readLocal });
    expect(result.hosts).toEqual([]);
    expect(calls).toEqual([]);
    expect(readLocal).not.toHaveBeenCalled();
  });

  it("does nothing when both agree, but still reports", async () => {
    const { deps, calls } = fakes({ local, hosts: { m1: { scope: "all", updatedAt: 100, by: "Mac" } } });
    await runLabPass(deps);
    expect(calls.map((call) => call.method)).toEqual(["lab.status", "lab.report"]);
  });

  it("keeps going past a failing host and says what failed", async () => {
    const hosts = { m1: { scope: "all" as const, updatedAt: 1, by: "x" }, m2: { scope: "all" as const, updatedAt: 1, by: "x" } };
    const { deps, failures } = fakes({
      local,
      hosts,
      machines: [machine("m1"), machine("m2")],
      lab: ["m1", "m2"],
      failStatus: ["m1"],
    });
    const result = await runLabPass(deps);
    expect(failures).toEqual(["status"]);
    expect(result.hosts).toEqual(["m2"]);
  });

  it("stops when this Mac's status can't be read", async () => {
    const { deps, calls, failures } = fakes({ local, hosts: { m1: { scope: "all", updatedAt: 1, by: "x" } } });
    const result = await runLabPass({
      ...deps,
      readLocal: async () => {
        throw new Error("Command fork_lab_rc_status not found");
      },
    });
    expect(failures).toEqual(["local"]);
    expect(calls).toEqual([]);
    expect(result.hosts).toEqual([]);
  });
});

describe("startLabWatcher", () => {
  it("runs at once, on a change, and stops", async () => {
    vi.useFakeTimers();
    try {
      const machines = vi.fn(async () => [] as RemoteMachine[]);
      const { deps } = fakes({ local, hosts: {} });
      const stop = startLabWatcher({ ...deps, machines }, 60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(machines).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event(LAB_CHANGED));
      await vi.advanceTimersByTimeAsync(0);
      expect(machines).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(machines).toHaveBeenCalledTimes(3);
      stop();
      window.dispatchEvent(new Event(LAB_CHANGED));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(machines).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
