/**
 * Fork feature: turns the readers' answers (messageLogProtocol.ts) into the
 * Messages window's view (messageLogView.ts). Pure; the store calls it after
 * every poll. Rules (normative; statusText wording may be tightened):
 *
 * Places. Source 0 is this Mac (place id "local", label "This Mac"); the
 * others are paired hosts (place id = machine id, label = its name). A
 * `Resolved.machine` maps to the source whose answer has that `machine`;
 * with no match the party has no place.
 *
 * Parties. With a session id: key `<placeId>:<sessionId>` (`?` for no
 * place), label = the name from that place's `sessions`, else the event's
 * name, else the session's project, else "A session". With only a name:
 * `name:<name>`. Neither: `unknown:<placeId or "?">`, label "Unknown
 * session". `live` = in its place's `sessions`. `openId` = the MonoCode
 * session from `mono` with that place and providerSessionId.
 *
 * Pairing. Every send gives one row; a receive gives its own row only when
 * no send claims it. A send claims the receive with its `msgId`; when either
 * has no msgId, the unclaimed receive with the same `key` whose `at` is from
 * 1 min before to 10 min after the send's, at the send's resolved target when
 * one is known; nearest in time wins.
 *
 * Status, the first that applies:
 * - send "failed" -> failed ("<error>", else "Not sent");
 * - send "expired" -> expired ("Held, then not approved in time");
 * - send "held" -> held ("Held by <to> until someone approves it");
 * - a dropped relay hop with its msgId (without one: its key and session
 *   ids, within 2 min) -> dropped ("Lost by the relay on <place>: <reason>");
 * - a claimed receive -> delivered ("Delivered <time>", the receive's `at`);
 * - send "released" -> delivered ("Approved and delivered <time>");
 * - send "pending" -> waiting ("Sending…");
 * - else waiting: "Sent <time>; not seen by <to> yet" when the target's place
 *   answered ("ok"), else "Sent <time>; can't see <place> to check" (no
 *   place: "Sent <time>; can't tell where it went").
 * A receive's own row: delivered, "Received <time>".
 * problem = failed, dropped or expired; or waiting (not pending) for longer
 * than PROBLEM_WAIT_MS while the target's place answered and the target is
 * live and not busy.
 * Not a problem, though the row still says what happened (`settled`): a send
 * whose target's socket was gone, because that session has ended, and a lost
 * send whose session sent the same text again within RESEND_MS, because the
 * sender already dealt with it.
 *
 * Ends. from = the send's own session; for a receive's own row, its resolved
 * sender, else `fromName`, else unknown. to = the claimed receive's session,
 * else the send's target, else `to`/`toName` as a name, else unknown.
 * route = the target's (receive row: sender's) route, else "unknown".
 * crossMachine = both places known and different.
 *
 * Trail. Relay hops matching the row (msgId; else key and session ids within
 * 2 min), oldest first: "<from place> → <to place> <time>" for a passed
 * message, "Dropped on <place>: <reason>" for a dropped one. Receipts are
 * left out.
 *
 * Window. Rows with `at` older than the window are left out; rows newest
 * first; counts over the rows; recentProblems over problem rows from the
 * last hour.
 *
 * Map. One MapPlace per source, in source order, with its state. Nodes: the
 * parties at that place that are in a row (sent / received / problems
 * counted over the rows), then its other live sessions with zero counts;
 * busiest (sent + received) first, then by label. Parties with no place go
 * in `unknown`. One edge per (from key, to key), rowIds newest first.
 *
 * Sources. SourceView.relay: the Mac "on"/"off" from its traffic `enabled`;
 * a host "absent" with no traffic (an older host), else on/off.
 *
 * Warning, the first that applies:
 * - the relay "off" on a source while a host is connected: "The relay is off
 *   on <place>, so sessions on this Mac and <host> can't message each other
 *   through MonoCode.";
 * - a host "offline": "Can't reach <place>. Its messages are from <time>."
 *   (no answer yet: "Can't reach <place>, so its messages aren't shown.");
 * - a host "old-host": "<place> needs a host update to show its messages.".
 */

import {
  TRAFFIC_MAX,
  type LogEvent,
  type MessageLogAnswer,
  type ReceiveEvent,
  type RelayHop,
  type RelayTrafficAnswer,
  type Resolved,
  type SendEvent,
} from "./messageLogProtocol";
import {
  PROBLEM_WAIT_MS,
  WINDOW_HOURS,
  type FeedRow,
  type MapEdge,
  type MapGraph,
  type MapNode,
  type MapPlace,
  type MessageLogView,
  type Party,
  type Place,
  type RowRoute,
  type RowStatus,
  type SourceState,
  type SourceView,
  type WindowChoice,
} from "./messageLogView";

/** A MonoCode session and the Claude session it runs. */
export type MonoSessionRef = {
  /** The MonoCode session id (what NOTIFICATION_CLICK_EVENT opens). */
  id: string;
  /** The Claude session id it runs. */
  providerSessionId: string;
  /** "local", or the paired machine id it runs on. */
  placeId: string;
};

export type SourceInput = {
  place: Place;
  state: SourceState;
  error?: string;
  /** Answers so far, merged with mergeLogAnswer. */
  log?: MessageLogAnswer;
  /** Hops so far, merged with mergeTraffic; undefined when the source has no
   *  relay traffic (a host without "relay.traffic.v1"). */
  traffic?: RelayTrafficAnswer;
};

export type BuildInput = {
  window: WindowChoice;
  now: number;
  /** [0] is this Mac. */
  sources: SourceInput[];
  mono: readonly MonoSessionRef[];
  /** Clock time for status lines and trails, e.g. formatPeerTime. */
  formatTime: (at: number) => string;
  /** True until this Mac's first answer. */
  loading: boolean;
};

const HOUR_MS = 3_600_000;
const PAIR_BEFORE_MS = 60_000;
// A busy session reads a message when its turn ends, which can be a while.
const PAIR_AFTER_MS = 60 * 60_000;
const RESEND_MS = 30 * 60_000;
/** Connecting to a session's socket failed because the socket is gone. */
const TARGET_ENDED = /\b(?:ENOENT|ECONNREFUSED)\b/;
const HOP_MATCH_MS = 2 * 60_000;

function byAtThenId(a: LogEvent, b: LogEvent): number {
  if (a.at !== b.at) {
    return a.at - b.at;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Folds a new answer into the last one: `next` alone when it is full, when
 * there is no `prev`, or when the epoch changed; else `prev`'s events with
 * `next`'s upserted by id, and everything else from `next`. Events older
 * than `now - windowHours` are dropped; events stay sorted by (at, id).
 */
export function mergeLogAnswer(
  prev: MessageLogAnswer | undefined,
  next: MessageLogAnswer,
  now: number,
): MessageLogAnswer {
  const cutoff = now - next.windowHours * HOUR_MS;
  let events: LogEvent[];
  if (next.full || !prev || prev.epoch !== next.epoch) {
    events = next.events.slice();
  } else {
    const byId = new Map<string, LogEvent>();
    for (const event of prev.events) {
      byId.set(event.id, event);
    }
    for (const event of next.events) {
      byId.set(event.id, event);
    }
    events = [...byId.values()];
  }
  events = events.filter((event) => event.at >= cutoff).sort(byAtThenId);
  return { ...next, events };
}

/**
 * Folds new hops in: `next` alone for a new epoch or no `prev`; else `prev`'s
 * hops plus `next`'s with a higher seq, the last TRAFFIC_MAX kept.
 */
export function mergeTraffic(
  prev: RelayTrafficAnswer | undefined,
  next: RelayTrafficAnswer,
): RelayTrafficAnswer {
  if (!prev || prev.epoch !== next.epoch) {
    return next;
  }
  const last = prev.hops.reduce((max, hop) => Math.max(max, hop.seq), 0);
  const hops = [...prev.hops, ...next.hops.filter((hop) => hop.seq > last)];
  return { ...next, hops: hops.slice(-TRAFFIC_MAX) };
}

// ---- building the view ----

type Ctx = {
  input: BuildInput;
  /** Relay name -> source index. */
  byMachine: Map<string, number>;
};

type Located<T> = { event: T; source: number };

type Hop = { hop: RelayHop; source: number };

function placeIndex(ctx: Ctx, machine: string | undefined): number | undefined {
  return machine === undefined ? undefined : ctx.byMachine.get(machine);
}

function party(
  ctx: Ctx,
  source: number | undefined,
  sessionId: string | undefined,
  name: string | undefined,
  account?: "main" | "cx",
): Party {
  const src = source === undefined ? undefined : ctx.input.sources[source];
  const place = src?.place;
  if (sessionId) {
    const session = src?.log?.sessions.find((entry) => entry.sessionId === sessionId);
    const mono = place
      ? ctx.input.mono.find(
          (ref) => ref.placeId === place.id && ref.providerSessionId === sessionId,
        )
      : undefined;
    const out: Party = {
      key: `${place?.id ?? "?"}:${sessionId}`,
      label: session?.name || name || session?.project || "A session",
      live: !!session,
      sessionId,
    };
    if (session?.project) {
      out.project = session.project;
    }
    const acct = session?.account ?? account;
    if (acct) {
      out.account = acct;
    }
    if (place) {
      out.place = place;
    }
    if (mono) {
      out.openId = mono.id;
    }
    return out;
  }
  if (name) {
    const out: Party = { key: `name:${name}`, label: name, live: false };
    if (place) {
      out.place = place;
    }
    return out;
  }
  const out: Party = {
    key: `unknown:${place?.id ?? "?"}`,
    label: "Unknown session",
    live: false,
  };
  if (place) {
    out.place = place;
  }
  return out;
}

function resolvedParty(ctx: Ctx, resolved: Resolved, fallbackName?: string): Party {
  return party(
    ctx,
    placeIndex(ctx, resolved.machine),
    resolved.sessionId,
    resolved.name ?? fallbackName,
    resolved.account,
  );
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function placeLabel(ctx: Ctx, machine: string): string {
  const index = ctx.byMachine.get(machine);
  return index === undefined ? machine : ctx.input.sources[index].place.label;
}

function hopMatches(
  hop: RelayHop,
  msgId: string | undefined,
  key: string,
  at: number,
  fromSessionId: string | undefined,
  toSessionId: string | undefined,
): boolean {
  if (hop.kind !== "message") {
    return false;
  }
  if (hop.msgId && msgId) {
    return hop.msgId === msgId;
  }
  if (!hop.key || hop.key !== key || Math.abs(hop.at - at) > HOP_MATCH_MS) {
    return false;
  }
  if (hop.fromSessionId && fromSessionId && hop.fromSessionId !== fromSessionId) {
    return false;
  }
  if (hop.toSessionId && toSessionId && hop.toSessionId !== toSessionId) {
    return false;
  }
  return true;
}

function trailLine(ctx: Ctx, entry: Hop): string {
  const { hop } = entry;
  const here = ctx.input.sources[entry.source].place.label;
  if (hop.outcome === "dropped") {
    return `Dropped on ${here}: ${lowerFirst(hop.reason ?? "No reason given")}`;
  }
  const peer = placeLabel(ctx, hop.peer);
  const [from, to] = hop.direction === "out" ? [here, peer] : [peer, here];
  return `${from} → ${to} ${ctx.input.formatTime(hop.at)}`;
}

function sortByAt<T extends { event: LogEvent }>(list: T[]): T[] {
  return list.sort((a, b) => byAtThenId(a.event, b.event));
}

/** Which receive each send claims, by send id. */
function pair(
  ctx: Ctx,
  sends: Located<SendEvent>[],
  receives: Located<ReceiveEvent>[],
): Map<string, Located<ReceiveEvent>> {
  const claims = new Map<string, Located<ReceiveEvent>>();
  const taken = new Set<string>();
  const byMsgId = new Map<string, Located<ReceiveEvent>>();
  for (const receive of receives) {
    if (receive.event.msgId && !byMsgId.has(receive.event.msgId)) {
      byMsgId.set(receive.event.msgId, receive);
    }
  }
  const claimKey = (r: Located<ReceiveEvent>) => `${r.source}\0${r.event.id}`;
  for (const send of sends) {
    const msgId = send.event.msgId;
    const receive = msgId ? byMsgId.get(msgId) : undefined;
    if (receive && !taken.has(claimKey(receive))) {
      taken.add(claimKey(receive));
      claims.set(send.event.id, receive);
    }
  }
  for (const send of sends) {
    if (claims.has(send.event.id)) {
      continue;
    }
    const target = send.event.target;
    const targetSource = placeIndex(ctx, target?.machine);
    let best: Located<ReceiveEvent> | undefined;
    for (const receive of receives) {
      const r = receive.event;
      if (taken.has(claimKey(receive)) || r.key !== send.event.key) {
        continue;
      }
      if (send.event.msgId && r.msgId) {
        continue;
      }
      if (r.at < send.event.at - PAIR_BEFORE_MS || r.at > send.event.at + PAIR_AFTER_MS) {
        continue;
      }
      if (targetSource !== undefined && receive.source !== targetSource) {
        continue;
      }
      if (target?.sessionId && r.sessionId !== target.sessionId) {
        continue;
      }
      if (!best || Math.abs(r.at - send.event.at) < Math.abs(best.event.at - send.event.at)) {
        best = receive;
      }
    }
    if (best) {
      taken.add(claimKey(best));
      claims.set(send.event.id, best);
    }
  }
  return claims;
}

function sendRow(
  ctx: Ctx,
  send: Located<SendEvent>,
  receive: Located<ReceiveEvent> | undefined,
  hops: Hop[],
): FeedRow {
  const { input } = ctx;
  const event = send.event;
  const from = party(ctx, send.source, event.sessionId, undefined, event.account);
  let to: Party;
  if (receive) {
    to = party(ctx, receive.source, receive.event.sessionId, event.to || event.toName, receive.event.account);
  } else if (event.target) {
    to = resolvedParty(ctx, event.target, event.to || event.toName);
  } else {
    to = party(ctx, undefined, undefined, event.to || event.toName);
  }
  const msgId = event.msgId ?? receive?.event.msgId;
  const matched = hops
    .filter((entry) =>
      hopMatches(entry.hop, msgId, event.key, event.at, from.sessionId, to.sessionId))
    .sort((a, b) => a.hop.at - b.hop.at || a.hop.seq - b.hop.seq);
  const dropped = matched.find((entry) => entry.hop.outcome === "dropped");
  const targetSource = to.place
    ? input.sources.findIndex((src) => src.place.id === to.place?.id)
    : -1;
  const targetOk = targetSource >= 0 && input.sources[targetSource].state === "ok";
  let status: RowStatus;
  let statusText: string;
  let problem = false;
  let settled = false;
  if (event.status === "failed") {
    status = "failed";
    statusText = event.error || "Not sent";
    settled = TARGET_ENDED.test(statusText);
    if (settled) {
      statusText = "Not sent: that session has ended";
    }
  } else if (event.status === "expired") {
    status = "expired";
    statusText = "Held, then not approved in time";
  } else if (event.status === "held") {
    status = "held";
    statusText = `Held by ${to.label} until someone approves it`;
  } else if (dropped) {
    status = "dropped";
    const where = input.sources[dropped.source].place.label;
    statusText = `Lost by the relay on ${where}: ${lowerFirst(dropped.hop.reason ?? "No reason given")}`;
  } else if (receive) {
    status = "delivered";
    statusText = `Delivered ${input.formatTime(receive.event.at)}`;
  } else if (event.status === "released") {
    status = "delivered";
    statusText = `Approved and delivered ${input.formatTime(event.updatedAt)}`;
  } else if (event.status === "pending") {
    status = "waiting";
    statusText = "Sending…";
  } else {
    status = "waiting";
    const time = input.formatTime(event.at);
    const session = to.sessionId
      ? input.sources[targetSource]?.log?.sessions.find((entry) => entry.sessionId === to.sessionId)
      : undefined;
    if (targetOk && to.sessionId && !session) {
      statusText = `Sent ${time}; ${to.label} has ended`;
    } else if (targetOk && session?.status === "busy") {
      statusText = `Sent ${time}; ${to.label} will see it after this turn`;
    } else if (targetOk) {
      statusText = `Sent ${time}; not seen by ${to.label} yet`;
      problem = input.now - event.at > PROBLEM_WAIT_MS;
    } else if (to.place) {
      statusText = `Sent ${time}; can't see ${to.place.label} to check`;
    } else {
      statusText = `Sent ${time}; can't tell where it went`;
    }
  }
  if ((status === "failed" || status === "dropped" || status === "expired") && !settled) {
    problem = true;
  }
  const row: FeedRow = {
    id: event.id,
    at: event.at,
    from,
    to,
    route: (event.target?.route ?? "unknown") as RowRoute,
    status,
    statusText,
    trail: matched.map((entry) => trailLine(ctx, entry)),
    preview: event.preview,
    problem,
    crossMachine: !!from.place && !!to.place && from.place.id !== to.place.id,
  };
  if (event.summary) {
    row.summary = event.summary;
  }
  if (settled) {
    row.settled = true;
  }
  return row;
}

/** Previews and keys are cut, so only digests tell long messages apart. */
function sameText(a: SendEvent, b: SendEvent): boolean {
  return a.digest && b.digest
    ? a.digest === b.digest
    : a.key === b.key && a.preview === b.preview;
}

/** A lost send isn't a problem once its session sent the same text again. */
function settleResent(
  input: BuildInput,
  sends: readonly Located<SendEvent>[],
  rows: FeedRow[],
): void {
  const lost = (row: FeedRow) =>
    row.status === "failed" || row.status === "dropped" || row.status === "expired";
  rows.forEach((row, index) => {
    if (!row.problem || !lost(row)) {
      return;
    }
    const { event } = sends[index];
    const again = sends.findIndex(
      (other, otherIndex) =>
        !lost(rows[otherIndex]) &&
        other.source === sends[index].source &&
        other.event.sessionId === event.sessionId &&
        sameText(other.event, event) &&
        other.event.at > event.at &&
        other.event.at - event.at <= RESEND_MS,
    );
    if (again >= 0) {
      const next = rows[again];
      row.problem = false;
      row.settled = true;
      row.statusText = `${row.statusText}. Sent again to ${next.to.label} at ${input.formatTime(next.at)}`;
    }
  });
}

function receiveRow(ctx: Ctx, receive: Located<ReceiveEvent>, hops: Hop[]): FeedRow {
  const event = receive.event;
  const from = event.sender
    ? resolvedParty(ctx, event.sender, event.fromName)
    : party(ctx, undefined, undefined, event.fromName);
  const to = party(ctx, receive.source, event.sessionId, undefined, event.account);
  const matched = hops
    .filter((entry) =>
      hopMatches(entry.hop, event.msgId, event.key, event.at, from.sessionId, to.sessionId))
    .sort((a, b) => a.hop.at - b.hop.at || a.hop.seq - b.hop.seq);
  return {
    id: event.id,
    at: event.at,
    from,
    to,
    route: (event.sender?.route ?? "unknown") as RowRoute,
    status: "delivered",
    statusText: `Received ${ctx.input.formatTime(event.at)}`,
    trail: matched.map((entry) => trailLine(ctx, entry)),
    preview: event.preview,
    problem: false,
    crossMachine: !!from.place && !!to.place && from.place.id !== to.place.id,
  };
}

function buildGraph(ctx: Ctx, rows: FeedRow[]): MapGraph {
  const nodes = new Map<string, MapNode>();
  const touch = (p: Party, sent: number, received: number, problems: number) => {
    let node = nodes.get(p.key);
    if (!node) {
      node = { ...p, sent: 0, received: 0, problems: 0 };
      nodes.set(p.key, node);
    }
    node.sent += sent;
    node.received += received;
    node.problems += problems;
  };
  const edges = new Map<string, MapEdge>();
  for (const row of rows) {
    const problem = row.problem ? 1 : 0;
    touch(row.from, 1, 0, problem);
    touch(row.to, 0, 1, problem);
    const id = `${row.from.key}\0${row.to.key}`;
    let edge = edges.get(id);
    if (!edge) {
      edge = { from: row.from.key, to: row.to.key, count: 0, problems: 0, lastAt: row.at, rowIds: [] };
      edges.set(id, edge);
    }
    edge.count += 1;
    edge.problems += problem;
    edge.lastAt = Math.max(edge.lastAt, row.at);
    edge.rowIds.push(row.id);
  }
  const order = (a: MapNode, b: MapNode) =>
    b.sent + b.received - (a.sent + a.received) || a.label.localeCompare(b.label);
  const places: MapPlace[] = ctx.input.sources.map((src, index) => {
    const here = [...nodes.values()].filter((node) => node.place?.id === src.place.id);
    for (const session of src.log?.sessions ?? []) {
      const p = party(ctx, index, session.sessionId, undefined, session.account);
      if (!nodes.has(p.key) && !here.some((node) => node.key === p.key)) {
        here.push({ ...p, sent: 0, received: 0, problems: 0 });
      }
    }
    return { ...src.place, nodes: here.sort(order), state: src.state };
  });
  const unknown = [...nodes.values()].filter((node) => !node.place).sort(order);
  return { places, unknown, edges: [...edges.values()] };
}

function relayOf(src: SourceInput, local: boolean): SourceView["relay"] {
  if (!src.traffic) {
    return local ? undefined : "absent";
  }
  return src.traffic.enabled ? "on" : "off";
}

function warningFor(input: BuildInput, sources: SourceView[]): string | undefined {
  const hosts = sources.filter((view) => !view.place.local);
  if (hosts.length > 0) {
    const off = sources.find((view) => view.relay === "off");
    if (off) {
      const host = off.place.local ? hosts[0].place.label : off.place.label;
      return `The relay is off on ${off.place.label}, so sessions on this Mac and ${host} can't message each other through MonoCode.`;
    }
  }
  const offline = hosts.find((view) => view.state === "offline");
  if (offline) {
    return offline.scannedAt === undefined
      ? `Can't reach ${offline.place.label}, so its messages aren't shown.`
      : `Can't reach ${offline.place.label}. Its messages are from ${input.formatTime(offline.scannedAt)}.`;
  }
  const old = hosts.find((view) => view.state === "old-host");
  if (old) {
    return `${old.place.label} needs a host update to show its messages.`;
  }
  return undefined;
}

export function buildMessageLogView(input: BuildInput): MessageLogView {
  const byMachine = new Map<string, number>();
  input.sources.forEach((src, index) => {
    if (src.log?.machine && !byMachine.has(src.log.machine)) {
      byMachine.set(src.log.machine, index);
    }
  });
  const ctx: Ctx = { input, byMachine };
  const sends: Located<SendEvent>[] = [];
  const receives: Located<ReceiveEvent>[] = [];
  const hops: Hop[] = [];
  input.sources.forEach((src, source) => {
    for (const event of src.log?.events ?? []) {
      if (event.kind === "send") {
        sends.push({ event, source });
      } else {
        receives.push({ event, source });
      }
    }
    for (const hop of src.traffic?.hops ?? []) {
      hops.push({ hop, source });
    }
  });
  sortByAt(sends);
  sortByAt(receives);
  const claims = pair(ctx, sends, receives);
  const claimed = new Set<Located<ReceiveEvent>>(claims.values());
  const cutoff = input.now - WINDOW_HOURS[input.window] * HOUR_MS;
  const sendRows = sends.map((send) => sendRow(ctx, send, claims.get(send.event.id), hops));
  settleResent(input, sends, sendRows);
  const all: FeedRow[] = [
    ...sendRows,
    ...receives
      .filter((receive) => !claimed.has(receive))
      .map((receive) => receiveRow(ctx, receive, hops)),
  ];
  const rows = all
    .filter((row) => row.at >= cutoff)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const sources: SourceView[] = input.sources.map((src, index) => {
    const view: SourceView = { place: src.place, state: src.state };
    if (src.error) {
      view.error = src.error;
    }
    const relay = relayOf(src, index === 0);
    if (relay) {
      view.relay = relay;
    }
    if (src.log) {
      view.scannedAt = src.log.scannedAt;
    }
    return view;
  });
  const view: MessageLogView = {
    window: input.window,
    rows,
    graph: buildGraph(ctx, rows),
    counts: {
      total: rows.length,
      problems: rows.filter((row) => row.problem).length,
      crossMachine: rows.filter((row) => row.crossMachine).length,
    },
    recentProblems: all.filter((row) => row.problem && row.at >= input.now - HOUR_MS).length,
    sources,
    loading: input.loading,
  };
  const warning = warningFor(input, sources);
  if (warning) {
    view.warning = warning;
  }
  return view;
}
