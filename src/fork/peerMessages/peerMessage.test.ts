// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerMessageCard } from "./PeerMessageCard";
import { parsePeerMessage } from "./peerMessage";

const RAW = `Another Claude session sent a message:
<cross-session-message from="uds:/tmp/cc-socks/88142.sock" from-name="panoptic-8c" from-mode="bypass">
Sam: laptop is plugged in.
Resume your work.
</cross-session-message>

This came from another Claude session — not typed by your user.`;

describe("parsePeerMessage", () => {
  it("reads the sender and keeps only the body", () => {
    expect(parsePeerMessage(RAW)).toEqual({
      name: "panoptic-8c",
      from: "uds:/tmp/cc-socks/88142.sock",
      mode: "bypass",
      body: "Sam: laptop is plugged in.\nResume your work.",
    });
  });

  it("falls back to the sender's pid without a name", () => {
    const message = parsePeerMessage(
      '<cross-session-message from="uds:/tmp/cc-socks/42.sock">hi</cross-session-message>',
    );
    expect(message?.name).toBe("pid 42");
    expect(message?.body).toBe("hi");
  });

  it("ignores ordinary text", () => {
    expect(parsePeerMessage("just a user message")).toBeNull();
  });
});

describe("PeerMessageCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the sender, the body and a labelled open button", () => {
    const onOpen = vi.fn();
    const message = parsePeerMessage(RAW)!;
    act(() =>
      root.render(
        createElement(PeerMessageCard, { message, at: Date.now(), onOpen }),
      ),
    );
    const card = container.querySelector("[data-peer-message]")!;
    expect(card.getAttribute("aria-label")).toBe("Message from panoptic-8c");
    expect(card.textContent).toContain("from another session");
    expect(card.textContent).toContain("Resume your work.");
    expect(card.textContent).not.toContain("not typed by your user");
    expect(card.hasAttribute("data-urgent")).toBe(false);
    const open = card.querySelector("button")!;
    expect(open.getAttribute("aria-label")).toBe("Open session panoptic-8c");
    act(() => open.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("hides the open button without a handler and marks urgent ones", () => {
    act(() =>
      root.render(
        createElement(PeerMessageCard, {
          message: { name: "panoptic-8c", body: "Battery at 10%." },
          urgent: true,
        }),
      ),
    );
    const card = container.querySelector("[data-peer-message]")!;
    expect(card.querySelector("button")).toBeNull();
    expect(card.getAttribute("data-urgent")).toBe("true");
    expect(card.textContent).toContain("Urgent");
  });
});
