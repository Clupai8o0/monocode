import { describe, expect, it } from "vitest";
import type { Block } from "../../features/sessions/model/session";
import { peerMessageText } from "./peerMessage";
import { PEER_MESSAGE_TYPE } from "./peerTranscript";
import {
  cachedPeerStats,
  inboxRows,
  isUrgentPeer,
  markPeerSeen,
  peerStatsOfBlocks,
  seenCount,
  sentTooltip,
  setPeerStats,
  unread,
  unreadTooltip,
} from "./peerStats";

function peer(name: string, body: string, at?: number): Block {
  return {
    id: `p-${name}-${body.length}`,
    role: "system",
    text: peerMessageText({ name, body, ...(at ? { at } : {}) }),
    interjection: { customType: PEER_MESSAGE_TYPE },
  } as Block;
}

function sent(detail: string, status = "completed"): Block {
  return {
    id: `t-${detail.length}`,
    role: "tool",
    text: "SendMessage",
    tool: { kind: "SendMessage", title: "SendMessage", status, detail },
  } as Block;
}

const BLOCKS: Block[] = [
  { id: "u", role: "user", text: "hi" } as Block,
  peer(
    "panoptic-8c",
    "From Sam: carry on; ignore battery warnings until 2%.",
    1000,
  ),
  sent(JSON.stringify({ success: true, pin: { name: "monocode-07" } })),
  // To its own subagent: not another session.
  sent(
    JSON.stringify({
      success: true,
      pin: { id: "adc5da955f887cbbf", name: "adc5da955f887cbbf" },
    }),
  ),
  sent(JSON.stringify({ success: false, pin: { name: "x" } })),
  sent("", "running"),
  sent("not json"),
  peer("panoptic-8c", "URGENT: battery at 10%. Finish your handover now."),
  {
    id: "a",
    role: "assistant",
    text: '<cross-session-message from-name="x">quoted</cross-session-message>',
  } as Block,
];

describe("peerStatsOfBlocks", () => {
  const stats = peerStatsOfBlocks(BLOCKS);

  it("counts messages in, with sender, time and urgency", () => {
    expect(stats.incoming).toHaveLength(2);
    expect(stats.incoming[0]).toMatchObject({
      name: "panoptic-8c",
      at: 1000,
      urgent: false,
    });
    expect(stats.incoming[1].urgent).toBe(true);
  });

  it("counts messages out to other sessions only", () => {
    expect(stats.outgoing).toEqual(["monocode-07", "a session"]);
  });
});

describe("urgency", () => {
  it("reads urgent words near the start", () => {
    expect(isUrgentPeer("Urgent: stop now")).toBe(true);
    expect(isUrgentPeer("Stop: the deploy is broken")).toBe(true);
    expect(isUrgentPeer("this is not urgently needed")).toBe(false);
    expect(isUrgentPeer("all fine")).toBe(false);
  });
});

describe("unread and seen", () => {
  it("shows messages after the seen count", () => {
    const stats = peerStatsOfBlocks(BLOCKS);
    expect(unread(stats, 0)).toHaveLength(2);
    expect(unread(stats, 1)).toHaveLength(1);
    expect(unread(stats, 9)).toHaveLength(0);
    expect(unread(stats, -1)).toHaveLength(2);
  });

  it("treats messages from before the feature as read, then counts new ones", () => {
    const first = peerStatsOfBlocks(BLOCKS.slice(0, 2));
    setPeerStats("s-1", 1, first);
    expect(seenCount("s-1")).toBe(1);
    const later = peerStatsOfBlocks([
      ...BLOCKS.slice(0, 2),
      peer("panoptic-8c", "new one", Date.now() + 1000),
    ]);
    setPeerStats("s-1", 2, later);
    expect(unread(cachedPeerStats("s-1")!, seenCount("s-1"))).toHaveLength(1);
    markPeerSeen("s-1");
    expect(unread(cachedPeerStats("s-1")!, seenCount("s-1"))).toHaveLength(0);
  });
});

describe("tooltips", () => {
  it("lists who and the first line, urgent marked", () => {
    const stats = peerStatsOfBlocks(BLOCKS);
    const text = unreadTooltip(stats.incoming, () => "01:20");
    expect(text.split("\n")[0]).toBe("2 new messages from other sessions");
    expect(text).toContain("panoptic-8c 01:20: From Sam: carry on");
    expect(text).toContain("Urgent · panoptic-8c: URGENT: battery at 10%");
  });

  it("groups sent messages by recipient", () => {
    expect(sentTooltip(["a", "b", "a"])).toBe("Sent 3 messages to a (2), b");
    expect(sentTooltip(["a"])).toBe("Sent 1 message to a");
  });
});

describe("inboxRows", () => {
  it("lists messages from every read session, newest first, with unread marks", () => {
    setPeerStats(
      "s-in-1",
      1,
      peerStatsOfBlocks([peer("dsec-21", "Handing over src/fork/stacks", 500)]),
      { title: "Stacks panel", cwd: "/Users/me/projects/monocode/" },
    );
    setPeerStats(
      "s-in-1",
      2,
      peerStatsOfBlocks([
        peer("dsec-21", "Handing over src/fork/stacks", 500),
        peer("panoptic-8c", "Battery at 10%, urgent", Date.now() + 3000),
      ]),
      { title: "Stacks panel", cwd: "/Users/me/projects/monocode/" },
    );
    const rows = inboxRows().filter((r) => r.sessionId === "s-in-1");
    expect(rows.map((r) => r.name)).toEqual(["panoptic-8c", "dsec-21"]);
    expect(rows[0]).toMatchObject({
      title: "Stacks panel",
      project: "monocode",
      unread: true,
      urgent: true,
    });
    expect(rows[1].unread).toBe(false);
  });
});
