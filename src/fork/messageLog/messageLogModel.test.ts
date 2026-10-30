import { describe, expect, it } from "vitest";
import {
  buildMessageLogView,
  mergeLogAnswer,
  mergeTraffic,
  type BuildInput,
  type SourceInput,
} from "./messageLogModel";
import type {
  MessageLogAnswer,
  ReceiveEvent,
  RelayHop,
  RelayTrafficAnswer,
  SendEvent,
} from "./messageLogProtocol";
import type { Place } from "./messageLogView";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const MAC: Place = { id: "local", label: "This Mac", os: "macOS", local: true };
const VIVO: Place = { id: "m-vivo", label: "Vivobook", os: "Linux", local: false };

function log(machine: string, events: (SendEvent | ReceiveEvent)[], extra: Partial<MessageLogAnswer> = {}): MessageLogAnswer {
  return {
    version: 1,
    machine,
    epoch: "e1",
    cursor: 1,
    full: true,
    windowHours: 168,
    scannedAt: NOW,
    sessions: [],
    proxies: [],
    events,
    ...extra,
  };
}

function send(id: string, at: number, extra: Partial<SendEvent> = {}): SendEvent {
  return {
    kind: "send",
    id,
    rev: 1,
    at,
    updatedAt: at,
    sessionId: "s-alpha",
    account: "main",
    to: "beta",
    toAddress: "name",
    preview: "hello",
    key: "hello",
    status: "sent",
    ...extra,
  };
}

function recv(id: string, at: number, extra: Partial<ReceiveEvent> = {}): ReceiveEvent {
  return {
    kind: "receive",
    id,
    rev: 1,
    at,
    updatedAt: at,
    sessionId: "s-beta",
    account: "main",
    fromName: "alpha",
    fromAddress: "name",
    preview: "hello",
    key: "hello",
    ...extra,
  };
}

function traffic(machine: string, hops: RelayHop[], enabled = true): RelayTrafficAnswer {
  return { version: 1, machine, epoch: "t1", cursor: hops.length, enabled, hops };
}

function hop(seq: number, extra: Partial<RelayHop> = {}): RelayHop {
  return {
    id: `h${seq}`,
    seq,
    at: NOW - 5 * MIN,
    peer: "vivobook",
    direction: "out",
    kind: "message",
    outcome: "passed",
    ...extra,
  };
}

const SESSIONS_MAC = [
  { sessionId: "s-alpha", account: "main" as const, name: "alpha", cwd: "/p/a", project: "a" },
  { sessionId: "s-beta", account: "main" as const, name: "beta", cwd: "/p/b", project: "b" },
  { sessionId: "s-idle", account: "cx" as const, cwd: "/p/idle", project: "idle" },
];

function build(sources: SourceInput[], extra: Partial<BuildInput> = {}) {
  return buildMessageLogView({
    window: "24h",
    now: NOW,
    sources,
    mono: [],
    formatTime: (at) => `T${(at - NOW) / MIN}`,
    loading: false,
    ...extra,
  });
}

function mac(events: (SendEvent | ReceiveEvent)[], more: Partial<SourceInput> = {}): SourceInput {
  return { place: MAC, state: "ok", log: log("mac-dev", events, { sessions: SESSIONS_MAC }), traffic: traffic("mac-dev", []), ...more };
}

const LOCAL_BETA = { machine: "mac-dev", sessionId: "s-beta", name: "beta", route: "local" as const };

describe("mergeLogAnswer", () => {
  it("takes a full answer alone and drops old events", () => {
    const prev = log("m", [send("a", NOW - MIN)]);
    const next = log("m", [send("b", NOW - 2 * MIN), send("old", NOW - 30 * 3_600_000)], { windowHours: 24 });
    expect(mergeLogAnswer(prev, next, NOW).events.map((e) => e.id)).toEqual(["b"]);
  });

  it("upserts an incremental answer by id, sorted by (at, id)", () => {
    const prev = log("m", [send("a", NOW - 3 * MIN), send("c", NOW - MIN)]);
    const next = log("m", [send("a", NOW - 3 * MIN, { status: "failed" }), send("b", NOW - MIN)], { full: false, cursor: 2 });
    const merged = mergeLogAnswer(prev, next, NOW);
    expect(merged.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect((merged.events[0] as SendEvent).status).toBe("failed");
    expect(merged.cursor).toBe(2);
  });

  it("starts over on a new epoch", () => {
    const prev = log("m", [send("a", NOW - MIN)]);
    const next = log("m", [send("b", NOW - MIN)], { full: false, epoch: "e2" });
    expect(mergeLogAnswer(prev, next, NOW).events.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("mergeTraffic", () => {
  it("appends newer hops and keeps a new epoch alone", () => {
    const prev = traffic("m", [hop(1), hop(2)]);
    const merged = mergeTraffic(prev, traffic("m", [hop(2), hop(3)]));
    expect(merged.hops.map((h) => h.seq)).toEqual([1, 2, 3]);
    expect(mergeTraffic(prev, { ...traffic("m", [hop(1)]), epoch: "t2" }).hops).toHaveLength(1);
  });

  it("keeps the last 500", () => {
    const many = Array.from({ length: 500 }, (_, i) => hop(i + 1));
    const merged = mergeTraffic(traffic("m", many), traffic("m", [hop(501)]));
    expect(merged.hops).toHaveLength(500);
    expect(merged.hops[0].seq).toBe(2);
  });
});

describe("buildMessageLogView", () => {
  it("pairs by msgId and shows delivered", () => {
    const view = build([mac([
      send("s1", NOW - 5 * MIN, { msgId: "M1", target: LOCAL_BETA, key: "x" }),
      recv("r1", NOW - 4 * MIN, { msgId: "M1", key: "different" }),
    ])]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ status: "delivered", statusText: "Delivered T-4", route: "local", crossMachine: false });
    expect(view.rows[0].from).toMatchObject({ key: "local:s-alpha", label: "alpha", live: true, project: "a" });
    expect(view.rows[0].to.key).toBe("local:s-beta");
  });

  it("pairs by key within the time limits, nearest wins, at the target", () => {
    const view = build([mac([
      send("s1", NOW - 20 * MIN, { target: LOCAL_BETA }),
      recv("r-before", NOW - 22 * MIN),
      recv("r-far", NOW - 9 * MIN),
      recv("r-near", NOW - 19 * MIN),
      recv("r-other", NOW - 20 * MIN, { sessionId: "s-idle" }),
    ])]);
    const ids = view.rows.map((r) => r.id).sort();
    expect(ids).toEqual(["r-before", "r-far", "r-other", "s1"]);
    expect(view.rows.find((r) => r.id === "s1")?.statusText).toBe("Delivered T-19");
    const own = view.rows.find((r) => r.id === "r-far");
    expect(own).toMatchObject({ status: "delivered", statusText: "Received T-9" });
    expect(own?.from.key).toBe("name:alpha");
  });

  it("does not pair by key when both have different msgIds", () => {
    const view = build([mac([
      send("s1", NOW - 5 * MIN, { msgId: "A" }),
      recv("r1", NOW - 5 * MIN, { msgId: "B" }),
    ])]);
    expect(view.rows).toHaveLength(2);
  });

  it("covers every send status", () => {
    const view = build([mac([
      send("f1", NOW - 50 * MIN, { status: "failed", error: "No session named ghost is running", to: "ghost", key: "k-f1" }),
      send("f2", NOW - 49 * MIN, { status: "failed", key: "k-f2" }),
      send("e1", NOW - 48 * MIN, { status: "expired", key: "k-e1" }),
      send("h1", NOW - 47 * MIN, { status: "held", target: LOCAL_BETA }),
      send("rel", NOW - 46 * MIN, { status: "released", updatedAt: NOW - 40 * MIN, key: "k-rel" }),
      send("p1", NOW - 45 * MIN, { status: "pending", key: "k-p" }),
      send("w-old", NOW - 30 * MIN, { target: LOCAL_BETA, key: "k-w" }),
      send("w-new", NOW - 5 * MIN, { target: LOCAL_BETA, key: "k-w2" }),
      send("w-noplace", NOW - 30 * MIN, { target: { machine: "elsewhere", sessionId: "zz" }, key: "k-n" }),
      send("w-name", NOW - 30 * MIN, { to: "nobody", key: "k-nobody" }),
    ])]);
    const by = Object.fromEntries(view.rows.map((r) => [r.id, r]));
    expect(by.f1).toMatchObject({ status: "failed", statusText: "No session named ghost is running", problem: true });
    expect(by.f1.to.key).toBe("name:ghost");
    expect(by.f2.statusText).toBe("Not sent");
    expect(by.e1).toMatchObject({ status: "expired", statusText: "Held, then not approved in time", problem: true });
    expect(by.h1).toMatchObject({ status: "held", statusText: "Held by beta until someone approves it", problem: false });
    expect(by.rel).toMatchObject({ status: "delivered", statusText: "Approved and delivered T-40" });
    expect(by.p1).toMatchObject({ status: "waiting", statusText: "Sending…", problem: false });
    expect(by["w-old"]).toMatchObject({ status: "waiting", statusText: "Sent T-30; not seen by beta yet", problem: true });
    expect(by["w-new"]).toMatchObject({ problem: false });
    expect(by["w-noplace"]).toMatchObject({ statusText: "Sent T-30; can't tell where it went", problem: false });
    expect(by["w-noplace"].to.key).toBe("?:zz");
    expect(by["w-name"].statusText).toBe("Sent T-30; can't tell where it went");
    expect(view.counts.problems).toBe(4);
  });

  it("does not call it a problem when the target ended or is busy", () => {
    const events = [
      send("gone", NOW - 30 * MIN, { target: { machine: "mac-dev", sessionId: "s-ended" }, to: "old", key: "k-1" }),
      send("busy", NOW - 30 * MIN, { target: { machine: "mac-dev", sessionId: "s-busy" }, to: "worker", key: "k-2" }),
    ];
    const view = build([mac(events, {
      log: log("mac-dev", events, {
        sessions: [{ sessionId: "s-busy", account: "cx", name: "worker", cwd: "/w", project: "w", status: "busy" }],
      }),
    })]);
    const by = Object.fromEntries(view.rows.map((r) => [r.id, r]));
    expect(by.gone).toMatchObject({ status: "waiting", statusText: "Sent T-30; old has ended", problem: false });
    expect(by.busy).toMatchObject({ status: "waiting", statusText: "Sent T-30; worker will see it after this turn", problem: false });
    expect(view.recentProblems).toBe(0);
  });

  it("settles a send whose socket is gone", () => {
    const view = build([mac([
      send("f1", NOW - 5 * MIN, { status: "failed", error: "Failed to send to uds:…: ENOENT: no such file or directory, lstat '…'", key: "k-1" }),
      send("f2", NOW - 5 * MIN, { status: "failed", error: "Refused: that session is not accepting messages", key: "k-2" }),
    ])]);
    const by = Object.fromEntries(view.rows.map((r) => [r.id, r]));
    expect(by.f1).toMatchObject({ status: "failed", statusText: "Not sent: that session has ended", problem: false, settled: true });
    expect(by.f2).toMatchObject({ status: "failed", problem: true });
    expect(view.recentProblems).toBe(1);
  });

  it("settles a failed send only when the same session sends the same text again soon", () => {
    const view = build([mac([
      send("retried", NOW - 20 * MIN, { status: "failed", error: "No agent named old", to: "old", key: "k-1" }),
      send("retry", NOW - 19 * MIN, { status: "sent", to: "new", key: "k-1" }),
      send("other-text", NOW - 20 * MIN, { status: "failed", error: "No agent named old", to: "old", key: "k-2" }),
      send("too-late", NOW - 55 * MIN, { status: "failed", error: "No agent named old", to: "old", key: "k-3" }),
      send("late-retry", NOW - 5 * MIN, { status: "sent", to: "new", key: "k-3" }),
      send("other-session", NOW - 20 * MIN, { status: "failed", error: "No agent named old", to: "old", key: "k-4" }),
      send("not-theirs", NOW - 19 * MIN, { status: "sent", sessionId: "s-beta", to: "new", key: "k-4" }),
      send("fails-too", NOW - 20 * MIN, { status: "failed", error: "No agent named old", to: "old", key: "k-5" }),
      send("fails-again", NOW - 19 * MIN, { status: "failed", error: "No agent named old", to: "old", key: "k-5" }),
    ])]);
    const by = Object.fromEntries(view.rows.map((r) => [r.id, r]));
    expect(by.retried).toMatchObject({
      status: "failed",
      statusText: "No agent named old. Sent again to new at T-19",
      problem: false,
      settled: true,
    });
    for (const id of ["other-text", "too-late", "other-session", "fails-too", "fails-again"]) {
      expect(by[id].problem).toBe(true);
    }
  });

  it("pairs a message a busy session read long after it was sent", () => {
    const view = build([mac([
      send("s1", NOW - 50 * MIN, { key: "k-1" }),
      recv("r1", NOW - 5 * MIN, { key: "k-1" }),
    ])]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ id: "s1", status: "delivered", problem: false });
  });

  it("joins a Mac send through a relay copy with the host's receive, with its trail", () => {
    const target = { machine: "vivobook", sessionId: "v-1", name: "worker", route: "relay" as const, account: "main" as const };
    const sources: SourceInput[] = [
      mac([send("s1", NOW - 20 * MIN, { to: "worker", target, msgId: "M9" })], {
        traffic: traffic("mac-dev", [hop(1, { msgId: "M9", at: NOW - 20 * MIN })]),
      }),
      {
        place: VIVO,
        state: "ok",
        log: log("vivobook", [recv("r1", NOW - 19 * MIN, { sessionId: "v-1", msgId: "M9" })], {
          sessions: [{ sessionId: "v-1", account: "main", name: "worker", cwd: "/w", project: "w" }],
        }),
        traffic: traffic("vivobook", [
          hop(1, { msgId: "M9", direction: "in", peer: "mac-dev", at: NOW - 19 * MIN }),
          hop(2, { msgId: "M9", kind: "receipt", direction: "out", peer: "mac-dev" }),
        ]),
      },
    ];
    const view = build(sources, { mono: [{ id: "mono-7", providerSessionId: "v-1", placeId: "m-vivo" }] });
    expect(view.rows).toHaveLength(1);
    const row = view.rows[0];
    expect(row).toMatchObject({ status: "delivered", route: "relay", crossMachine: true });
    expect(row.to).toMatchObject({ key: "m-vivo:v-1", label: "worker", live: true, openId: "mono-7" });
    expect(row.to.place?.id).toBe("m-vivo");
    expect(row.trail).toEqual(["This Mac → Vivobook T-20", "This Mac → Vivobook T-19"]);
    expect(view.counts.crossMachine).toBe(1);
    expect(view.sources[1].relay).toBe("on");
    expect(view.warning).toBeUndefined();
  });

  it("marks a send dropped by the relay, matched by key and session ids", () => {
    const target = { machine: "vivobook", sessionId: "v-1", route: "relay" as const };
    const view = build([
      mac([send("s1", NOW - 20 * MIN, { target })]),
      {
        place: VIVO,
        state: "ok",
        log: log("vivobook", []),
        traffic: traffic("vivobook", [
          hop(1, { key: "hello", toSessionId: "v-1", fromSessionId: "s-alpha", at: NOW - 19 * MIN, outcome: "dropped", reason: "Not picked up within 45 s", direction: "in", peer: "mac-dev" }),
          hop(2, { key: "hello", toSessionId: "other", at: NOW - 19 * MIN, outcome: "dropped", reason: "x" }),
        ]),
      },
    ]);
    expect(view.rows[0]).toMatchObject({
      status: "dropped",
      statusText: "Lost by the relay on Vivobook: not picked up within 45 s",
      problem: true,
      trail: ["Dropped on Vivobook: not picked up within 45 s"],
    });
  });

  it("says when the target's place can't be checked", () => {
    const target = { machine: "vivobook", sessionId: "v-1", route: "relay" as const };
    const view = build([
      mac([send("s1", NOW - 30 * MIN, { target })]),
      { place: VIVO, state: "offline", log: log("vivobook", [], { scannedAt: NOW - 40 * MIN }) },
    ]);
    expect(view.rows[0]).toMatchObject({ statusText: "Sent T-30; can't see Vivobook to check", problem: false });
    expect(view.sources[1].relay).toBe("absent");
    expect(view.warning).toBe("Can't reach Vivobook. Its messages are from T-40.");
  });

  it("gives an unpaired receive its own row, from its resolved sender", () => {
    const sender = { machine: "vivobook", sessionId: "v-2", name: "clupai", route: "relay" as const };
    const view = build([
      mac([recv("r1", NOW - 3 * MIN, { sender })]),
      { place: VIVO, state: "ok", log: log("vivobook", []), traffic: traffic("vivobook", []) },
    ]);
    expect(view.rows[0]).toMatchObject({ status: "delivered", route: "relay", crossMachine: true, statusText: "Received T-3" });
    expect(view.rows[0].from).toMatchObject({ key: "m-vivo:v-2", label: "clupai", live: false });
    expect(view.rows[0].to.key).toBe("local:s-beta");
  });

  it("leaves an unknown end as unknown", () => {
    const view = build([mac([recv("r1", NOW - MIN, { fromName: undefined, fromAddress: "socket" })])]);
    expect(view.rows[0].from).toMatchObject({ key: "unknown:?", label: "Unknown session" });
    expect(view.graph.unknown.map((n) => n.key)).toEqual(["unknown:?"]);
  });

  it("filters by window, counts recent problems, sorts newest first", () => {
    const events = [
      send("a", NOW - 2 * 3_600_000, { status: "failed", key: "1" }),
      send("b", NOW - 30 * MIN, { status: "failed", key: "2" }),
      send("c", NOW - 10 * MIN, { key: "3", status: "pending" }),
    ];
    const day = build([mac(events)]);
    expect(day.rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(day.recentProblems).toBe(1);
    const hour = build([mac(events)], { window: "1h" });
    expect(hour.rows.map((r) => r.id)).toEqual(["c", "b"]);
    expect(hour.counts).toEqual({ total: 2, problems: 1, crossMachine: 0 });
  });

  it("builds map nodes and edges", () => {
    const view = build([mac([
      send("s1", NOW - 5 * MIN, { target: LOCAL_BETA, key: "1" }),
      send("s2", NOW - 4 * MIN, { target: LOCAL_BETA, key: "2", status: "failed" }),
    ])]);
    const place = view.graph.places[0];
    expect(place.state).toBe("ok");
    expect(place.nodes.map((n) => [n.key, n.sent, n.received, n.problems])).toEqual([
      ["local:s-alpha", 2, 0, 1],
      ["local:s-beta", 0, 2, 1],
      ["local:s-idle", 0, 0, 0],
    ]);
    expect(place.nodes[2].label).toBe("idle");
    expect(view.graph.edges).toEqual([
      { from: "local:s-alpha", to: "local:s-beta", count: 2, problems: 1, lastAt: NOW - 4 * MIN, rowIds: ["s2", "s1"] },
    ]);
  });

  it("warns when the relay is off, or a host needs an update", () => {
    const off = build([
      mac([], { traffic: traffic("mac-dev", [], false) }),
      { place: VIVO, state: "ok", log: log("vivobook", []), traffic: traffic("vivobook", []) },
    ]);
    expect(off.sources[0].relay).toBe("off");
    expect(off.warning).toBe("The relay is off on This Mac, so sessions on this Mac and Vivobook can't message each other through MonoCode.");
    expect(build([mac([], { traffic: traffic("mac-dev", [], false) })]).warning).toBeUndefined();
    expect(build([mac([]), { place: VIVO, state: "old-host" }]).warning).toBe("Vivobook needs a host update to show its messages.");
    expect(build([mac([]), { place: VIVO, state: "offline" }]).warning).toBe("Can't reach Vivobook, so its messages aren't shown.");
  });
});
