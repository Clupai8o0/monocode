import { useEffect, useSyncExternalStore } from "react";
import { Mail, Send } from "../../shared/ui/icons";
import { formatPeerTime } from "./peerMessage";
import {
  cachedPeerStats,
  markPeerSeen,
  peerStatsVersion,
  requestPeerStats,
  seenCount,
  sentTooltip,
  subscribePeerStats,
  unread,
  unreadTooltip,
} from "./peerStats";

/**
 * Fork: a session card's message badge. Mail + count for messages other
 * sessions sent in since the card was last open (amber when one says
 * urgent), and a quiet arrow + count for the messages this session sent.
 * Opening the session clears the unread count.
 */
export function PeerBadge({
  sessionId,
  updatedAt,
  busy,
  open,
}: {
  sessionId: string;
  updatedAt: number;
  busy: boolean;
  /** The session is on screen: its messages count as read. */
  open: boolean;
}) {
  useSyncExternalStore(subscribePeerStats, peerStatsVersion, peerStatsVersion);
  useEffect(() => {
    requestPeerStats(sessionId, updatedAt, busy);
  }, [sessionId, updatedAt, busy]);
  const stats = cachedPeerStats(sessionId);
  const total = stats?.incoming.length ?? 0;
  useEffect(() => {
    if (open) {
      markPeerSeen(sessionId);
    }
  }, [open, sessionId, total]);
  if (!stats) {
    return null;
  }
  const fresh = open ? [] : unread(stats, seenCount(sessionId));
  const sent = stats.outgoing.length;
  if (fresh.length === 0 && sent === 0) {
    return null;
  }
  const urgent = fresh.some((m) => m.urgent);
  const inTip = fresh.length ? unreadTooltip(fresh, formatPeerTime) : "";
  const outTip = sent ? sentTooltip(stats.outgoing) : "";
  return (
    <span
      data-fork-peer-badge
      className="flex shrink-0 items-center gap-1 text-[10px] font-semibold tabular-nums leading-4"
    >
      {fresh.length ? (
        <span
          title={inTip}
          aria-label={inTip}
          data-urgent={urgent ? "true" : undefined}
          className={`flex items-center gap-0.5 rounded px-1 py-px ${
            urgent
              ? "bg-amber-400/15 text-amber-700 dark:text-amber-300"
              : "bg-content/10 text-content/80"
          }`}
        >
          <Mail className="size-2.5" strokeWidth={2} aria-hidden="true" />
          {fresh.length}
        </span>
      ) : null}
      {sent ? (
        <span
          title={outTip}
          aria-label={outTip}
          className="flex items-center gap-0.5 px-0.5 text-content/45"
        >
          <Send className="size-2.5" strokeWidth={2} aria-hidden="true" />
          {sent}
        </span>
      ) : null}
    </span>
  );
}
