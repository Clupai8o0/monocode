import type {
  FeedRow,
  MapEdge,
  MapNode,
  MessageLogView,
  Party,
  Place,
} from "../../../src/fork/messageLog/messageLogView";

// A realistic Messages view: this Mac and Vivobook, a few delivered, a held,
// a failed, a dropped one between machines, and the relay off on Vivobook.
// Shared by the window's unit test and its browser harness.

export const NOW = Date.UTC(2026, 9, 29, 10, 30);
const min = 60_000;

const mac: Place = { id: "local", label: "This Mac", os: "macOS", local: true };
const vivo: Place = { id: "m1", label: "Vivobook", os: "Linux", local: false };

function session(place: Place, id: string, label: string, extra: Partial<Party> = {}): Party {
  return { key: `${place.id}:${id}`, label, place, sessionId: id, live: true, account: "main", ...extra };
}

export const parties = {
  ui: session(mac, "a1b2c3d4", "monocode-ui", { project: "monocode", openId: "mono-1" }),
  panoptic: session(mac, "b2c3d4e5", "panoptic-95", { project: "panoptic", account: "cx" }),
  notes: session(mac, "c3d4e5f6", "vault-notes", { project: "brain", live: false }),
  runner: session(vivo, "d4e5f6a7", "lab-runner", { project: "homelab", openId: "mono-9" }),
  build: session(vivo, "e5f6a7b8", "panoptic-build", { project: "panoptic" }),
  ghost: { key: "name:ghost", label: "ghost", live: false } as Party,
};

function row(
  id: string,
  ago: number,
  from: Party,
  to: Party,
  rest: Partial<FeedRow> & Pick<FeedRow, "status" | "statusText" | "preview">,
): FeedRow {
  const crossMachine = Boolean(from.place && to.place && from.place.id !== to.place.id);
  return {
    id,
    at: NOW - ago * min,
    from,
    to,
    route: crossMachine ? "relay" : from.place && to.place ? "local" : "unknown",
    trail: [],
    problem: rest.status === "failed" || rest.status === "dropped" || rest.status === "expired",
    crossMachine,
    ...rest,
  };
}

const { ui, panoptic, notes, runner, build, ghost } = parties;

export const rows: FeedRow[] = [
  row("r1", 3, ui, panoptic, {
    status: "delivered",
    statusText: "Delivered 10:27",
    summary: "Rebase is done",
    preview: "Rebased msg/ui onto main and pushed nothing. The store tests pass; you can pick up the footer button whenever you like.",
  }),
  row("r2", 9, panoptic, notes, {
    status: "held",
    statusText: "Held by vault-notes until someone approves it",
    preview: "Can you add the deploy checklist to the panoptic note? Keep it to the five steps we agreed on.",
  }),
  row("r3", 14, ui, ghost, {
    status: "failed",
    statusText: "No session named ghost is running",
    preview: "Are you still running the migration? I need the database back before I run the seed script.",
  }),
  row("r4", 22, ui, runner, {
    status: "dropped",
    statusText: "Lost by the relay on Vivobook: Not picked up within 45 s",
    summary: "Benchmarks ready?",
    trail: ["This Mac → Vivobook 10:08:12", "Dropped on Vivobook: Not picked up within 45 s"],
    preview:
      "When the benchmark run finishes, send me the p95 numbers for the cold start and the warm start, and say whether the second run used the cached index.\n\nIf it is still going, tell me roughly how long is left.",
  }),
  row("r5", 31, runner, panoptic, {
    status: "delivered",
    statusText: "Delivered 09:59",
    trail: ["Vivobook → This Mac 09:59:03"],
    preview: "Staging is green again. The flaky upload test was a clock skew on the runner, fixed by syncing time.",
  }),
  row("r6", 38, build, ui, {
    status: "waiting",
    statusText: "Sent 09:52; not seen by monocode-ui yet",
    trail: ["Vivobook → This Mac 09:52:40"],
    preview: "Build 1482 is up on the lab box if you want to try the new sidebar.",
  }),
  row("r7", 55, build, runner, {
    status: "delivered",
    statusText: "Delivered 09:35",
    preview: "Taking the GPU for twenty minutes for the embedding job.",
  }),
  row("r8", 140, panoptic, ui, {
    status: "delivered",
    statusText: "Delivered 08:10",
    summary: "Review notes",
    preview: "Two findings from the review: the retry loop never backs off, and the cache key ignores the account. Both are small.",
  }),
];

function graph(all: FeedRow[]) {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const node = (party: Party) => {
    let entry = nodes.get(party.key);
    if (!entry) {
      entry = { ...party, sent: 0, received: 0, problems: 0 };
      nodes.set(party.key, entry);
    }
    return entry;
  };
  for (const r of all) {
    const a = node(r.from);
    const b = node(r.to);
    a.sent++;
    b.received++;
    if (r.problem) {
      a.problems++;
      b.problems++;
    }
    const key = `${r.from.key}>${r.to.key}`;
    const edge = edges.get(key) ?? { from: r.from.key, to: r.to.key, count: 0, problems: 0, lastAt: r.at, rowIds: [] };
    edge.count++;
    edge.problems += r.problem ? 1 : 0;
    edge.rowIds.push(r.id);
    edges.set(key, edge);
  }
  const at = (place: Place) =>
    [...nodes.values()]
      .filter((n) => n.place?.id === place.id)
      .sort((x, y) => y.sent + y.received - (x.sent + x.received) || x.label.localeCompare(y.label));
  return {
    places: [
      { ...mac, nodes: at(mac), state: "ok" as const },
      { ...vivo, nodes: at(vivo), state: "ok" as const },
    ],
    unknown: [...nodes.values()].filter((n) => !n.place),
    edges: [...edges.values()],
  };
}

export function fakeView(over: Partial<MessageLogView> = {}): MessageLogView {
  return {
    window: "24h",
    rows,
    graph: graph(rows),
    counts: {
      total: rows.length,
      problems: rows.filter((r) => r.problem).length,
      crossMachine: rows.filter((r) => r.crossMachine).length,
    },
    recentProblems: 2,
    sources: [
      { place: mac, state: "ok", relay: "on", scannedAt: NOW },
      { place: vivo, state: "ok", relay: "off", scannedAt: NOW },
    ],
    warning:
      "The relay is off on Vivobook, so sessions on this Mac and Vivobook can't message each other through MonoCode.",
    loading: false,
    ...over,
  };
}
