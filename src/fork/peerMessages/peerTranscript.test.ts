// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Block } from "../../features/sessions/model/session";
import { AgentTranscript } from "../../features/sessions/ui/AgentTranscript";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import { parsePeerMessage } from "./peerMessage";
import { isPeerBlock, peerInterjection } from "./peerTranscript";

const emitted = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("@tauri-apps/api/event", async (load) => ({
  ...(await load<typeof import("@tauri-apps/api/event")>()),
  emit: async (event: string, payload: unknown) => {
    emitted.push([event, payload]);
  },
}));
vi.mock("../../integrations/harness/core/child", async (load) => ({
  ...(await load<typeof import("../../integrations/harness/core/child")>()),
  sessionIdForPid: (pid: number) => (pid === 88142 ? "s-panoptic" : undefined),
}));

const PEER_TEXT = `Another Claude session sent a message:
<cross-session-message from="uds:/tmp/cc-socks/88142.sock" from-name="panoptic-8c" from-mode="bypass">
Laptop is plugged in. Resume.
</cross-session-message>

This came from another Claude session — not typed by your user.`;

const PEER_RECORD = {
  type: "user",
  isMeta: true,
  origin: {
    kind: "peer",
    from: "uds:/tmp/cc-socks/88142.sock",
    name: "panoptic-8c",
    fromMode: "bypass",
    body: "Laptop is plugged in. Resume.",
  },
  message: { role: "user", content: [{ type: "text", text: PEER_TEXT }] },
};

describe("peerInterjection", () => {
  it("turns a cross-session entry into a peer transcript item", () => {
    const event = peerInterjection(PEER_RECORD, 1_000);
    expect(event).toMatchObject({
      type: "interjection",
      customType: "peer-message",
    });
    expect(parsePeerMessage(event!.text)).toEqual({
      name: "panoptic-8c",
      from: "uds:/tmp/cc-socks/88142.sock",
      mode: "bypass",
      at: 1_000,
      body: "Laptop is plugged in. Resume.",
    });
    // Claude Code's note to the model is not kept.
    expect(event!.text).not.toContain("not typed by your user");
    const session = applyHarnessEvent(newSession("claude", "/repo"), event!);
    const block = session.blocks.at(-1)!;
    expect(block.role).toBe("system");
    expect(isPeerBlock(block)).toBe(true);
  });

  it("reads the tag when the record has no peer origin", () => {
    const event = peerInterjection({
      type: "user",
      message: { role: "user", content: PEER_TEXT },
    });
    expect(parsePeerMessage(event!.text)?.name).toBe("panoptic-8c");
  });

  it("leaves tool results and ordinary user entries alone", () => {
    expect(
      peerInterjection({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          ],
        },
      }),
    ).toBeNull();
    expect(
      peerInterjection({
        type: "user",
        message: { role: "user", content: "just text" },
      }),
    ).toBeNull();
  });
});

describe("transcript", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    emitted.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function peerBlock(from: string): Block {
    const event = peerInterjection({
      ...PEER_RECORD,
      origin: { ...PEER_RECORD.origin, from },
    })!;
    return applyHarnessEvent(newSession("claude", "/repo"), event).blocks.at(
      -1,
    )!;
  }

  function render(blocks: Block[]) {
    act(() => root.render(createElement(AgentTranscript, { blocks })));
  }

  it("renders the peer card and opens a session MonoCode runs", () => {
    render([
      { id: "u", role: "user", text: "start previews" },
      { id: "a", role: "assistant", text: "On it." },
      peerBlock("uds:/tmp/cc-socks/88142.sock"),
    ]);
    const card = container.querySelector('[data-peer-message="panoptic-8c"]');
    expect(card?.textContent).toContain("Laptop is plugged in. Resume.");
    const open = card!.querySelector<HTMLButtonElement>(
      '[aria-label="Open session panoptic-8c"]',
    )!;
    act(() => open.click());
    expect(emitted).toEqual([["monocode:notification-click", "s-panoptic"]]);
  });

  it("hides Open session for a sender MonoCode does not run", () => {
    render([
      { id: "u", role: "user", text: "start previews" },
      peerBlock("uds:/tmp/cc-socks/5.sock"),
    ]);
    const card = container.querySelector("[data-peer-message]");
    expect(card).not.toBeNull();
    expect(card!.querySelector("button")).toBeNull();
  });
});
