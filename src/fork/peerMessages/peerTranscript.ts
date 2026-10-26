import type { Block } from "../../features/sessions/model/session";
import type { HarnessEvent } from "../../integrations/harness/core/types";
import {
  parsePeerMessage,
  peerMessageText,
  type PeerMessage,
} from "./peerMessage";

/** `interjection.customType` of a transcript item holding a peer message. */
export const PEER_MESSAGE_TYPE = "peer-message";

type PeerInterjection = Extract<HarnessEvent, { type: "interjection" }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The plain text of a Claude stream `user` record's message. */
function userText(rec: Record<string, unknown>): string {
  const content = record(rec.message)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === "text" ? (text(item.text) ?? "") : "";
    })
    .join("\n");
}

/**
 * A Claude stream `user` record that carries a message from another Claude
 * Code session, as a transcript item; null for anything else, so tool results
 * and ordinary turns go on as before. Claude Code marks these with
 * `origin.kind: "peer"` and wraps the text in `<cross-session-message>`.
 */
export function peerInterjection(
  rec: Record<string, unknown>,
  now = Date.now(),
): PeerInterjection | null {
  const origin = record(rec.origin);
  const fromOrigin = origin?.kind === "peer";
  const raw = userText(rec);
  if (!fromOrigin && !raw.includes("<cross-session-message")) {
    return null;
  }
  const parsed = parsePeerMessage(raw);
  const body = (fromOrigin ? text(origin?.body) : undefined) ?? parsed?.body;
  if (!body) {
    return null;
  }
  const from = (fromOrigin ? text(origin?.from) : undefined) ?? parsed?.from;
  const mode =
    (fromOrigin ? text(origin?.fromMode) : undefined) ?? parsed?.mode;
  const message: PeerMessage = {
    name:
      (fromOrigin ? text(origin?.name) : undefined) ??
      parsed?.name ??
      "Session",
    ...(from ? { from } : {}),
    ...(mode ? { mode } : {}),
    ...(parsed?.harness ? { harness: parsed.harness } : {}),
    at: now,
    body: body.trim(),
  };
  return {
    type: "interjection",
    customType: PEER_MESSAGE_TYPE,
    text: peerMessageText(message),
  };
}

/** True for the transcript item `peerInterjection` produced. */
export function isPeerBlock(block: Block): boolean {
  return block.interjection?.customType === PEER_MESSAGE_TYPE;
}
