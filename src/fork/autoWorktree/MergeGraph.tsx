import type { MergeViewKind } from "./mergeBack";

const WIDTH = 168;
const HEIGHT = 56;
const TOP = 14;
const BOTTOM = 42;
const START = 10;
const END = WIDTH - 12;
const MAX_DOTS = 5;

/** Evenly spaced points between two x positions, leaving room at the ends. */
function dots(count: number, from: number, to: number): number[] {
  const shown = Math.min(count, MAX_DOTS);
  return Array.from(
    { length: shown },
    (_, index) => from + ((to - from) * (index + 1)) / (shown + 1),
  );
}

/**
 * Fork: a small picture of what Merge back will do. The base runs along the
 * bottom, the worktree's commits along the top in the project's colour, and
 * the last dot shows how they come together.
 */
export function MergeGraph({
  kind,
  ahead,
  behind,
  color,
}: {
  kind: MergeViewKind;
  ahead: number;
  behind: number;
  color: string;
}) {
  const forkEnd = START + 26;
  const joinStart = END - 30;
  const joined = kind === "merged";
  const conflict = kind === "conflict";
  const blocked = kind === "uncommitted" || kind === "base-busy" || kind === "nothing";
  const endColor = conflict ? "var(--color-diff-del-fg, #e5484d)" : color;
  return (
    <svg
      data-merge-graph={kind}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${ahead} commits in this worktree, ${behind} new on the base`}
      className="shrink-0"
    >
      <path
        d={`M${START} ${BOTTOM}H${END}`}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d={`M${START} ${BOTTOM}C${START + 14} ${BOTTOM} ${forkEnd - 12} ${TOP} ${forkEnd} ${TOP}H${joinStart}`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d={`M${joinStart} ${TOP}C${joinStart + 14} ${TOP} ${END - 12} ${BOTTOM} ${END} ${BOTTOM}`}
        fill="none"
        stroke={conflict ? endColor : color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={joined ? undefined : "2 5"}
        strokeOpacity={blocked ? 0.35 : 1}
      />
      <circle cx={START} cy={BOTTOM} r={3} fill="currentColor" fillOpacity={0.45} />
      {dots(behind, forkEnd, END - 8).map((x) => (
        <circle key={x} cx={x} cy={BOTTOM} r={3} fill="currentColor" fillOpacity={0.45} />
      ))}
      {dots(ahead, forkEnd - 6, joinStart + 6).map((x) => (
        <circle key={x} cx={x} cy={TOP} r={3.5} fill={color} />
      ))}
      {conflict ? (
        <g stroke={endColor} strokeWidth={2} strokeLinecap="round">
          <path d={`M${END - 4} ${BOTTOM - 4}L${END + 4} ${BOTTOM + 4}`} />
          <path d={`M${END + 4} ${BOTTOM - 4}L${END - 4} ${BOTTOM + 4}`} />
        </g>
      ) : joined ? (
        <circle cx={END} cy={BOTTOM} r={5} fill={color} />
      ) : (
        <circle
          cx={END}
          cy={BOTTOM}
          r={4}
          fill="none"
          stroke={blocked ? "currentColor" : color}
          strokeOpacity={blocked ? 0.35 : 1}
          strokeWidth={2}
        />
      )}
    </svg>
  );
}
