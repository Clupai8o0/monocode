import { describe, expect, it } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import { mapCodexNotification } from "../../integrations/harness/providers/codex/codexProtocol";
import { parsePeerMessage, peerMessageText } from "../peerMessages/peerMessage";
import { peerStatsOfBlocks } from "../peerMessages/peerStats";
import { CodexPeerMessages } from "./peerMessages";

describe("Codex peer envelopes", () => {
  it("renders a received envelope once, preserving the sender's provider", () => {
    const message = {
      name: "codex-review",
      harness: "codex" as const,
      body: "Ready for review.",
    };
    const params = {
      item: {
        id: "peer-1",
        type: "userMessage",
        content: [{ type: "text", text: peerMessageText(message) }],
      },
    };
    const peers = new CodexPeerMessages();
    expect(peers.receive("item/started", params)).toBeNull();
    const events = [peers.receive("item/completed", params)!];
    expect(events[0]).not.toBeNull();
    expect(peers.receive("item/completed", params)).toBeNull();
    const session = events.reduce(
      applyHarnessEvent,
      newSession("codex", "/repo"),
    );
    expect(parsePeerMessage(session.blocks.at(-1)!.text)).toMatchObject(
      message,
    );
    expect(peerStatsOfBlocks(session.blocks).incoming).toMatchObject([
      { name: "codex-review", body: "Ready for review." },
    ]);
  });

  it.each(["What does this mean?\n", ""])(
    "does not count a submitted envelope as a received message (%s)",
    (prefix) => {
      const peers = new CodexPeerMessages();
      const text =
        prefix + peerMessageText({ name: "quoted", body: "Example message" });
      peers.startTurn([{ type: "text", text }]);
      const params = {
        item: {
          type: "userMessage",
          id: "echo",
          content: [{ type: "text", text }],
        },
      };
      expect(peers.receive("item/completed", params)).toBeNull();
      peers.startTurn([{ type: "text", text: "Next turn" }]);
      expect(peers.receive("item/completed", params)).toBeNull();
      expect(
        peers.receive("item/completed", {
          item: { ...params.item, id: "injected" },
        }),
      ).not.toBeNull();
    },
  );

  it("also ignores quoted envelopes sent as steering or question answers", () => {
    const peers = new CodexPeerMessages();
    peers.startTurn([{ type: "text", text: "Initial task" }]);
    const text = peerMessageText({ name: "quoted", body: "Steering example" });
    peers.rememberInput([{ type: "text", text }]);
    expect(
      peers.receive("item/completed", {
        item: {
          type: "userMessage",
          id: "steer-echo",
          content: [{ type: "text", text }],
        },
      }),
    ).toBeNull();
  });

  it("does not duplicate normal user messages or treat assistant quotes as received messages", () => {
    expect(
      mapCodexNotification("item/completed", {
        item: {
          id: "u",
          type: "userMessage",
          content: [{ type: "text", text: "Continue." }],
        },
      }).events,
    ).toEqual([]);
    const events = mapCodexNotification("item/completed", {
      item: {
        id: "a",
        type: "agentMessage",
        text: peerMessageText({ name: "quoted", body: "example" }),
      },
    }).events;
    expect(events.some((event) => event.type === "interjection")).toBe(false);
  });

  it.each([
    {
      content: [
        { type: "text", text: '{"success":true,"pin":{"name":"claude-08"}}' },
      ],
    },
    { structuredContent: { success: true, pin: { name: "claude-08" } } },
  ])("counts a completed MCP SendMessage receipt", (result) => {
    const item = {
      id: "send",
      type: "mcpToolCall",
      server: "sessions",
      tool: "SendMessage",
      status: "completed",
      arguments: {},
      result,
    };
    const events = mapCodexNotification("item/completed", { item }).events;
    const session = events.reduce(
      applyHarnessEvent,
      newSession("codex", "/repo"),
    );
    expect(peerStatsOfBlocks(session.blocks).outgoing).toEqual(["claude-08"]);
  });

  it("does not count a failed MCP receipt or native subagent send_message", () => {
    for (const item of [
      {
        tool: "SendMessage",
        result: { isError: true, content: [{ type: "text", text: "failed" }] },
      },
      { tool: "send_message", result: { success: true } },
    ]) {
      const events = mapCodexNotification("item/completed", {
        item: {
          id: "send",
          type: "mcpToolCall",
          server: "sessions",
          status: "completed",
          ...item,
        },
      }).events;
      const session = events.reduce(
        applyHarnessEvent,
        newSession("codex", "/repo"),
      );
      expect(peerStatsOfBlocks(session.blocks).outgoing).toEqual([]);
    }
  });

  it("does not retain unrelated MCP payloads, which may contain large media", () => {
    const events = mapCodexNotification("item/completed", {
      item: {
        id: "image",
        type: "mcpToolCall",
        server: "images",
        tool: "generate",
        status: "completed",
        result: { content: [{ type: "image", data: "base64" }] },
      },
    }).events;
    expect(events[0]).not.toHaveProperty("detail");
  });
});
