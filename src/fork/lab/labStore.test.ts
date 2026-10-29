// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabStatus, RemoteControlScope } from "./labProtocol";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { LAB_CHANGED } from "./labWatcher";
import {
  actionKey,
  getLabState,
  hostBusy,
  hostErrors,
  refreshLab,
  resetLabStore,
  setRemoteDesktop,
  setScope,
  subscribeLab,
} from "./labStore";

const machines = [
  { id: "m1", name: "vivobook", endpoint: "http://a", environmentId: "env-1" },
  { id: "m2", name: "pi", endpoint: "http://b", environmentId: "env-2" },
];

function hostStatus(scope: RemoteControlScope = "all", relay = true): LabStatus {
  return {
    version: 1,
    machine: "vivobook",
    platform: "linux",
    remoteControl: { desired: { scope, updatedAt: 1000, by: "Pixel" }, machines: [] },
    relay: { enabled: relay, updatedAt: 0, peers: [], sessions: 0 },
    uresourced: null,
    remoteDesktop: null,
  };
}

type Remote = (machineId: string, method: string, params: unknown) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const calls: string[] = [];
let remote: Remote;
let localScope: RemoteControlScope = "all";

beforeEach(() => {
  resetLabStore();
  calls.length = 0;
  localScope = "all";
  remote = (machineId, method) => {
    if (method === "environment.describe") {
      return { capabilities: machineId === "m1" ? ["lab.v1", "lab.tz.v1"] : [] };
    }
    return hostStatus();
  };
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "remote_request") {
      calls.push(`${args.machineId}:${args.method}`);
      return remote(args.machineId as string, args.method as string, args.params);
    }
    calls.push(command);
    if (command === "remote_machines") {
      return machines;
    }
    if (command === "fork_lab_rc_status") {
      return { scope: localScope, updatedAt: 500, by: "Mac", lab: false, wanted: true, accounts: [] };
    }
    if (command === "fork_lab_rc_apply") {
      localScope = args.scope as RemoteControlScope;
      return { scope: args.scope, updatedAt: args.updatedAt, by: args.by, lab: false, wanted: true, accounts: [] };
    }
    if (command === "fork_relay_status") {
      return { enabled: true, hosts: [] };
    }
    throw new Error(`unexpected ${command}`);
  });
});

afterEach(() => {
  resetLabStore();
});

describe("lab store discovery", () => {
  it("keeps only lab hosts and says which take the time zone", async () => {
    await refreshLab();
    const state = getLabState();
    expect(state.machinesLoaded).toBe(true);
    expect(state.hosts.map((host) => host.machine.id)).toEqual(["m1"]);
    expect(state.hosts[0].timeZone).toBe(true);
    expect(state.hosts[0].status?.relay.enabled).toBe(true);
    expect(state.local?.scope).toBe("all");
    expect(state.relay?.enabled).toBe(true);
  });

  it("asks each machine once, and again when the machine list changes", async () => {
    const stop = subscribeLab(() => {});
    await refreshLab();
    await refreshLab();
    expect(calls.filter((call) => call.endsWith("environment.describe"))).toHaveLength(2);
    window.dispatchEvent(new Event("monocode:remote-machines"));
    await refreshLab();
    expect(calls.filter((call) => call.endsWith("environment.describe"))).toHaveLength(4);
    stop();
  });

  it("asks a machine again when its describe failed", async () => {
    let fail = true;
    remote = (machineId, method) => {
      if (method === "environment.describe") {
        if (fail) {
          throw new Error("offline");
        }
        return { capabilities: ["lab.v1"] };
      }
      return hostStatus();
    };
    await refreshLab();
    expect(getLabState().hosts).toEqual([]);
    expect(getLabState().discovering).toBe(false);
    fail = false;
    await refreshLab();
    expect(getLabState().hosts.map((host) => host.machine.id)).toEqual(["m1", "m2"]);
  });

  it("marks a host offline when lab.status fails, and back when it answers", async () => {
    await refreshLab();
    remote = () => {
      throw new Error("Request timed out");
    };
    await refreshLab();
    let host = getLabState().hosts[0];
    expect(host.offline).toBe(true);
    expect(host.status).toBeDefined();
    expect(getLabState().errors[actionKey("m1", "load")]).toBe("The machine took too long to answer.");
    remote = () => hostStatus();
    await refreshLab();
    host = getLabState().hosts[0];
    expect(host.offline).toBe(false);
    expect(getLabState().errors[actionKey("m1", "load")]).toBeUndefined();
  });

  it("refreshes on a lab change while subscribed", async () => {
    const stop = subscribeLab(() => {});
    await refreshLab();
    const before = calls.filter((call) => call === "m1:lab.status").length;
    window.dispatchEvent(new Event(LAB_CHANGED));
    await refreshLab();
    expect(calls.filter((call) => call === "m1:lab.status").length).toBeGreaterThan(before);
    stop();
  });
});

describe("lab store changes", () => {
  it("sets the scope on this Mac first, then on the host, then tells the watcher", async () => {
    await refreshLab();
    calls.length = 0;
    const changed = vi.fn(() => calls.push("changed"));
    window.addEventListener(LAB_CHANGED, changed);
    remote = (_, method) => (method === "lab.remoteControl.set" ? hostStatus("lab") : hostStatus());
    await setScope("lab");
    window.removeEventListener(LAB_CHANGED, changed);
    expect(calls.slice(0, 3)).toEqual(["fork_lab_rc_apply", "m1:lab.remoteControl.set", "changed"]);
    expect(getLabState().hosts[0].status?.remoteControl.desired.scope).toBe("lab");
    expect(getLabState().errors.scope).toBeUndefined();
    expect(getLabState().busy.scope).toBeUndefined();
  });

  it("says so when the host keeps a newer choice", async () => {
    await refreshLab();
    remote = () => hostStatus("all");
    await setScope("lab");
    expect(getLabState().errors.scope).toBe("A newer choice was kept.");
    expect(hostErrors(getLabState(), "m1")).toEqual(["A newer choice was kept."]);
  });

  it("stamps the choice after both the host's and this Mac's", async () => {
    await refreshLab();
    let stamp = 0;
    remote = (_, method, params) => {
      if (method === "lab.remoteControl.set") {
        stamp = (params as { updatedAt: number }).updatedAt;
        return hostStatus("lab");
      }
      return hostStatus();
    };
    await setScope("lab");
    expect(stamp).toBeGreaterThan(1000);
    expect(stamp).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it("keeps a slow change busy until it answers, whoever is listening", async () => {
    await refreshLab();
    const answer = deferred<LabStatus>();
    remote = (_, method) => (method === "lab.remoteDesktop.set" ? answer.promise : hostStatus());
    const stop = subscribeLab(() => {});
    const done = setRemoteDesktop("m1", true);
    stop();
    expect(getLabState().busy[actionKey("m1", "rdp")]).toBe(true);
    expect(hostBusy(getLabState(), "m1")).toBe(true);
    const on = hostStatus();
    on.remoteDesktop = {
      installed: true,
      running: true,
      via: "monocode",
      lanExposed: false,
      address: "100.64.0.2",
      port: 3389,
      username: "sam",
      certificate: { present: false, sha256: null },
      systemUser: true,
      preauthorized: true,
      rdpFile: null,
      uri: null,
    };
    answer.resolve(on);
    await done;
    expect(getLabState().busy[actionKey("m1", "rdp")]).toBeUndefined();
    expect(getLabState().hosts[0].status?.remoteDesktop?.running).toBe(true);
  });

  it("drops a status read that started before a change answered", async () => {
    await refreshLab();
    const stale = deferred<LabStatus>();
    remote = (_, method) => (method === "lab.status" ? stale.promise : hostStatus("all", false));
    const reading = refreshLab();
    await vi.waitFor(() => expect(calls.at(-1)).toBe("m1:lab.status"));
    remote = (_, method) => (method === "lab.relay.set" ? hostStatus("all", false) : hostStatus());
    const { setRelay } = await import("./labStore");
    await setRelay("m1", false);
    stale.resolve(hostStatus("all", true));
    await reading;
    expect(getLabState().hosts[0].status?.relay.enabled).toBe(false);
  });

  it("keeps a failed change's words under its key", async () => {
    await refreshLab();
    remote = (_, method) => {
      if (method === "lab.remoteDesktop.set") {
        throw new Error("unknown method lab.remoteDesktop.set");
      }
      return hostStatus();
    };
    await setRemoteDesktop("m1", true);
    expect(getLabState().errors[actionKey("m1", "rdp")]).toBe("That needs a newer host on that machine.");
    expect(getLabState().hosts[0].offline).toBe(false);
  });
});
