import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader } from "../../shared/ui/icons";
import {
  COST_FAMILIES,
  costBars,
  costSummary,
  FAMILY_LABEL,
  formatTokens,
  formatUsd,
  loadCostReport,
  localToday,
  modelLabel,
  type CostBar,
  type CostFamily,
  type CostPeriod,
  type CostReport,
} from "./costModel";
import "./cost.css";

const CHART_HEIGHT = 96;
const swatch = (family: CostFamily | string) =>
  `var(--cost-${COST_FAMILIES.includes(family as CostFamily) ? family : "other"})`;

function Bars({
  bars,
  period,
}: {
  bars: readonly CostBar[];
  period: CostPeriod;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const highest = Math.max(...bars.map((bar) => bar.total), 0);
  const shown = hovered === null ? null : bars[hovered];
  return (
    <div className="relative">
      <div
        role="img"
        aria-label={`Cost per ${period}, highest ${formatUsd(highest)}. The table below has the figures.`}
        className="flex items-end gap-[2px]"
        style={{ height: CHART_HEIGHT }}
        onPointerLeave={() => setHovered(null)}
      >
        {bars.map((bar, index) => (
          <div
            key={bar.date}
            // The whole column answers, so a thin or empty bar is easy to hit.
            onPointerEnter={() => setHovered(index)}
            className={`flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px] rounded-[4px] ${
              hovered === index ? "bg-content/[0.05]" : ""
            }`}
          >
            {bar.total === 0 ? (
              <div className="h-[2px] rounded-full bg-content/10" />
            ) : (
              [...bar.segments].reverse().map((segment, position) => (
                <div
                  key={segment.family}
                  style={{
                    height: Math.max(
                      2,
                      (segment.usd / highest) * CHART_HEIGHT -
                        (bar.segments.length > 1 ? 2 : 0),
                    ),
                    backgroundColor: swatch(segment.family),
                  }}
                  className={position === 0 ? "rounded-t-[4px]" : ""}
                />
              ))
            )}
          </div>
        ))}
      </div>
      {shown ? (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 w-44 rounded-lg bg-background-base px-2.5 py-2 text-[11px] shadow-[0_6px_20px_-8px_rgb(0_0_0/0.5)]"
          style={
            hovered! > bars.length / 2 ? { left: 0 } : { right: 0 }
          }
        >
          <p className="font-medium text-content">{shown.label}</p>
          {shown.segments.map((segment) => (
            <p key={segment.family} className="mt-0.5 flex items-center gap-1.5 text-content/65">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: swatch(segment.family) }}
              />
              <span className="flex-1">{FAMILY_LABEL[segment.family]}</span>
              <span className="tabular-nums text-content">{formatUsd(segment.usd)}</span>
            </p>
          ))}
          <p className="mt-1 flex justify-between text-content/65">
            <span>Total</span>
            <span className="font-medium tabular-nums text-content">{formatUsd(shown.total)}</span>
          </p>
          {shown.saved > 0 ? (
            <p className="flex justify-between text-content/50">
              <span>Saved by cache</span>
              <span className="tabular-nums">{formatUsd(shown.saved)}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-content/40">
        <span>{period === "day" ? bars[0]?.label : bars[0]?.label.split(" to ")[0]}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

/** The panel's body, given a report, so the fixture can show every state. */
export function CostView({
  report,
  today,
}: {
  report: CostReport;
  today: string;
}) {
  const [period, setPeriod] = useState<CostPeriod>("day");
  const summary = useMemo(() => costSummary(report, today), [report, today]);
  const bars = useMemo(() => costBars(report, period, today), [period, report, today]);
  const present = COST_FAMILIES.filter((family) =>
    bars.some((bar) => bar.segments.some((segment) => segment.family === family)),
  );
  const accounts = Object.entries(report.accounts).sort((a, b) => b[1] - a[1]);
  const change =
    summary.change === null
      ? null
      : `${summary.change >= 0 ? "Up" : "Down"} ${Math.abs(Math.round(summary.change * 100))}% on the week before`;

  if (report.models.length === 0 && report.unpriced.length === 0) {
    return (
      <p className="py-6 text-center text-[12px] text-content/50">
        No Claude usage in the last eight weeks.
      </p>
    );
  }
  return (
    <div className="fork-cost flex flex-col gap-3 font-sans">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-content/50">Last 7 days, at API prices</p>
          <p className="mt-0.5 text-[32px] font-semibold leading-none tracking-[-0.02em] text-content">
            {formatUsd(summary.usd)}
          </p>
          {change ? <p className="mt-1 text-[11px] text-content/50">{change}</p> : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] text-content/50">Saved by cache</p>
          <p className="mt-0.5 text-[16px] font-medium leading-tight tabular-nums text-content">
            {formatUsd(summary.saved)}
          </p>
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <div role="tablist" aria-label="Group by" className="flex gap-0.5">
            {(["day", "week"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                role="tab"
                aria-selected={period === choice}
                onClick={() => setPeriod(choice)}
                className={`h-5 rounded px-1.5 text-[11px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent ${
                  period === choice
                    ? "bg-content/10 font-medium text-content"
                    : "text-content/50 hover:text-content"
                }`}
              >
                {choice === "day" ? "Daily" : "Weekly"}
              </button>
            ))}
          </div>
          {present.length > 1 ? (
            <ul className="ml-auto flex flex-wrap justify-end gap-x-2 text-[10px] text-content/60">
              {present.map((family) => (
                <li key={family} className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="size-2 rounded-[2px]"
                    style={{ backgroundColor: swatch(family) }}
                  />
                  {FAMILY_LABEL[family]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Bars bars={bars} period={period} />
      </div>

      <table className="w-full text-[11px]">
        <caption className="sr-only">Cost per model over the last eight weeks</caption>
        <thead className="text-content/40">
          <tr>
            <th scope="col" className="pb-0.5 text-left font-normal">Model, 8 weeks</th>
            <th scope="col" className="pb-0.5 text-right font-normal">Output</th>
            <th scope="col" className="pb-0.5 text-right font-normal">Saved</th>
            <th scope="col" className="pb-0.5 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody className="text-content/75">
          {report.models.map((row) => (
            <tr key={row.model}>
              <td className="py-px">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: swatch(row.family) }}
                  />
                  {modelLabel(row.model)}
                </span>
              </td>
              <td className="py-px text-right tabular-nums text-content/50">{formatTokens(row.outputTokens)}</td>
              <td className="py-px text-right tabular-nums text-content/50">{formatUsd(row.savedUsd)}</td>
              <td className="py-px text-right font-medium tabular-nums text-content">{formatUsd(row.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {accounts.length > 1 ? (
        <p className="text-[11px] text-content/50">
          By account:{" "}
          {accounts.map(([name, usd]) => `${name} ${formatUsd(usd)}`).join(", ")}
        </p>
      ) : null}
      <p className="text-[11px] leading-relaxed text-content/40 [text-wrap:pretty]">
        What this use would cost on the API, read from this computer&apos;s Claude
        transcripts. Your plan doesn&apos;t bill this amount.
        {report.unpriced.length
          ? ` Not counted, no known price: ${report.unpriced.join(", ")}.`
          : ""}
        {report.unreadable
          ? ` ${report.unreadable} transcript ${report.unreadable === 1 ? "file" : "files"} couldn't be read, so the real figure may be higher.`
          : ""}
      </p>
    </div>
  );
}

/** Fork: the footer All panel's Cost tab. Reads the transcripts when opened. */
export function CostPanel() {
  const [report, setReport] = useState<CostReport | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    setError(undefined);
    loadCostReport()
      .then(setReport)
      .catch((failure) => setError(String(failure)));
  }, []);
  useEffect(load, [load]);
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center text-[12px] text-content/55">
        <AlertCircle className="size-4 text-diff-del-fg" aria-hidden />
        <p>Couldn&apos;t read the transcripts: {error}</p>
        <button
          type="button"
          onClick={load}
          className="rounded-md bg-content/10 px-2 py-1 text-content hover:bg-content/15"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="grid place-items-center gap-2 py-8 text-[12px] text-content/45">
        <Loader className="size-4 animate-spin" aria-hidden />
        Reading transcripts
      </div>
    );
  }
  return <CostView report={report} today={localToday()} />;
}
