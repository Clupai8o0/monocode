import type { MapEdge, MapGraph, MapNode, SourceState } from "./messageLogView";

/**
 * Fork: the Messages window's Map. One tinted column per machine, a card per
 * session, and a curve per pair that talked: thicker for more messages, red
 * when one went wrong. Clicking a session shows its messages in the Feed.
 */

const PAD = 16;
const COL_W = 212;
const COL_GAP = 72;
const HEADER = 50;
const NODE_W = COL_W - 24;
const NODE_H = 40;
const NODE_GAP = 10;
/** Room beside the first and last columns for curves between two sessions
 *  in one column, and below them for curves that skip a column. */
const SIDE = 40;
const UNDER = 26;

type Column = {
  id: string;
  title: string;
  sub: string;
  nodes: MapNode[];
  x: number;
};

type Spot = { x: number; y: number; col: number };

export type MapLayout = {
  width: number;
  height: number;
  /** The tinted columns' height; curves that skip a column run below it. */
  columnHeight: number;
  columns: Column[];
  spots: Map<string, Spot>;
  edges: { edge: MapEdge; d: string; width: number }[];
};

const STATE_WORDS: Record<SourceState, string> = {
  loading: "Asking…",
  ok: "",
  offline: "Not answering",
  "old-host": "Needs a host update",
  error: "Couldn't read it",
};

export function layoutMap(graph: MapGraph, problemsOnly = false): MapLayout {
  const columns: Column[] = graph.places.map((place, i) => ({
    id: place.id,
    title: place.label,
    sub: [place.os, STATE_WORDS[place.state]].filter(Boolean).join(" · "),
    nodes: place.nodes,
    x: PAD + SIDE + i * (COL_W + COL_GAP),
  }));
  if (graph.unknown.length > 0) {
    columns.push({
      id: "?",
      title: "Machine unknown",
      sub: "Sessions MonoCode can't place",
      nodes: graph.unknown,
      x: PAD + SIDE + columns.length * (COL_W + COL_GAP),
    });
  }
  const spots = new Map<string, Spot>();
  columns.forEach((column, col) => {
    column.nodes.forEach((node, i) => {
      spots.set(node.key, { x: column.x + 12, y: PAD + HEADER + i * (NODE_H + NODE_GAP), col });
    });
  });
  const tallest = Math.max(1, ...columns.map((column) => column.nodes.length));
  const width = columns.length ? columns[columns.length - 1].x + COL_W + SIDE : PAD * 2;
  const bottom = PAD + HEADER + tallest * (NODE_H + NODE_GAP) + 6;
  const pairs = graph.edges.flatMap((edge) => {
    const a = spots.get(edge.from);
    const b = spots.get(edge.to);
    return a && b && edge.from !== edge.to && (!problemsOnly || edge.problems > 0) ? [{ edge, a, b }] : [];
  });
  const skips = pairs.some(({ a, b }) => Math.abs(a.col - b.col) > 1);
  const edges = pairs.map(({ edge, a, b }) => ({
    edge,
    d: curve(a, b, bottom + UNDER / 2),
    width: 1.25 + Math.min(edge.count, 12) * 0.4,
  }));
  return { width, columnHeight: bottom - PAD, height: bottom + PAD + (skips ? UNDER : 0), columns, spots, edges };
}

/** Leaves a card a little above its middle and arrives a little below, so
 *  the two directions between one pair never draw on top of each other.
 *  Within one column it bows out on the left of the first column and the
 *  right of the others; past a column it runs underneath, never behind a card. */
function curve(a: Spot, b: Spot, under: number): string {
  const y1 = a.y + NODE_H / 2 - 5;
  const y2 = b.y + NODE_H / 2 + 5;
  if (a.col === b.col) {
    const left = a.col === 0;
    const x = left ? a.x : a.x + NODE_W;
    const bulge = (left ? -1 : 1) * (26 + Math.min(14, Math.abs(y2 - y1) * 0.1));
    const end = x + (left ? -6 : 6);
    return `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${end} ${y2}`;
  }
  const forward = a.col < b.col;
  const x1 = forward ? a.x + NODE_W : a.x;
  const x2 = forward ? b.x - 6 : b.x + NODE_W + 6;
  if (Math.abs(a.col - b.col) > 1) {
    const out = forward ? 30 : -30;
    return `M ${x1} ${y1} C ${x1 + out} ${y1}, ${x1 + out} ${under}, ${x1 + out * 2} ${under} L ${x2 - out * 2} ${under} C ${x2 - out} ${under}, ${x2 - out} ${y2}, ${x2} ${y2}`;
  }
  const mid = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function MessageMap({
  graph,
  problemsOnly,
  placeId,
  partyKey,
  onPick,
}: {
  graph: MapGraph;
  problemsOnly: boolean;
  placeId: string | null;
  partyKey: string | null;
  onPick: (key: string) => void;
}) {
  const layout = layoutMap(graph, problemsOnly);
  if (layout.columns.length === 0) {
    return <p className="px-1 py-10 text-center text-[12px] text-content/50">No sessions to draw yet.</p>;
  }
  const placeOf = (key: string) => {
    const spot = layout.spots.get(key);
    return spot ? layout.columns[spot.col].id : undefined;
  };
  const dimmed = (id: string | undefined) => placeId !== null && id !== placeId;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <svg
          role="group"
          aria-label="Who messaged whom"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block select-none"
        >
          <defs>
            <marker id="msg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" className="fill-content/40" />
            </marker>
            <marker id="msg-arrow-problem" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" className="fill-red-500 dark:fill-red-400" />
            </marker>
          </defs>
          {layout.columns.map((column) => (
            <g
              key={column.id}
              data-map-place={column.id}
              className={`transition-opacity duration-150 motion-reduce:transition-none ${dimmed(column.id) ? "opacity-35" : ""}`}
            >
              <rect
                x={column.x}
                y={PAD}
                width={COL_W}
                height={layout.columnHeight}
                rx={14}
                className={column.id === "?" ? "fill-amber-400/[0.07]" : "fill-content/[0.04]"}
              />
              <text x={column.x + 14} y={PAD + 21} className="fill-content text-[12.5px] font-semibold">
                {clip(column.title, 26)}
              </text>
              <text x={column.x + 14} y={PAD + 37} className="fill-content/50 text-[11px]">
                {clip(column.sub || `${column.nodes.length} session${column.nodes.length === 1 ? "" : "s"}`, 32)}
              </text>
              {column.nodes.length === 0 ? (
                <text x={column.x + 14} y={PAD + HEADER + 22} className="fill-content/40 text-[11.5px]">
                  No sessions in this window
                </text>
              ) : null}
            </g>
          ))}
          {layout.edges.map(({ edge, d, width }) => {
            const problem = edge.problems > 0;
            const touches = partyKey === null || edge.from === partyKey || edge.to === partyKey;
            const faded = !touches || (dimmed(placeOf(edge.from)) && dimmed(placeOf(edge.to)));
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                data-map-edge=""
                d={d}
                fill="none"
                strokeWidth={width}
                strokeLinecap="round"
                markerEnd={problem ? "url(#msg-arrow-problem)" : "url(#msg-arrow)"}
                className={`transition-opacity duration-150 motion-reduce:transition-none ${
                  problem ? "stroke-red-500/80 dark:stroke-red-400/85" : "stroke-content/28"
                } ${faded ? "opacity-20" : ""}`}
              >
                <title>
                  {`${edge.count} message${edge.count === 1 ? "" : "s"}${
                    problem ? `, ${edge.problems} with a problem` : ""
                  }`}
                </title>
              </path>
            );
          })}
          {layout.columns.flatMap((column) =>
            column.nodes.map((node) => {
              const spot = layout.spots.get(node.key)!;
              const picked = node.key === partyKey;
              const counts = node.sent || node.received ? `${node.sent} sent, ${node.received} in` : "No messages";
              return (
                <g
                  key={node.key}
                  role="button"
                  tabIndex={0}
                  data-map-node={node.key}
                  aria-label={`${node.label}: ${node.sent} sent, ${node.received} received${
                    node.problems ? `, ${node.problems} with a problem` : ""
                  }${node.live ? ", running" : ""}. Show its messages`}
                  aria-pressed={picked}
                  onClick={() => onPick(node.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onPick(node.key);
                    }
                  }}
                  className={`group cursor-pointer outline-none transition-opacity duration-150 motion-reduce:transition-none ${
                    dimmed(column.id) ? "opacity-35" : ""
                  }`}
                >
                  <rect
                    x={spot.x}
                    y={spot.y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    className={`${
                      picked ? "fill-accent/20" : "fill-background-base group-hover:fill-selection-hover"
                    } group-focus-visible:stroke-accent group-focus-visible:[stroke-width:2]`}
                  />
                  <circle
                    cx={spot.x + 14}
                    cy={spot.y + 15}
                    r={3.5}
                    className={node.live ? "fill-emerald-500 dark:fill-emerald-400" : "fill-content/20"}
                  >
                    <title>{node.live ? "Running now" : "Not running"}</title>
                  </circle>
                  <text x={spot.x + 25} y={spot.y + 19} className="fill-content text-[12px] font-medium">
                    {clip(node.label, node.problems ? 19 : 23)}
                  </text>
                  <text x={spot.x + 25} y={spot.y + 33} className="fill-content/50 text-[10.5px] tabular-nums">
                    {clip(node.project && node.project !== node.label ? `${counts} · ${node.project}` : counts, 30)}
                  </text>
                  {node.problems ? (
                    <>
                      <rect
                        x={spot.x + NODE_W - 30}
                        y={spot.y + 8}
                        width={22}
                        height={15}
                        rx={7.5}
                        className="fill-red-500/15 dark:fill-red-400/20"
                      />
                      <text
                        x={spot.x + NODE_W - 19}
                        y={spot.y + 19}
                        textAnchor="middle"
                        className="fill-red-600 text-[10px] font-semibold tabular-nums dark:fill-red-300"
                      >
                        {node.problems > 99 ? "99+" : node.problems}
                      </text>
                    </>
                  ) : null}
                </g>
              );
            }),
          )}
        </svg>
      </div>
      <p className="px-1 text-[11.5px] text-content/45">
        Thicker curves carried more messages; red ones had a problem. Click a session to see its messages.
      </p>
    </div>
  );
}
