import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import { ArchiveDown } from "../../shared/ui/icons";
import {
  cachedCloseState,
  closeStatesVersion,
  requestCloseState,
  subscribeCloseStates,
} from "../closeBadges/closeState";
import { cleanupCandidates, readyToClose } from "./cleanupModel";
import {
  cachedCleanupRows,
  cleanupRowsVersion,
  requestCleanupScan,
  subscribeCleanupRows,
} from "./cleanupRows";
import { SessionCleanup } from "./SessionCleanup";

/** Starting up has enough to do; the count can wait a moment. */
const FIRST_SCAN_DELAY_MS = 4_000;
const RESCAN_EVERY_MS = 5 * 60_000;

/**
 * Fork feature: the title bar's way into "Clean up sessions". One click opens
 * it, and the count says how many sessions, across every project, have said
 * they can close, so there is a reason to click before opening anything.
 */
export const CleanUpSessionsButton = memo(function CleanUpSessionsButton({
  projectPaths,
  activeSessionId,
  busySessionIds,
  approvalSessionIds,
  openSessionIds,
  onArchive,
  onDelete,
  onOpenSession,
}: {
  projectPaths: readonly string[];
  activeSessionId?: string;
  busySessionIds: ReadonlySet<string>;
  approvalSessionIds: ReadonlySet<string>;
  openSessionIds: readonly string[];
  onArchive: (
    sessionId: string,
    archived: boolean,
  ) => void | Promise<boolean>;
  onDelete?: (row: SessionSummary) => Promise<boolean>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useSyncExternalStore(
    subscribeCleanupRows,
    cleanupRowsVersion,
    cleanupRowsVersion,
  );
  useSyncExternalStore(
    subscribeCloseStates,
    closeStatesVersion,
    closeStatesVersion,
  );

  const pathsKey = projectPaths.join("\n");
  const paths = useRef(projectPaths);
  paths.current = projectPaths;
  useEffect(() => {
    const scan = () => requestCleanupScan(paths.current);
    const first = setTimeout(
      () => requestCleanupScan(paths.current, { now: true }),
      FIRST_SCAN_DELAY_MS,
    );
    const every = setInterval(scan, RESCAN_EVERY_MS);
    window.addEventListener("focus", scan);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      window.removeEventListener("focus", scan);
    };
  }, [pathsKey]);

  // A session that just stopped working is the likeliest to be ready to close.
  const busyKey = [...busySessionIds].sort().join(",");
  const lastBusyKey = useRef(busyKey);
  useEffect(() => {
    if (lastBusyKey.current !== busyKey) {
      lastBusyKey.current = busyKey;
      requestCleanupScan(paths.current);
    }
  }, [busyKey]);

  const candidates = cleanupCandidates(cachedCleanupRows(projectPaths), {
    activeSessionId,
    busy: busySessionIds,
    approval: approvalSessionIds,
  });
  const checkKey = candidates.map((c) => `${c.id}@${c.updatedAt}`).join(",");
  const latestCandidates = useRef(candidates);
  latestCandidates.current = candidates;
  useEffect(() => {
    for (const candidate of latestCandidates.current) {
      requestCloseState(candidate.id, candidate.updatedAt);
    }
  }, [checkKey]);

  const ready = readyToClose(
    candidates.map((c) => cachedCloseState(c.id, c.updatedAt)?.kind),
  );
  const label =
    ready > 0
      ? `Clean up sessions, ${ready} ready to close`
      : "Clean up sessions";

  return (
    <>
      <button
        type="button"
        data-tauri-drag-region="false"
        data-fork-clean-up-sessions=""
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 hover:bg-content/10 ${open ? "text-content" : "text-content/45 hover:text-content"}`}
      >
        <ArchiveDown className="size-3.5" strokeWidth={1.75} aria-hidden />
        {ready > 0 ? (
          <span
            aria-hidden
            className="text-[11px] font-semibold tabular-nums"
          >
            {ready > 99 ? "99+" : ready}
          </span>
        ) : null}
      </button>
      {open ? (
        <SessionCleanup
          projectPaths={projectPaths}
          activeSessionId={activeSessionId}
          busySessionIds={busySessionIds}
          approvalSessionIds={approvalSessionIds}
          openSessionIds={openSessionIds}
          onArchive={onArchive}
          onDelete={onDelete}
          onOpenSession={onOpenSession}
          onClose={() => {
            setOpen(false);
            requestCleanupScan(paths.current, { now: true });
          }}
        />
      ) : null}
    </>
  );
});
