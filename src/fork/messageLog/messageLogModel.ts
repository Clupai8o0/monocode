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
 * than PROBLEM_WAIT_MS while the target's place answered.
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

import type { MessageLogAnswer, RelayTrafficAnswer } from "./messageLogProtocol";
import type { MessageLogView, Place, SourceState, WindowChoice } from "./messageLogView";

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
  void prev;
  void now;
  return next; // Built by the model builder.
}

/**
 * Folds new hops in: `next` alone for a new epoch or no `prev`; else `prev`'s
 * hops plus `next`'s with a higher seq, the last TRAFFIC_MAX kept.
 */
export function mergeTraffic(
  prev: RelayTrafficAnswer | undefined,
  next: RelayTrafficAnswer,
): RelayTrafficAnswer {
  void prev;
  return next; // Built by the model builder.
}

export function buildMessageLogView(input: BuildInput): MessageLogView {
  // Built by the model builder.
  return {
    window: input.window,
    rows: [],
    graph: { places: [], unknown: [], edges: [] },
    counts: { total: 0, problems: 0, crossMachine: 0 },
    recentProblems: 0,
    sources: input.sources.map((s) => ({ place: s.place, state: s.state, error: s.error })),
    loading: input.loading,
  };
}
