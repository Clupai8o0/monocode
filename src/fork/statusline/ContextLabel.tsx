import {
  contextPercent,
  contextRatio,
  formatTokens,
  type ContextUsage,
} from "../../features/sessions/model/contextUsage";
import { OC } from "./StatusExtras";

/**
 * Fork feature: "143K · 14% · 1 compaction" beside the composer's context
 * ring.
 */
export function ContextLabel({
  usage,
  compactions = 0,
}: {
  usage?: ContextUsage;
  compactions?: number;
}) {
  const percent = contextPercent(usage);
  const ratio = contextRatio(usage);
  if (!usage || percent === null || ratio === null) return null;
  // Same thresholds as the ring, so the two never disagree.
  const tone = ratio >= 0.9 ? OC.error : ratio >= 0.75 ? OC.warning : OC.muted;
  // Past two, a /clear plus a handoff keeps more than another compact.
  const compactTone =
    compactions >= 3 ? OC.error : compactions === 2 ? OC.warning : OC.muted;
  return (
    <span className="mr-1.5 flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums">
      <span aria-hidden className={tone}>
        {formatTokens(usage.used)} · {percent}%
      </span>
      {compactions > 0 ? (
        <span
          className={compactTone}
          title="Times this conversation has been compacted. Past two, a /clear plus a handoff keeps more."
        >
          · {compactions} {compactions === 1 ? "compaction" : "compactions"}
        </span>
      ) : null}
    </span>
  );
}
