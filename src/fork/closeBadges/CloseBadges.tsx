import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckCheck } from "../../shared/ui/icons";
import {
  cachedCloseState,
  closeStatesVersion,
  requestCloseState,
  subscribeCloseStates,
  type CloseKind,
} from "./closeState";

const LOOK: Record<CloseKind, { label: string; className: string }> = {
  safe: { label: "Safe", className: "bg-emerald-400/15 text-emerald-300" },
  handover: { label: "Handover", className: "bg-amber-400/15 text-amber-300" },
  unsafe: { label: "Not safe", className: "bg-red-400/15 text-red-300" },
};

function useCloseStatesVersion(): number {
  return useSyncExternalStore(
    subscribeCloseStates,
    closeStatesVersion,
    closeStatesVersion,
  );
}

/**
 * A session card's close badge, from the "Close:" line of its last reply.
 * Nothing shows while it works or waits on you: the card already says so.
 */
export function CloseBadge({
  sessionId,
  updatedAt,
  idle,
}: {
  sessionId: string;
  updatedAt: number;
  idle: boolean;
}) {
  useCloseStatesVersion();
  useEffect(() => {
    if (idle) {
      requestCloseState(sessionId, updatedAt);
    }
  }, [sessionId, updatedAt, idle]);
  if (!idle) {
    return null;
  }
  const state = cachedCloseState(sessionId, updatedAt);
  if (!state) {
    return null;
  }
  const look = LOOK[state.kind];
  const tip = state.detail ? `${look.label}: ${state.detail}` : `${look.label} to close`;
  return (
    <span
      data-fork-close={state.kind}
      title={tip}
      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold leading-4 ${look.className}`}
    >
      {look.label}
    </span>
  );
}

export type CloseCandidate = { id: string; updatedAt: number };

/** The candidates whose last reply said "Safe to close" and nothing since. */
export function safeToClose(candidates: readonly CloseCandidate[]): string[] {
  return candidates
    .filter((c) => cachedCloseState(c.id, c.updatedAt)?.kind === "safe")
    .map((c) => c.id);
}

/**
 * Archives every listed session that is safe to close. The first click asks;
 * a second within a few seconds closes them.
 */
export function CloseAllSafeButton({
  candidates,
  onArchive,
}: {
  candidates: readonly CloseCandidate[];
  onArchive: (sessionIds: string[]) => void;
}) {
  useCloseStatesVersion();
  const [asking, setAsking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  // Sessions below the loaded page have no card asking for their state. Keyed
  // by content, since the caller builds a new list on every render.
  const key = candidates.map((c) => `${c.id}@${c.updatedAt}`).join(",");
  const latest = useRef(candidates);
  latest.current = candidates;
  useEffect(() => {
    for (const c of latest.current) {
      requestCloseState(c.id, c.updatedAt);
    }
  }, [key]);
  const ids = safeToClose(candidates);
  if (ids.length === 0) {
    return null;
  }
  const label = asking
    ? `Close ${ids.length} safe ${ids.length === 1 ? "session" : "sessions"}`
    : `Close all safe sessions (${ids.length})`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-fork-close-all={asking ? "asking" : "idle"}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        if (asking) {
          setAsking(false);
          onArchive(ids);
          return;
        }
        setAsking(true);
        timer.current = setTimeout(() => setAsking(false), 4000);
      }}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold tabular-nums ${
        asking
          ? "bg-emerald-400 text-black"
          : "text-emerald-300 hover:bg-emerald-400/15"
      }`}
    >
      <CheckCheck className="size-3" strokeWidth={2} aria-hidden="true" />
      <span>{asking ? `Close ${ids.length}?` : ids.length}</span>
    </button>
  );
}
