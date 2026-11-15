import { useEffect, useState, useSyncExternalStore } from "react";
import { formatTokens } from "../../features/sessions/model/contextUsage";
import type { Session } from "../../features/sessions/model/session";
import {
  cacheExpiresAt,
  idleCompactVersion,
  isKeepingHistory,
  setKeepHistory,
  showCompactChip,
  subscribeIdleCompact,
} from "./idleCompact";

/** Fork: beside Send on a big Claude thread whose cache has run out. */
export function IdleCompactChip({ session }: { session: Session }) {
  useSyncExternalStore(subscribeIdleCompact, idleCompactVersion);
  const [now, setNow] = useState(() => Date.now());
  const expires = cacheExpiresAt(session);

  // Appear the moment the cache runs out, without waiting for another render.
  useEffect(() => {
    setNow(Date.now());
    if (expires == null) return;
    const wait = expires - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [expires]);

  if (!showCompactChip(session, now)) return null;
  const keep = isKeepingHistory(session.id);
  const tokens = formatTokens(session.context?.used ?? 0);
  const title = keep
    ? `This message goes with the full ${tokens}-token history, read again at full price. Click to summarise first.`
    : `Claude's cache for this thread ran out, so the next message would re-read all ${tokens} tokens at full price. Send summarises the history first, so this and later turns read much less. Click to keep the full history for this message.`;

  return (
    <button
      type="button"
      data-idle-compact={keep ? "keep" : "compact"}
      title={title}
      aria-label={keep ? `Keep full history, ${tokens} tokens` : `Compact before sending, ${tokens} tokens`}
      aria-pressed={!keep}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setKeepHistory(session.id, !keep)}
      className={`flex h-6.5 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium tabular-nums transition-[background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        keep
          ? "bg-content/[0.06] text-content/60 hover:bg-content/10 hover:text-content/80"
          : "bg-accent/12 text-accent hover:bg-accent/18"
      }`}
    >
      <span>{keep ? "Keep" : "Compact"}</span>
      <span className="opacity-60">{tokens}</span>
    </button>
  );
}
