import { describe, expect, it } from "vitest";
import { DeliveryQueue } from "./relay-core";
import { describeLine, RelayTraffic } from "./relay-traffic";
import { TRAFFIC_MAX } from "../src/fork/messageLog/messageLogProtocol";

const line = (body: string, id = "m-1") =>
  JSON.stringify({
    type: "user",
    msg_id: id,
    from: "uds:/tmp/cc-socks/1.sock",
    message: {
      role: "user",
      content: `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-session="s-1" from-name="alpha">\n${body}\n</cross-session-message>`,
    },
  });

describe("relay traffic recorder", () => {
  it("describes messages and receipts with the transcript key", () => {
    expect(describeLine(line("  Please   review\nuds:/tmp/cc-socks/9.sock now "))).toEqual({
      kind: "message",
      fromName: "alpha",
      fromSessionId: "s-1",
      msgId: "m-1",
      key: "Please review uds:… now",
    });
    expect(describeLine(JSON.stringify({ type: "control", action: "peer_message_status", orig_msg_id: "m-2" }))).toEqual({
      kind: "receipt",
      msgId: "m-2",
    });
    expect(describeLine("not json")).toBeNull();
    expect(describeLine(JSON.stringify({ type: "auth", token: "t" }))).toBeNull();
  });

  it("keeps the newest hops in order and answers since a cursor", () => {
    let clock = 5;
    const traffic = new RelayTraffic(() => clock);
    for (let index = 0; index < TRAFFIC_MAX + 3; index++) {
      clock++;
      traffic.recordLine(line(`n${index}`), { peer: "mac", direction: "out", outcome: "passed" });
    }
    const all = traffic.answer(undefined, "vivobook", true);
    expect(all.hops).toHaveLength(TRAFFIC_MAX);
    expect(all.hops[0].seq).toBe(4);
    expect(all.cursor).toBe(TRAFFIC_MAX + 3);
    expect(new Set(all.hops.map((hop) => hop.id)).size).toBe(TRAFFIC_MAX);
    traffic.record({ peer: "mac", direction: "in", kind: "message", outcome: "dropped", reason: "lstat '/tmp/x.sock' failed" });
    const after = traffic.answer({ since: { epoch: all.epoch, cursor: all.cursor } }, "vivobook", false);
    expect(after.enabled).toBe(false);
    expect(after.hops).toHaveLength(1);
    expect(after.hops[0].reason).toBe("lstat '…' failed");
    expect(traffic.answer({ since: { epoch: "x", cursor: 999 } }, "v", true).hops).toHaveLength(TRAFFIC_MAX);
    expect(new RelayTraffic().answer(undefined, "v", true).cursor).toBe(0);
  });

  it("is told once when a queued line is handed on or dropped", () => {
    let clock = 0;
    let seq = 0;
    const told: Array<[string, string | undefined]> = [];
    const queue = new DeliveryQueue(
      () => clock,
      { next: () => ++seq, current: () => seq },
      (delivery, drop) => told.push([delivery.line, drop]),
    );
    queue.push({ to: "a", fromPid: 1, line: "one" });
    queue.take(0);
    queue.take(0);
    queue.push({ to: "a", fromPid: 1, line: "two" });
    clock = 46_000;
    queue.take(1);
    queue.push({ to: "a", fromPid: 1, line: "three" });
    queue.clear();
    for (let index = 0; index < 501; index++) queue.push({ to: "a", fromPid: 1, line: `x${index}` });
    expect(told).toEqual([
      ["one", undefined],
      ["two", "expired"],
      ["three", "cleared"],
      ["x0", "full"],
    ]);
  });
});
