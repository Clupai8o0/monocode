import {
  formatBytes,
  stateLabel,
  type MemoryPressure,
  type MemoryReport,
  type MemoryRow,
  type Suggestion,
} from "./memoryModel";
import { CircleAlert } from "../../shared/ui/icons";
import type { ParkedSession } from "./memoryStore";

export const PRESSURE_DOT: Record<MemoryPressure, string> = {
  normal: "bg-emerald-500",
  warn: "bg-amber-400",
  critical: "bg-red-500",
};

export const PRESSURE_TEXT: Record<MemoryPressure, string> = {
  normal: "Memory is fine",
  warn: "Memory is getting tight",
  critical: "Memory is very tight",
};

type Props = {
  report: MemoryReport;
  rows: readonly MemoryRow[];
  /** What the sessions hold between them, in bytes. */
  total: number;
  suggestion: Suggestion;
  parked: readonly ParkedSession[];
  parking: ReadonlySet<string>;
  error?: string;
  onPark: (row: MemoryRow) => void;
  onParkSuggested: () => void;
  /** Set while the machine is under pressure: what is high, in plain words. */
  pressureReasons?: readonly string[];
  onReviewWork?: () => void;
};

const parkButton =
  "shrink-0 rounded-md bg-content/6 px-2 py-0.5 text-[11px] font-medium text-content/70 transition-colors hover:bg-content/12 hover:text-content disabled:opacity-40 disabled:hover:bg-content/6";

/**
 * Fork: the Memory popover. Sessions by RAM, a Park for each idle one, the
 * suggested set under pressure, and the sessions parked so far.
 */
export function MemoryPanel({
  report,
  rows,
  total,
  suggestion,
  parked,
  parking,
  error,
  onPark,
  onParkSuggested,
  pressureReasons,
  onReviewWork,
}: Props) {
  const available =
    report.totalBytes > 0
      ? `${formatBytes(report.availableBytes)} free of ${formatBytes(report.totalBytes)}`
      : "";
  return (
    <div className="flex flex-col gap-3 p-3 text-[12px]" aria-label="Memory">
      {pressureReasons?.length ? (
        <ReviewWorkRow reasons={pressureReasons} onReviewWork={onReviewWork} />
      ) : null}
      <div className="flex items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${PRESSURE_DOT[report.pressure]}`}
          aria-hidden
        />
        <span className="font-semibold text-content">
          {PRESSURE_TEXT[report.pressure]}
        </span>
        <span className="ml-auto tabular-nums text-content/45">{available}</span>
      </div>
      {total > 0 ? (
        <p data-fork-memory-total="" className="-mt-2 tabular-nums text-content/55">
          Memory · {formatBytes(total)}
        </p>
      ) : null}

      {suggestion.rows.length > 0 ? (
        <button
          type="button"
          className="rounded-lg bg-accent/15 px-3 py-1.5 text-left text-[12px] font-medium text-content transition-colors hover:bg-accent/25 disabled:opacity-50"
          disabled={suggestion.rows.some((row) => parking.has(row.sessionId))}
          onClick={onParkSuggested}
        >
          Park suggested ({suggestion.rows.length}, frees ~
          {formatBytes(suggestion.freedBytes)})
        </button>
      ) : null}

      {error ? (
        <p role="alert" className="text-[11px] text-red-500 dark:text-red-400" title={error}>
          Couldn't read memory use. Trying again…
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="py-2 text-content/50">No agent is running right now.</p>
      ) : (
        <ul aria-label="Sessions by memory" className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <li
              key={row.sessionId}
              data-memory-session={row.sessionId}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-content/4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-content" title={row.title}>
                  {row.title}
                </p>
                <p className="truncate text-[11px] tabular-nums text-content/45">
                  {formatBytes(row.rssBytes)}
                  {row.processCount > 1 ? ` · ${row.processCount} processes` : ""}
                  {" · "}
                  {stateLabel(row)}
                </p>
              </div>
              {row.parkable ? (
                <button
                  type="button"
                  className={parkButton}
                  aria-label={`Park ${row.title}`}
                  title="Stop its agent to free memory; the conversation stays and picks up where it left off"
                  disabled={parking.has(row.sessionId)}
                  onClick={() => onPark(row)}
                >
                  {parking.has(row.sessionId) ? "Parking…" : "Park"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {parked.length > 0 ? (
        <ul aria-label="Parked sessions" className="flex flex-col gap-0.5">
          {parked.map((entry) => (
            <li key={entry.sessionId} className="px-1.5 py-1">
              <p className="truncate text-content/60" title={entry.title}>
                {entry.title}
              </p>
              <p className="text-[11px] text-content/40">
                Parked — wakes on your next message
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-[11px] leading-relaxed text-content/40">
        Parking keeps the conversation. Your next message picks it up again.
      </p>
    </div>
  );
}

export function ReviewWorkRow({
  reasons,
  onReviewWork,
}: {
  reasons: readonly string[];
  onReviewWork?: () => void;
}) {
  return (
    <button
      type="button"
      data-fork-review-work=""
      className="flex items-center gap-2 rounded-lg bg-amber-500/12 px-3 py-1.5 text-left text-[12px] text-content transition-colors hover:bg-amber-500/20"
      onClick={onReviewWork}
    >
      <CircleAlert
        className="size-3.5 shrink-0 text-amber-500 dark:text-amber-400"
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="min-w-0">{reasons.join(" · ")} · Review running work</span>
    </button>
  );
}
