/**
 * Fork feature: what the session relay did with each line it carried (host
 * side), for `relay.traffic`. Shapes are in
 * src/fork/messageLog/messageLogProtocol.ts. Kept in memory only, the
 * newest TRAFFIC_MAX hops; no socket path, pid or token is recorded.
 */
import { randomUUID } from "node:crypto";
import {
  TRAFFIC_MAX,
  type RelayHop,
  type RelayTrafficAnswer,
  type RelayTrafficParams,
} from "../src/fork/messageLog/messageLogProtocol";
import { keyOf, scrub } from "./messages";

const WRAPPER = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/;

export type HopInput = Omit<RelayHop, "id" | "seq" | "at">;

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\t\\n\\x0B\\x0C\\r ])${name}="([^"]*)"`).exec(attrs);
  return match ? match[1] : undefined;
}

/** What a relayed line says about itself: kind, names, ids and key. Null
 *  for a line that is not a message or a receipt. */
export function describeLine(
  line: string,
): Pick<RelayHop, "kind" | "fromName" | "fromSessionId" | "msgId" | "key"> | null {
  let frame: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    frame = parsed;
  } catch {
    return null;
  }
  if (frame.type === "control") {
    const msgId = typeof frame.orig_msg_id === "string" ? frame.orig_msg_id : undefined;
    return { kind: "receipt", ...(msgId ? { msgId } : {}) };
  }
  if (frame.type !== "user") return null;
  const message = frame.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  const wrapper = WRAPPER.exec(content);
  const attrs = wrapper?.[1] ?? "";
  const fromName = attr(attrs, "from-name");
  const fromSessionId = attr(attrs, "from-session");
  const msgId = typeof frame.msg_id === "string" ? frame.msg_id : undefined;
  return {
    kind: "message",
    ...(fromName ? { fromName: scrub(fromName) } : {}),
    ...(fromSessionId ? { fromSessionId } : {}),
    ...(msgId ? { msgId } : {}),
    ...(wrapper ? { key: keyOf(wrapper[2]) } : {}),
  };
}

export class RelayTraffic {
  readonly epoch = randomUUID();
  private hops: RelayHop[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  record(hop: HopInput): RelayHop {
    const seq = ++this.seq;
    const kept: RelayHop = {
      id: `${this.epoch.slice(0, 8)}-${seq}`,
      seq,
      at: this.now(),
      ...hop,
      ...(hop.reason ? { reason: scrub(hop.reason) } : {}),
    };
    this.hops.push(kept);
    if (this.hops.length > TRAFFIC_MAX) this.hops.splice(0, this.hops.length - TRAFFIC_MAX);
    return kept;
  }

  /** Records a relayed line; a line that is not a message or receipt is left out. */
  recordLine(
    line: string,
    hop: Omit<HopInput, "kind" | "fromName" | "fromSessionId" | "msgId" | "key">,
  ): RelayHop | null {
    const described = describeLine(line);
    if (!described) return null;
    return this.record({ ...hop, ...described });
  }

  answer(params: RelayTrafficParams | undefined, machine: string, enabled: boolean): RelayTrafficAnswer {
    const since = params?.since;
    const cursor =
      since && since.epoch === this.epoch && typeof since.cursor === "number" ? since.cursor : 0;
    return {
      version: 1,
      machine,
      epoch: this.epoch,
      cursor: this.seq,
      enabled,
      hops: this.hops.filter((hop) => hop.seq > cursor).map((hop) => ({ ...hop })),
    };
  }
}
