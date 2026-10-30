/**
 * Fork feature: what the Messages window shows of the view, given its
 * filters, and the plain words it uses. Pure, so the window stays a drawing.
 */

import type {
  FeedRow,
  MapGraph,
  MessageLogView,
  Party,
  RowRoute,
  RowStatus,
} from "./messageLogView";

export type FeedFilter = {
  problemsOnly: boolean;
  /** A Place id, or null for every place. */
  placeId: string | null;
  /** A Party key, or null for every party. */
  partyKey: string | null;
};

export const NO_FILTER: FeedFilter = { problemsOnly: false, placeId: null, partyKey: null };

export function filterRows(rows: readonly FeedRow[], filter: FeedFilter): FeedRow[] {
  return rows.filter((row) => {
    if (filter.problemsOnly && !row.problem) {
      return false;
    }
    if (filter.placeId && row.from.place?.id !== filter.placeId && row.to.place?.id !== filter.placeId) {
      return false;
    }
    if (filter.partyKey && row.from.key !== filter.partyKey && row.to.key !== filter.partyKey) {
      return false;
    }
    return true;
  });
}

/** A party's label by key, from the rows or the map. */
export function partyByKey(view: MessageLogView, key: string): Party | undefined {
  for (const row of view.rows) {
    if (row.from.key === key) {
      return row.from;
    }
    if (row.to.key === key) {
      return row.to;
    }
  }
  return allNodes(view.graph).find((node) => node.key === key);
}

export function allNodes(graph: MapGraph) {
  return [...graph.places.flatMap((place) => place.nodes), ...graph.unknown];
}

export type Tone = "problem" | "held" | "waiting" | "delivered";

export function toneOf(row: FeedRow): Tone {
  if (row.settled) {
    return "waiting";
  }
  if (row.problem || row.status === "failed" || row.status === "dropped" || row.status === "expired") {
    return "problem";
  }
  if (row.status === "held") {
    return "held";
  }
  return row.status === "waiting" ? "waiting" : "delivered";
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  delivered: "Delivered",
  waiting: "Waiting",
  held: "Held",
  failed: "Failed",
  dropped: "Dropped",
  expired: "Expired",
};

export const ROUTE_LABEL: Record<RowRoute, string> = {
  local: "Local",
  relay: "Relay",
  bridge: "Bridge",
  unknown: "Route unknown",
};

export const ROUTE_TITLE: Record<RowRoute, string> = {
  local: "Both sessions are on the same machine",
  relay: "Carried between machines by the MonoCode relay",
  bridge: "Sent through a Remote Control bridge",
  unknown: "It isn't known how this message travelled",
};

export const WINDOW_WORDS = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days" } as const;

/** A party as one line: its name, and its machine when that tells it apart. */
export function partyText(party: Party, withPlace: boolean): string {
  return withPlace && party.place ? `${party.label} on ${party.place.label}` : party.label;
}

/** One plain line per machine that is not answering normally. Lines the
 *  warning already says are left out. */
export function sourceLines(view: MessageLogView, formatTime: (at: number) => string): string[] {
  const lines: string[] = [];
  for (const source of view.sources) {
    const name = source.place.label;
    const covered = view.warning?.includes(name) ?? false;
    if (source.state === "offline" && !covered) {
      lines.push(
        source.scannedAt
          ? `${name} isn't answering. Its messages are from ${formatTime(source.scannedAt)}.`
          : `${name} isn't answering, so its messages aren't shown.`,
      );
    } else if (source.state === "old-host" && !covered) {
      lines.push(`${name} needs a host update to show its messages.`);
    } else if (source.state === "error") {
      lines.push(source.error ? `Couldn't read messages on ${name}: ${source.error}` : `Couldn't read messages on ${name}.`);
    } else if (source.state === "loading" && !source.place.local) {
      lines.push(`Asking ${name} for its messages…`);
    }
  }
  return lines;
}

export function countsLine(view: MessageLogView, shown: number, filtered: boolean): string {
  const { total, problems, crossMachine } = view.counts;
  const parts = [`${total} message${total === 1 ? "" : "s"}`];
  parts.push(problems ? `${problems} problem${problems === 1 ? "" : "s"}` : "no problems");
  if (crossMachine) {
    parts.push(`${crossMachine} between machines`);
  }
  const line = parts.join(", ");
  return filtered ? `${shown} shown of ${line}` : line;
}
