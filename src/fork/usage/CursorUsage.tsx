import { useEffect } from "react";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { useShowRemainingUsage } from "../../features/settings/model/displayPrefs";
import { formatResetDuration } from "../../features/providers/model/rateLimits";
import { barClass } from "../../features/providers/ui/ProviderAccountUsage";
import { loadExtraUsage, useExtraUsage, type UsageBar } from "./extraUsage";

/**
 * Fork: Cursor plan meters in the session footer. Auto is first-party models;
 * API is third-party spend against the same Cursor account.
 */
export function CursorUsage({
  now,
  className,
}: {
  now: number;
  className: string;
}) {
  const usage = useExtraUsage("cursor");
  useEffect(() => {
    void loadExtraUsage("cursor");
  }, []);
  const showRemaining = useShowRemainingUsage();
  const bars = usage.status === "ok" ? usage.bars : [];
  const title =
    usage.status === "ok"
      ? (usage.detail ?? "Cursor plan usage")
      : usage.status === "unavailable" || usage.status === "error"
        ? usage.message
        : "Loading Cursor usage…";
  return (
    <span className={`${className} max-w-none`} title={title}>
      <HarnessIcon harness="cursor" className="size-3 shrink-0" />
      <span className="shrink-0">Cursor</span>
      {bars.length > 0 ? (
        <CursorBars bars={bars} now={now} showRemaining={showRemaining} />
      ) : (
        <span className="truncate text-content/45">
          {usage.status === "unavailable" || usage.status === "error"
            ? usage.message
            : "…"}
        </span>
      )}
    </span>
  );
}

function CursorBars({
  bars,
  now,
  showRemaining,
}: {
  bars: UsageBar[];
  now: number;
  showRemaining: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
      {bars.map((bar, index) => {
        const used = Math.min(100, Math.max(0, bar.usedPercent));
        const shown = showRemaining ? 100 - used : used;
        return (
          <span key={bar.label} className="inline-flex items-center gap-1">
            {index > 0 ? <span className="text-content/25">·</span> : null}
            <span className="text-content/45">{bar.label}</span>
            <span className="sr-only">
              {Math.round(shown)}% {showRemaining ? "left" : "used"}
            </span>
            <span
              className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-content/10"
              aria-hidden
            >
              <span
                className={`block h-full rounded-full ${barClass(used)}`}
                style={{ width: `${shown}%` }}
              />
            </span>
            {bar.resetsAt != null && bar.resetsAt > now ? (
              <span>{formatResetDuration(bar.resetsAt - now)}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
