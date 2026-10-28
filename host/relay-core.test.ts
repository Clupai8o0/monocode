import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanMachine,
  cleanSession,
  cleanSockDir,
  DeliveryQueue,
  LINE_MAX,
  PidTable,
  probePid,
  proxyPid,
  QUEUE_MAX,
  QUEUE_TTL_MS,
  readFrame,
  relayName,
  rewriteLine,
} from "./relay-core";

const SESSION = "3796fb8b-10c2-4f00-9d1e-0123456789ab";

function userLine(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    msgV: 1,
    msg_id: "m-1",
    type: "user",
    message: {
      role: "user",
      content:
        '<cross-session-message from="uds:/run/user/1000/cc-socks/88.sock" from-session="s-1" hop-chain="a" from-name="vivo-work" from-mode="bypass">\nhello\n</cross-session-message>\nNote to the model.',
    },
    priority: "next",
    from: "uds:/run/user/1000/cc-socks/88.sock",
    session_id: "target-session",
    file_attachments: [{ path: "/etc/passwd" }],
    ...extra,
  });
}

describe("proxyPid", () => {
  it("follows the contract's formula", () => {
    const digest = createHash("sha256").update(`host\n${SESSION}`).digest();
    expect(proxyPid("host", SESSION)).toBe(1e9 + (digest.readUInt32BE(0) % 1e9));
    expect(proxyPid("host", SESSION)).toBeGreaterThanOrEqual(1e9);
    expect(proxyPid("host", SESSION)).toBeLessThan(2e9);
    expect(proxyPid("dev-1", SESSION)).not.toBe(proxyPid("host", SESSION));
  });

  it("probes forward and wraps inside the range", () => {
    expect(probePid(1_500_000_000, () => false)).toBe(1_500_000_000);
    const taken = new Set([1_500_000_000, 1_500_000_001]);
    expect(probePid(1_500_000_000, (pid) => taken.has(pid))).toBe(1_500_000_002);
    expect(probePid(1_999_999_999, (pid) => pid === 1_999_999_999)).toBe(1_000_000_000);
  });

  it("keeps a session's pid and probes past a collision on one target", () => {
    const table = new PidTable(() => 1_999_999_999);
    expect(table.pid("host", SESSION)).toBe(1_999_999_999);
    expect(table.pid("host", SESSION)).toBe(1_999_999_999);
    expect(table.pid("dev", SESSION)).toBe(1_000_000_000);
    expect(table.pid("dev", "other-session")).toBe(1_000_000_001);
    expect(table.lookup(1_000_000_000)).toEqual({ sourceKey: "dev", sessionId: SESSION });
    table.retain((source) => source !== "host");
    expect(table.lookup(1_999_999_999)).toBeUndefined();
    expect(table.size).toBe(2);
    // A freed pid is the first one a newcomer probes into.
    expect(table.pid("new", "new-session")).toBe(1_999_999_999);
    // Real tables start from the formula.
    expect(new PidTable().pid("host", SESSION)).toBe(proxyPid("host", SESSION));
  });
});

describe("names and checks", () => {
  it("derives names", () => {
    expect(relayName("panoptic-8c", "/x/panoptic")).toBe("panoptic-8c");
    expect(relayName("@lead*", "/x/proj")).toBe("lead");
    expect(relayName("", "/x/proj")).toBe("proj");
    expect(relayName(undefined, "/x/proj")).toBe("proj");
    expect(relayName("uds:/tmp/cc-socks/1.sock", "/x/proj")).toBe("proj");
    expect(relayName("a/b", "/x/proj")).toBe("proj");
    expect(relayName("Main", "/x/proj")).toBe("proj");
    expect(relayName("team-lead", "/x/proj")).toBe("proj");
    expect(relayName("user", "/")).toBe("session");
    expect(relayName("line\nbreak\u0000", "/x")).toBe("linebreak");
    expect(relayName("x".repeat(200), "/x")).toHaveLength(64);
  });

  it("cleans what a peer sends", () => {
    expect(cleanSession({ sessionId: SESSION, account: ".claude-exec", name: "@w", cwd: "/Users/s/p" })).toEqual({
      sessionId: SESSION,
      account: ".claude-exec",
      name: "w",
      cwd: "/Users/s/p",
      kind: "interactive",
    });
    expect(
      cleanSession({
        sessionId: SESSION,
        account: "../../etc",
        name: "n",
        cwd: "/p",
        kind: "evil",
        status: "busy",
        bridgeSessionId: "session_01AbC",
        version: "2.1.312",
      }),
    ).toEqual({
      sessionId: SESSION,
      account: ".claude",
      name: "n",
      cwd: "/p",
      kind: "interactive",
      status: "busy",
      bridgeSessionId: "session_01AbC",
      version: "2.1.312",
    });
    const dropped = cleanSession({
      sessionId: SESSION,
      cwd: "/p",
      status: "Busy Now",
      bridgeSessionId: "a b",
      version: "1\n2",
    });
    expect(dropped).not.toHaveProperty("status");
    expect(dropped).not.toHaveProperty("bridgeSessionId");
    expect(dropped).not.toHaveProperty("version");
    expect(cleanSession({ sessionId: "short", cwd: "/p" })).toBeNull();
    expect(cleanSession({ sessionId: "../../etc/x", cwd: "/p" })).toBeNull();
    expect(cleanSession({ sessionId: SESSION, cwd: "/p\nq" })).toBeNull();
    expect(cleanSession({ sessionId: SESSION, cwd: "/p\u0000" })).toBeNull();
    expect(cleanSession({ sessionId: SESSION, cwd: "/" + "a".repeat(2000) })).toBeNull();
    expect(cleanSession({ sessionId: SESSION })).toBeNull();
    expect(cleanSession(null)).toBeNull();
  });

  it("cleans machine names and socket folders", () => {
    expect(cleanMachine("Sam's MacBook Pro", "x")).toBe("Sam-s-MacBook-Pro");
    expect(cleanMachine("", "x")).toBe("x");
    expect(cleanMachine(5, "x")).toBe("x");
    expect(cleanSockDir("/tmp/cc-socks/")).toBe("/tmp/cc-socks");
    expect(cleanSockDir("/run/user/1000/cc-socks")).toBe("/run/user/1000/cc-socks");
    expect(cleanSockDir("tmp/cc-socks")).toBeNull();
    expect(cleanSockDir("/tmp/../etc")).toBeNull();
    expect(cleanSockDir("/tmp/cc socks")).toBeNull();
    expect(cleanSockDir("/" + "a".repeat(90))).toBeNull();
    expect(cleanSockDir(undefined)).toBeNull();
  });
});

describe("rewriting", () => {
  it("points the sender at the proxy and drops what must not cross", () => {
    const out = JSON.parse(rewriteLine(userLine(), "/tmp/cc-socks/1234567890.sock")!);
    expect(out.from).toBe("uds:/tmp/cc-socks/1234567890.sock");
    expect(out.message.content).toContain('<cross-session-message from="uds:/tmp/cc-socks/1234567890.sock" from-session="s-1" hop-chain="a" from-name="vivo-work" from-mode="bypass">');
    expect(out.message.content).toContain("\nhello\n</cross-session-message>\nNote to the model.");
    expect(out).not.toHaveProperty("session_id");
    expect(out).not.toHaveProperty("file_attachments");
    expect(out.msg_id).toBe("m-1");
    expect(out.priority).toBe("next");
  });

  it("adds from to a wrapper without one", () => {
    const line = userLine({
      message: { role: "user", content: '<cross-session-message from-name="n">\nhi\n</cross-session-message>' },
    });
    const out = JSON.parse(rewriteLine(line, "/s/1.sock")!);
    expect(out.message.content.startsWith('<cross-session-message from="uds:/s/1.sock" from-name="n">')).toBe(true);
  });

  it("passes receipts and drops everything else", () => {
    const receipt = JSON.stringify({
      type: "control",
      action: "peer_message_status",
      status: "delivered",
      from: "uds:/a/1.sock",
      orig_msg_id: "m-1",
      session_id: "x",
    });
    const out = JSON.parse(rewriteLine(receipt, "/b/2.sock")!);
    expect(out).toMatchObject({ from: "uds:/b/2.sock", orig_msg_id: "m-1", status: "delivered" });
    expect(out).not.toHaveProperty("session_id");
    expect(rewriteLine(JSON.stringify({ type: "auth", token: "t" }), "/b/2.sock")).toBeNull();
    expect(rewriteLine(JSON.stringify({ type: "control", action: "shutdown" }), "/b")).toBeNull();
    expect(rewriteLine(JSON.stringify({ type: "user", message: { role: "user", content: "plain" } }), "/b")).toBeNull();
    expect(
      rewriteLine(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text" }] } }), "/b"),
    ).toBeNull();
    expect(rewriteLine(JSON.stringify({ type: "assistant" }), "/b")).toBeNull();
    expect(rewriteLine("not json", "/b")).toBeNull();
    expect(rewriteLine("[1]", "/b")).toBeNull();
    expect(readFrame(userLine({ pad: "x".repeat(LINE_MAX) }))).toBeNull();
  });
});

describe("DeliveryQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function queue(start = 100) {
    let clock = 1_000;
    let seq = start;
    const q = new DeliveryQueue(() => clock, { next: () => ++seq, current: () => seq });
    return { q, tick: (ms: number) => (clock += ms) };
  }

  const delivery = (n: number) => ({ to: SESSION, fromPid: 1_000_000_000 + n, line: `l${n}` });

  it("answers past the cursor and forgets what was taken", () => {
    const { q } = queue();
    q.push(delivery(1));
    q.push(delivery(2));
    const first = q.take(0);
    expect(first.deliveries.map((d) => d.line)).toEqual(["l1", "l2"]);
    expect(first.cursor).toBe(102);
    q.push(delivery(3));
    expect(q.take(first.cursor).deliveries.map((d) => d.line)).toEqual(["l3"]);
    expect(q.size).toBe(1);
    // A cursor ahead of this run (the host restarted) starts over.
    expect(q.take(10_000).deliveries.map((d) => d.line)).toEqual(["l3"]);
  });

  it("keeps the newest 500 for 45 s", () => {
    const { q, tick } = queue();
    for (let n = 0; n < QUEUE_MAX + 20; n++) q.push(delivery(n));
    const all = q.take(0).deliveries;
    expect(all).toHaveLength(QUEUE_MAX);
    expect(all[0].line).toBe("l20");
    tick(QUEUE_TTL_MS + 1);
    expect(q.take(0).deliveries).toEqual([]);
  });

  it("wakes a waiting next on push and on wake", async () => {
    const { q } = queue();
    const waiting = q.next(0, 20_000);
    setTimeout(() => q.push(delivery(9)), 20);
    const answer = await waiting;
    expect(answer.deliveries.map((d) => d.line)).toEqual(["l9"]);
    const empty = q.next(answer.cursor, 20_000);
    setTimeout(() => q.wake(), 20);
    expect((await empty).deliveries).toEqual([]);
  });

  it("answers an empty next once waitMs passes", async () => {
    vi.useFakeTimers();
    const { q } = queue();
    const waiting = q.next(0, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await waiting).toEqual({ cursor: 100, deliveries: [] });
  });
});
