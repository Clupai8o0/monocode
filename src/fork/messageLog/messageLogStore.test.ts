import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const remoteRequest = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../features/connections/model/connections", () => ({
  remoteRequest: (...args: unknown[]) => remoteRequest(...args),
}));

import {
  HOST_FAST_MS,
  MAC_FAST_MS,
  SLOW_MS,
  __messageLogStateForTests,
  __pollMessageLogForTests,
  __resetMessageLogForTests,
  __subscribeMessageLogForTests,
  publishMonoSessions,
  setMessageLogWindow,
} from "./messageLogStore";
import type { MessageLogAnswer, RelayTrafficAnswer } from "./messageLogProtocol";

const NOW = Date.now();

function answer(machine: string, extra: Partial<MessageLogAnswer> = {}): MessageLogAnswer {
  return {
    version: 1,
    machine,
    epoch: "e1",
    cursor: 1,
    full: true,
    windowHours: 24,
    scannedAt: NOW,
    sessions: [{ sessionId: "s1", account: "main", name: "one", cwd: "/p/one", project: "one" }],
    proxies: [],
    events: [],
    ...extra,
  };
}

function hops(machine: string, enabled = true): RelayTrafficAnswer {
  return { version: 1, machine, epoch: "t1", cursor: 0, enabled, hops: [] };
}

let hostDescribe: unknown;
let hostFails = false;

beforeEach(() => {
  __resetMessageLogForTests(false);
  invoke.mockReset();
  remoteRequest.mockReset();
  hostDescribe = { capabilities: ["messages.v1", "relay.traffic.v1"], osName: "Ubuntu" };
  hostFails = false;
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "fork_message_log") {
      return answer("mac-dev");
    }
    if (cmd === "fork_relay_traffic") {
      return hops("mac-dev");
    }
    if (cmd === "remote_machines") {
      return [{ id: "m-vivo", name: "Vivobook", endpoint: "", environmentId: "env" }];
    }
    throw new Error(`unexpected ${cmd}`);
  });
  remoteRequest.mockImplementation(async (_id: string, method: string) => {
    if (hostFails) {
      throw new Error("timed out");
    }
    if (method === "environment.describe") {
      return hostDescribe;
    }
    if (method === "messages.list") {
      return answer("vivobook", { sessions: [] });
    }
    if (method === "relay.traffic") {
      return hops("vivobook");
    }
    throw new Error(`unexpected ${method}`);
  });
});

afterEach(() => {
  __resetMessageLogForTests(false);
  vi.useRealTimers();
});

describe("messageLogStore", () => {
  it("polls this Mac and hosts, then asks with since", async () => {
    expect(__messageLogStateForTests().view.loading).toBe(true);
    await __pollMessageLogForTests();
    const { view } = __messageLogStateForTests();
    expect(view.loading).toBe(false);
    expect(view.sources.map((s) => [s.place.label, s.state, s.relay, s.place.os])).toEqual([
      ["This Mac", "ok", "on", "macOS"],
      ["Vivobook", "ok", "on", "Ubuntu"],
    ]);
    expect(invoke).toHaveBeenCalledWith("fork_message_log", { params: { windowHours: 24 } });
    await __pollMessageLogForTests();
    expect(invoke).toHaveBeenLastCalledWith("remote_machines");
    expect(invoke).toHaveBeenCalledWith("fork_message_log", {
      params: { windowHours: 24, since: { epoch: "e1", cursor: 1 } },
    });
    expect(invoke).toHaveBeenCalledWith("fork_relay_traffic", { params: { since: { epoch: "t1", cursor: 0 } } });
    expect(remoteRequest).toHaveBeenCalledWith("m-vivo", "messages.list", {
      windowHours: 24,
      since: { epoch: "e1", cursor: 1 },
    });
    expect(remoteRequest.mock.calls.filter((c) => c[1] === "environment.describe")).toHaveLength(1);
  });

  it("marks an older host and one without relay traffic", async () => {
    hostDescribe = { capabilities: [] };
    await __pollMessageLogForTests();
    expect(__messageLogStateForTests().view.sources[1].state).toBe("old-host");
    __resetMessageLogForTests(false);
    hostDescribe = { capabilities: ["messages.v1"] };
    await __pollMessageLogForTests();
    expect(__messageLogStateForTests().view.sources[1]).toMatchObject({ state: "ok", relay: "absent" });
    expect(remoteRequest.mock.calls.some((c) => c[1] === "relay.traffic")).toBe(false);
  });

  it("keeps the last answer when a host goes offline", async () => {
    await __pollMessageLogForTests();
    hostFails = true;
    await __pollMessageLogForTests();
    const source = __messageLogStateForTests().view.sources[1];
    expect(source).toMatchObject({ state: "offline", error: "timed out", scannedAt: NOW });
    expect(__messageLogStateForTests().view.graph.places[1].state).toBe("offline");
  });

  it("reports an error from this Mac", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_machines") {
        return [];
      }
      throw new Error("boom");
    });
    await __pollMessageLogForTests();
    expect(__messageLogStateForTests().view.sources[0]).toMatchObject({ state: "error", error: "boom" });
    expect(__messageLogStateForTests().view.loading).toBe(false);
  });

  it("uses the window choice and mono sessions", async () => {
    setMessageLogWindow("7d");
    publishMonoSessions([{ id: "mono-1", providerSessionId: "s1", placeId: "local" }]);
    await __pollMessageLogForTests();
    expect(invoke).toHaveBeenCalledWith("fork_message_log", { params: { windowHours: 168 } });
    const { view } = __messageLogStateForTests();
    expect(view.window).toBe("7d");
    expect(view.graph.places[0].nodes[0].openId).toBe("mono-1");
  });

  it("starts no timers unless polling is on", () => {
    const off = __subscribeMessageLogForTests(true);
    expect(__messageLogStateForTests().timers).toBe("off");
    off();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("polls fast while the window is open, slow otherwise, never with nobody", async () => {
    vi.useFakeTimers();
    __resetMessageLogForTests(true);
    const count = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).length;
    const slow = __subscribeMessageLogForTests(false);
    expect(__messageLogStateForTests().timers).toBe("slow");
    await vi.advanceTimersByTimeAsync(0);
    expect(count("fork_message_log")).toBe(1);
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(count("fork_message_log")).toBe(2);
    const fast = __subscribeMessageLogForTests(true);
    expect(__messageLogStateForTests().timers).toBe("fast");
    await vi.advanceTimersByTimeAsync(0);
    const before = count("fork_message_log");
    const hostsBefore = count("remote_machines");
    await vi.advanceTimersByTimeAsync(HOST_FAST_MS);
    expect(count("fork_message_log") - before).toBe(HOST_FAST_MS / MAC_FAST_MS);
    expect(count("remote_machines") - hostsBefore).toBe(1);
    fast();
    slow();
    expect(__messageLogStateForTests().timers).toBe("off");
    const idle = count("fork_message_log");
    await vi.advanceTimersByTimeAsync(SLOW_MS * 2);
    expect(count("fork_message_log")).toBe(idle);
  });

  it("keeps the view when an incremental answer brings nothing new", async () => {
    await __pollMessageLogForTests();
    const before = __messageLogStateForTests().view;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fork_message_log") {
        return answer("mac-dev", { full: false, cursor: 2 });
      }
      if (cmd === "fork_relay_traffic") {
        return hops("mac-dev");
      }
      return [{ id: "m-vivo", name: "Vivobook", endpoint: "", environmentId: "env" }];
    });
    remoteRequest.mockImplementation(async (_id: string, method: string) =>
      method === "messages.list" ? answer("vivobook", { sessions: [], full: false, cursor: 2 }) : hops("vivobook"),
    );
    await __pollMessageLogForTests();
    expect(__messageLogStateForTests().view).toBe(before);
    // Times in the view get old: a poll rebuilds it every 30 s regardless.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    await __pollMessageLogForTests();
    const aged = __messageLogStateForTests().view;
    expect(aged).not.toBe(before);
    await __pollMessageLogForTests();
    expect(__messageLogStateForTests().view).toBe(aged);
    remoteRequest.mockImplementation(async (_id: string, method: string) =>
      method === "messages.list" ? answer("vivobook", { full: false, cursor: 3 }) : hops("vivobook"),
    );
    await __pollMessageLogForTests();
    expect(__messageLogStateForTests().view).not.toBe(aged);
  });

  it("does not let one slow host hold up the others", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fork_message_log") {
        return answer("mac-dev");
      }
      if (cmd === "fork_relay_traffic") {
        return hops("mac-dev");
      }
      return [
        { id: "m-slow", name: "Slow", endpoint: "", environmentId: "env" },
        { id: "m-vivo", name: "Vivobook", endpoint: "", environmentId: "env" },
      ];
    });
    remoteRequest.mockImplementation((id: string, method: string) => {
      if (method === "environment.describe") {
        return Promise.resolve(hostDescribe);
      }
      if (id === "m-slow") {
        return new Promise(() => {});
      }
      return Promise.resolve(method === "messages.list" ? answer("vivobook", { sessions: [] }) : hops("vivobook"));
    });
    const lists = () => remoteRequest.mock.calls.filter((c) => c[0] === "m-vivo" && c[1] === "messages.list").length;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    void __pollMessageLogForTests();
    await settle();
    expect(lists()).toBe(1);
    void __pollMessageLogForTests();
    await settle();
    expect(lists()).toBe(2);
    expect(remoteRequest.mock.calls.filter((c) => c[0] === "m-slow" && c[1] === "messages.list")).toHaveLength(1);
  });
});

