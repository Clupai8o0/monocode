import {
  contextPercent,
  contextRatio,
  formatTokens,
  type ContextUsage,
} from "../../features/sessions/model/contextUsage";

/** Fork feature: "143K · 14%" beside the composer's context ring. */
export function ContextLabel({ usage }: { usage?: ContextUsage }) {
  const percent = contextPercent(usage);
  const ratio = contextRatio(usage);
  if (!usage || percent === null || ratio === null) return null;
  // Same thresholds as the ring, so the two never disagree.
  const tone =
    ratio >= 0.9
      ? "text-red-400"
      : ratio >= 0.75
        ? "text-amber-400"
        : "text-content/45";
  return (
    <span
      aria-hidden
      className={`mr-1.5 font-mono text-[11px] tabular-nums ${tone}`}
    >
      {formatTokens(usage.used)} · {percent}%
    </span>
  );
}
