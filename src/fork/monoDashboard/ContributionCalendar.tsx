import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatInteger } from "../../shared/lib/numbers";
import {
  dayCount,
  dayLevels,
  weeksThatFit,
  type ContributionDay,
} from "./dashboardModel";

/** Each day is a square of 4×4 dither cells, a cell apart. */
const CELL = 2;
const SQUARE = 4 * CELL;
const PITCH = 5 * CELL;
const GUTTER = 28;
const MONTHS = 18;
const LEGEND = 22;
const GRID_HEIGHT = 7 * PITCH - CELL;
const MIN_MONTH_GAP = 30;
/** Room a three-letter month needs, so the last one isn't cut off. */
const MONTH_WIDTH = 20;

/** Ordered dither: which cells ink first as a day's tone rises. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** The inked cells of a square at each level, a quarter of them up to all. */
const LEVEL_PATHS = [0, 0.25, 0.5, 0.75, 1].map((tone) => {
  let path = "";
  BAYER.forEach((row, y) =>
    row.forEach((rank, x) => {
      if (rank < tone * 16) {
        path += `M${x * CELL} ${y * CELL}h${CELL}v${CELL}h-${CELL}z`;
      }
    }),
  );
  return path;
});

function parseDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dayTitle(date: string): string {
  return parseDay(date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function daySummary(day: ContributionDay): [string, string][] {
  if (dayCount(day) === 0) return [["Contributions", "None"]];
  const rows: [string, number][] = [
    ["Commits", day.commits],
    ["Reviews", day.reviews],
    ["PRs opened", day.opened],
    ["PRs merged", day.merged],
  ];
  return [
    ...rows
      .filter(([, count]) => count > 0)
      .map(([name, count]): [string, string] => [name, String(count)]),
    [
      "Lines",
      `+${formatInteger(day.additions)} −${formatInteger(day.deletions)}`,
    ],
  ];
}

function Square({
  x,
  y,
  level,
  color,
}: {
  x: number;
  y: number;
  level: number;
  color: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={SQUARE} height={SQUARE} className="fill-content/8" />
      {level > 0 ? <path d={LEVEL_PATHS[level]} fill={color} /> : null}
    </g>
  );
}

/**
 * A Mono's contributions: weeks as columns, Sunday to Saturday down, each day
 * a dithered square in the Mono's colour. A narrow panel keeps the latest weeks.
 */
export function ContributionCalendar({
  days,
  color,
}: {
  days: readonly ContributionDay[];
  color: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [hovered, setHovered] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const levels = useMemo(() => dayLevels(days), [days]);
  const totalWeeks = Math.ceil(days.length / 7);
  const fits = weeksThatFit(width - GUTTER, PITCH, SQUARE, totalWeeks);
  const skip = totalWeeks - fits;
  const dayAt = (column: number, row: number) => {
    const index = (column + skip) * 7 + row;
    return row < 7 && index < days.length ? index : null;
  };

  // A month is named over the first week that starts in it.
  const months = useMemo(() => {
    const labels: { x: number; text: string }[] = [];
    let lastX = Number.NEGATIVE_INFINITY;
    for (let column = 0; column < fits; column += 1) {
      const date = parseDay(days[(column + skip) * 7].date);
      const x = column * PITCH;
      if (
        (column !== 0 && date.getDate() > 7) ||
        x - lastX < MIN_MONTH_GAP ||
        GUTTER + x + MONTH_WIDTH > width
      ) {
        continue;
      }
      lastX = x;
      labels.push({
        x,
        text: date.toLocaleDateString(undefined, { month: "short" }),
      });
    }
    return labels;
  }, [days, fits, skip, width]);

  const height = MONTHS + GRID_HEIGHT + LEGEND;
  const right = GUTTER + fits * PITCH - CELL;
  const legendY = MONTHS + GRID_HEIGHT + 10;
  const shown = hovered != null ? days[hovered] : undefined;
  const active = days.filter((day) => dayCount(day) > 0);
  const tooltipLeft =
    hovered != null && Math.floor(hovered / 7) - skip > fits / 2;

  return (
    <div ref={frame} className="relative w-full" data-mono-calendar>
      <svg
        role="img"
        aria-label={`Contribution calendar, ${active.length} active days`}
        width="100%"
        height={height}
        shapeRendering="crispEdges"
        onPointerLeave={() => setHovered(null)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - box.left - GUTTER;
          const y = event.clientY - box.top - MONTHS;
          const column = Math.floor(x / PITCH);
          const row = Math.floor(y / PITCH);
          setHovered(
            x >= 0 && y >= 0 && column < fits ? dayAt(column, row) : null,
          );
        }}
      >
        {[
          [1, "Mon"],
          [3, "Wed"],
          [5, "Fri"],
        ].map(([row, name]) => (
          <text
            key={name}
            x={0}
            y={MONTHS + (row as number) * PITCH + SQUARE / 2}
            dominantBaseline="central"
            className="fill-content/45 font-mono text-[10px]"
          >
            {name}
          </text>
        ))}
        {months.map((month) => (
          <text
            key={`${month.text}:${month.x}`}
            x={GUTTER + month.x}
            y={MONTHS / 2}
            dominantBaseline="central"
            className="fill-content/45 font-mono text-[10px]"
          >
            {month.text}
          </text>
        ))}
        {Array.from({ length: fits }, (_, column) =>
          Array.from({ length: 7 }, (_, row) => {
            const index = dayAt(column, row);
            if (index == null) return null;
            return (
              <Square
                key={index}
                x={GUTTER + column * PITCH}
                y={MONTHS + row * PITCH}
                level={levels[index]}
                color={color}
              />
            );
          }),
        )}
        <text
          x={right}
          y={legendY + SQUARE / 2}
          textAnchor="end"
          dominantBaseline="central"
          className="fill-content/40 font-mono text-[10px]"
        >
          More
        </text>
        {[0, 1, 2, 3, 4].map((level) => (
          <Square
            key={level}
            x={right - 30 - (5 - level) * PITCH}
            y={legendY}
            level={level}
            color={color}
          />
        ))}
        <text
          x={right - 30 - 5 * PITCH - 6}
          y={legendY + SQUARE / 2}
          textAnchor="end"
          dominantBaseline="central"
          className="fill-content/40 font-mono text-[10px]"
        >
          Less
        </text>
      </svg>
      {shown ? (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 w-40 rounded-lg bg-background-base px-2.5 py-2 text-[11px] shadow-[0_6px_20px_-8px_rgb(0_0_0/0.5)]"
          style={tooltipLeft ? { left: 0 } : { right: 0 }}
        >
          <p className="font-medium text-content">{dayTitle(shown.date)}</p>
          {daySummary(shown).map(([name, value]) => (
            <p
              key={name}
              className="mt-0.5 flex justify-between gap-2 text-content/65"
            >
              <span>{name}</span>
              <span className="tabular-nums text-content/85">{value}</span>
            </p>
          ))}
        </div>
      ) : null}
      {/* The same days for a screen reader, which can't hover a square. */}
      <ul className="sr-only">
        {active.map((day) => (
          <li key={day.date}>
            {dayTitle(day.date)}:{" "}
            {daySummary(day)
              .map(([name, value]) => `${name} ${value}`)
              .join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
