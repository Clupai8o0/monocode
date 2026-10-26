import {
  parsePeerMessage,
  type PeerMessage,
} from "../peerMessages/peerMessage";
import { peerInterjection } from "../peerMessages/peerTranscript";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function envelopeKey(message: PeerMessage): string {
  // Arrival timestamps are not message identity and may be added by a bridge.
  return JSON.stringify([
    message.name,
    message.from,
    message.mode,
    message.harness,
    message.body,
  ]);
}

/** Distinguishes injected envelopes from Codex's echoes of our user inputs. */
export class CodexPeerMessages {
  private submitted = new Set<string>();
  private receivedIds = new Set<string>();

  startTurn(input: unknown): void {
    this.submitted.clear();
    this.rememberInput(input);
  }

  endTurn(): void {
    this.submitted.clear();
  }

  rememberInput(input: unknown): void {
    if (!Array.isArray(input)) return;
    for (const part of input) {
      const item = record(part);
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      const message = parsePeerMessage(item.text);
      if (message) this.submitted.add(envelopeKey(message));
    }
  }

  receive(
    method: string,
    params: unknown,
  ): ReturnType<typeof peerInterjection> {
    if (method !== "item/completed") return null;
    const item = record(record(params)?.item);
    if (item?.type !== "userMessage" || typeof item.id !== "string" || !item.id)
      return null;
    if (this.receivedIds.has(item.id)) return null;
    const peer = peerInterjection({
      origin: item.origin,
      message: { content: item.content },
    });
    if (!peer) return null;
    this.receivedIds.add(item.id);
    if (this.receivedIds.size > 1024) {
      this.receivedIds.delete(this.receivedIds.values().next().value!);
    }
    const message = parsePeerMessage(peer.text)!;
    // A structured peer origin distinguishes a real injected delivery even
    // when its body happens to be the same example the user submitted.
    if (
      record(item.origin)?.kind !== "peer" &&
      this.submitted.has(envelopeKey(message))
    )
      return null;
    return peer;
  }
}
