/**
 * Fork feature: the message log, as the Messages window shows it. The store
 * (messageLogStore.ts) polls the readers in messageLogProtocol.ts and
 * messageLogModel.ts turns their answers into this view; the window
 * (MessagesWindow.tsx) only draws it.
 */

export type WindowChoice = "1h" | "24h" | "7d";

export const WINDOW_HOURS: Record<WindowChoice, number> = { "1h": 1, "24h": 24, "7d": 168 };

/** A machine: this Mac, or a paired host. */
export type Place = {
  /** "local" for this Mac, else the paired machine's id. */
  id: string;
  /** What the user calls it: "This Mac", or the paired machine's name ("Vivobook"). */
  label: string;
  /** Linux, macOS…, for the machine pill; empty when unknown. */
  os: string;
  local: boolean;
};

/** One end of a message. */
export type Party = {
  /** Stable across polls: `<placeId>:<sessionId>`, else `name:<name>`, else
   *  `unknown:<placeId|"?">`. Map nodes and filters use it. */
  key: string;
  /** The session's name, else its project, else "A session". */
  label: string;
  project?: string;
  account?: "main" | "cx";
  /** Undefined when it is not known which machine it is on. */
  place?: Place;
  sessionId?: string;
  /** Running now (in a registry this poll). */
  live: boolean;
  /** The MonoCode session to open for it, when MonoCode runs it on this Mac or a host. */
  openId?: string;
};

export type RowStatus =
  /** The other session has it (seen in its transcript, or released to it). */
  | "delivered"
  /** Sent; not seen on the other side yet. */
  | "waiting"
  /** The other session holds it until someone approves it. */
  | "held"
  /** Never left: no such session, its socket was gone, a name was ambiguous, refused. */
  | "failed"
  /** The relay lost it between machines. */
  | "dropped"
  /** Held, then not approved in time. */
  | "expired";

export type RowRoute = "local" | "relay" | "bridge" | "unknown";

export type FeedRow = {
  id: string;
  at: number;
  from: Party;
  to: Party;
  route: RowRoute;
  status: RowStatus;
  /** One plain sentence for the row's status, e.g. "Delivered 10:04",
   *  "Held by panoptic-95 until it is approved", "No session named ghost is
   *  running". */
  statusText: string;
  /** The relay's hops for it, oldest first, as plain lines ("Mac → Vivobook
   *  10:04:12", "Dropped on Vivobook: not picked up within 45 s"). */
  trail: string[];
  summary?: string;
  preview: string;
  /** Failed, dropped, expired, or waiting longer than PROBLEM_WAIT_MS. */
  problem: boolean;
  /** Lost, but nothing is left to do: the target ended, or it was sent again. */
  settled?: boolean;
  /** Both ends known and on different machines. */
  crossMachine: boolean;
};

/** A waiting message counts as a problem after this long. */
export const PROBLEM_WAIT_MS = 10 * 60_000;

export type MapNode = Party & {
  sent: number;
  received: number;
  problems: number;
};

export type MapEdge = {
  /** Party keys. */
  from: string;
  to: string;
  count: number;
  problems: number;
  lastAt: number;
  /** FeedRow ids, newest first. */
  rowIds: string[];
};

export type SourceState =
  | "loading"
  | "ok"
  /** The machine did not answer; the last answer is kept. */
  | "offline"
  /** A host without "messages.v1": it needs a host update. */
  | "old-host"
  | "error";

export type MapPlace = Place & {
  /** Sessions here that sent or got a message in the window, then the
   *  other live ones; busiest first. */
  nodes: MapNode[];
  state: SourceState;
};

export type MapGraph = {
  places: MapPlace[];
  /** Ends whose machine is not known. */
  unknown: MapNode[];
  edges: MapEdge[];
};

export type SourceView = {
  place: Place;
  state: SourceState;
  /** Plain words when state is "error" or "offline". */
  error?: string;
  /** The relay on that machine: on, off, or not offered (older host). */
  relay?: "on" | "off" | "absent";
  /** Last answer's time. */
  scannedAt?: number;
};

export type MessageLogView = {
  window: WindowChoice;
  /** Newest first. */
  rows: FeedRow[];
  graph: MapGraph;
  counts: { total: number; problems: number; crossMachine: number };
  /** Problem rows from the last hour, whatever the window: the footer
   *  button's red count. */
  recentProblems: number;
  sources: SourceView[];
  /** A line the window shows above everything when messages between
   *  machines can't work, e.g. "The relay is off on Vivobook, so sessions
   *  on this Mac and Vivobook can't message each other through MonoCode."
   *  Undefined when all is well. */
  warning?: string;
  /** True until the first answer from this Mac. */
  loading: boolean;
};
