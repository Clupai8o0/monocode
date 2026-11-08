import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  listSessionsByProject,
  type SessionSummary,
} from "../../features/sessions/data/sessionStore";
import { ExternalLink } from "../../shared/ui/icons";
import { sessionDisplayTitle } from "../../features/sessions/model/session";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { prettyCwd, projectName } from "../../shared/lib/paths";
import { Modal } from "../../shared/ui/Modal";
import { SecondaryButton } from "../../shared/ui/SecondaryButton";
import { CloseBadge, keepFromAutoArchive } from "../closeBadges/CloseBadges";
import { sessionHeldElsewhere } from "../workspaces/workspaces";
import {
  cachedCloseState,
  closeChecksRunning,
  closeEntry,
  closeStatesVersion,
  requestCloseState,
  subscribeCloseStates,
} from "../closeBadges/closeState";
import {
  CLEANUP_FILTERS,
  cleanupAge,
  cleanupCandidates,
  cleanupResult,
  deleteCautions,
  deleteQuestion,
  firstFilledFilter,
  groupByProject,
  handoverLocation,
  inCleanupFilter,
  isHeld,
  tickedByDefault,
  type CleanupFilter,
  type CleanupMode,
} from "./cleanupModel";
import {
  cachedCleanupRows,
  forgetCleanupRows,
  readCleanupProject,
  restoreCleanupRows,
  withRestoredRows,
} from "./cleanupRows";

const EMPTY: Record<CleanupFilter, string> = {
  safe: "No session says it is safe to close.",
  handover: "No session has a handover waiting.",
  idle: "No session has sat idle for 7 days.",
  all: "No sessions to clean up.",
};

type Result = { archived: SessionSummary[]; text: string };
type Progress = { verb: string; done: number; total: number };
/** The rows asked about, held still so a late tick cannot widen the delete. */
type PendingDelete = {
  rows: SessionSummary[];
  question: string;
  cautions?: string;
};

/**
 * Fork feature: archive or delete sessions from every project in one place.
 * Archiving can be undone, here or under Archived. Deleting cannot, so it asks
 * first, naming how many sessions go and which of them looked unfinished.
 */
export function SessionCleanup({
  projectPaths,
  activeSessionId,
  busySessionIds,
  approvalSessionIds,
  openSessionIds,
  onArchive,
  onDelete,
  onOpenSession,
  onClose,
}: {
  projectPaths: readonly string[];
  activeSessionId?: string;
  busySessionIds: ReadonlySet<string>;
  approvalSessionIds: ReadonlySet<string>;
  /** Loaded in a tab: shown, but left for a deliberate tick. */
  openSessionIds: readonly string[];
  onArchive: (
    sessionId: string,
    archived: boolean,
  ) => void | Promise<boolean>;
  /** Removes the session for good, with no prompt of its own. */
  onDelete?: (row: SessionSummary) => Promise<boolean>;
  /** Goes to a session, in whichever project it belongs to. */
  onOpenSession?: (sessionId: string) => void;
  onClose: () => void;
}) {
  // Starts from the last look, so it opens filled while it reads afresh.
  const [rows, setRows] = useState<SessionSummary[]>(() =>
    cachedCleanupRows(projectPaths),
  );
  const [loading, setLoading] = useState(true);
  const [failedProjects, setFailedProjects] = useState(0);
  const [now] = useState(Date.now);
  const [filter, setFilter] = useState<CleanupFilter>(() => {
    const known = cleanupCandidates(rows, {
      activeSessionId,
      busy: busySessionIds,
      approval: approvalSessionIds,
    });
    return firstFilledFilter(
      (choice) =>
        known.filter((row) =>
          inCleanupFilter(
            row.updatedAt,
            cachedCloseState(row.id, row.updatedAt)?.kind,
            choice,
            now,
          ),
        ).length,
    );
  });
  // Once the user has chosen or ticked anything, the tab stays where it is.
  const tabChosen = useRef(false);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  useSyncExternalStore(
    subscribeCloseStates,
    closeStatesVersion,
    closeStatesVersion,
  );

  const pathsKey = projectPaths.join("\n");
  useEffect(() => {
    let cancelled = false;
    // One project at a time: each read runs git and holds the session store.
    void (async () => {
      const paths = pathsKey ? pathsKey.split("\n") : [];
      let failed = 0;
      for (const path of paths) {
        let read = false;
        try {
          await readCleanupProject(path);
          read = true;
        } catch {
          failed += 1;
        }
        if (cancelled) {
          return;
        }
        if (read) {
          // From the shared list, which any archive or Undo since has updated.
          setRows(cachedCleanupRows(paths));
        }
      }
      setFailedProjects(failed);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pathsKey]);

  const held = {
    activeSessionId,
    busy: busySessionIds,
    approval: approvalSessionIds,
  };
  const candidates = cleanupCandidates(
    rows.filter((row) => !removedIds.has(row.id)),
    held,
  );
  const checkKey = candidates.map((c) => `${c.id}@${c.updatedAt}`).join(",");
  const latest = useRef({ candidates, held, onArchive, onDelete });
  latest.current = { candidates, held, onArchive, onDelete };
  // Which list has been sent to be read: until then, none of it counts as done.
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  useEffect(() => {
    for (const candidate of latest.current.candidates) {
      requestCloseState(candidate.id, candidate.updatedAt);
    }
    setRequestedKey(checkKey);
  }, [checkKey]);

  const kindOf = (row: SessionSummary) =>
    cachedCloseState(row.id, row.updatedAt)?.kind;
  const inFilter = (row: SessionSummary, choice: CleanupFilter) =>
    inCleanupFilter(row.updatedAt, kindOf(row), choice, now);
  const open = new Set(openSessionIds);
  const visible = candidates.filter((row) => inFilter(row, filter));
  const isChecked = (row: SessionSummary) =>
    closeEntry(row.id)?.at === row.updatedAt;
  const isTicked = (row: SessionSummary) =>
    overrides.get(row.id) ??
    tickedByDefault(kindOf(row), filter, open.has(row.id), isChecked(row));
  const selected = visible.filter(isTicked);
  const checking = closeChecksRunning()
    ? candidates.filter((row) => !isChecked(row)).length
    : 0;
  const working = progress !== null;
  const locked = working || pendingDelete !== null;

  // Nothing known yet at opening: settle on a tab once it has all been read.
  const settled = !loading && requestedKey === checkKey && checking === 0;
  useEffect(() => {
    if (settled && !tabChosen.current) {
      tabChosen.current = true;
      setFilter(
        firstFilledFilter(
          (choice) => candidates.filter((row) => inFilter(row, choice)).length,
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on settling
  }, [settled]);

  // Backing out of the question hands focus back to the button that asked it.
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (wasAsking.current && !pendingDelete && !working) {
      deleteButton.current?.focus();
    }
    wasAsking.current = pendingDelete !== null;
  }, [pendingDelete, working]);

  const setTicks = (targets: readonly SessionSummary[], ticked: boolean) => {
    tabChosen.current = true;
    setResult(null);
    setOverrides((current) => {
      const next = new Map(current);
      for (const row of targets) {
        next.set(row.id, ticked);
      }
      return next;
    });
  };

  const askToDelete = () => {
    setResult(null);
    setPendingDelete({
      rows: selected,
      question: deleteQuestion(selected.length, selectedProjects),
      cautions: deleteCautions(
        selected.filter((row) => kindOf(row) === "unsafe").length,
        selected.filter((row) => !isChecked(row)).length,
        selected.filter((row) => open.has(row.id)).length,
      ),
    });
  };

  const removeRows = async (
    mode: CleanupMode,
    targets: readonly SessionSummary[],
  ) => {
    const verb = mode === "delete" ? "Deleting" : "Archiving";
    setResult(null);
    setPendingDelete(null);
    setProgress({ verb, done: 0, total: targets.length });
    // The list was read when the panel opened: a session that moved on since
    // may no longer be finished, whatever its old close line said.
    const fresh = new Map<string, SessionSummary>();
    const reread = async (cwd: string) => {
      try {
        for (const row of await listSessionsByProject(cwd)) {
          fresh.set(row.id, row);
        }
      } catch {
        // Not re-read means not removed; those rows are reported as kept.
      }
    };
    for (const cwd of new Set(targets.map((row) => row.cwd))) {
      await reread(cwd);
    }
    const removed: SessionSummary[] = [];
    let kept = 0;
    for (const [index, row] of targets.entries()) {
      setProgress({ verb, done: index, total: targets.length });
      // Stopping the last session's agent takes a while, and a delete can't be
      // taken back, so look again right before each one.
      if (mode === "delete") {
        fresh.delete(row.id);
        await reread(row.cwd);
      }
      const current = fresh.get(row.id);
      const unchanged =
        current &&
        current.updatedAt === row.updatedAt &&
        !current.pinned &&
        !current.draft &&
        !current.archived &&
        !isHeld(row.id, latest.current.held);
      let done = false;
      if (unchanged) {
        try {
          // Removing stops its agent, which another window may be running.
          done =
            !(await sessionHeldElsewhere(row.id)) &&
            (mode === "delete"
              ? (await latest.current.onDelete?.(row)) === true
              : (await latest.current.onArchive(row.id, true)) !== false);
        } catch {
          done = false;
        }
      }
      if (done) {
        removed.push(row);
      } else {
        kept += 1;
      }
    }
    setRows((all) => all.map((row) => fresh.get(row.id) ?? row));
    setRemovedIds((ids) => new Set([...ids, ...removed.map((r) => r.id)]));
    forgetCleanupRows(removed.map((r) => r.id));
    setOverrides(new Map());
    setProgress(null);
    setResult({
      archived: mode === "archive" ? removed : [],
      text: cleanupResult(mode, removed.length, kept),
    });
  };

  const undo = async (archived: readonly SessionSummary[]) => {
    setResult(null);
    const restored: string[] = [];
    for (const [index, row] of archived.entries()) {
      setProgress({ verb: "Restoring", done: index, total: archived.length });
      keepFromAutoArchive(row.id, row.updatedAt);
      let done = false;
      try {
        done = (await latest.current.onArchive(row.id, false)) !== false;
      } catch {
        done = false;
      }
      if (done) {
        restored.push(row.id);
      }
    }
    setRemovedIds((ids) => {
      const next = new Set(ids);
      for (const id of restored) {
        next.delete(id);
      }
      return next;
    });
    const back = archived.filter((row) => restored.includes(row.id));
    setRows((all) => withRestoredRows(all, back));
    restoreCleanupRows(back);
    setOverrides(new Map());
    setProgress(null);
    const failed = archived.length - restored.length;
    setResult({
      archived: archived.filter((row) => !restored.includes(row.id)),
      text:
        failed > 0
          ? `Restored ${restored.length}. ${failed} could not be restored.`
          : `Restored ${restored.length}.`,
    });
  };

  const selectedProjects = new Set(selected.map((row) => row.cwd)).size;
  const groups = groupByProject(visible);

  return (
    <Modal
      title="Clean up sessions"
      description={
        onDelete
          ? "Archive keeps sessions under Archived in each project. Delete removes them for good."
          : "Archiving only tidies lists. Sessions stay under Archived in each project."
      }
      size="md"
      fitViewport
      onClose={() => {
        // A close mid-run would hide a run that keeps going.
        if (working) {
          return;
        }
        if (pendingDelete) {
          setPendingDelete(null);
        } else {
          onClose();
        }
      }}
    >
      <div
        data-fork-session-cleanup=""
        className="flex h-[min(560px,calc(100dvh-112px))] flex-col pt-3 text-[12px]"
      >
        <div className="flex shrink-0 flex-wrap gap-0.5 px-3">
          {CLEANUP_FILTERS.map((choice) => (
            <button
              key={choice.id}
              type="button"
              aria-pressed={filter === choice.id}
              disabled={locked}
              onClick={() => {
                tabChosen.current = true;
                setFilter(choice.id);
                setOverrides(new Map());
                setResult(null);
              }}
              className={`flex h-6 items-center gap-1.5 rounded-md px-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent ${
                filter === choice.id
                  ? "bg-content/10 font-medium text-content"
                  : "text-content/55 hover:text-content"
              }`}
            >
              {choice.label}
              <span className="tabular-nums text-content/45">
                {candidates.filter((row) => inFilter(row, choice.id)).length}
              </span>
            </button>
          ))}
        </div>

        <div className="flex h-7 shrink-0 items-center justify-between gap-2 px-4 pt-1 text-[11px] text-content/50">
          {visible.length > 0 ? (
            <TickBox
              label={`All ${visible.length}`}
              total={visible.length}
              ticked={selected.length}
              disabled={locked}
              onChange={(ticked) => setTicks(visible, ticked)}
            />
          ) : (
            <span />
          )}
          {loading || checking > 0 ? (
            <span className="tabular-nums" role="status">
              {loading ? "Reading projects…" : `Checking ${checking} more…`}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2">
          {visible.length === 0 ? (
            <p className="px-1.5 py-6 text-center text-content/45">
              {loading || checking > 0 ? "Still looking…" : EMPTY[filter]}
            </p>
          ) : null}
          {groups.map((group) => (
            <section
              key={group.cwd}
              aria-label={projectName(group.cwd)}
              className="mt-2.5 first:mt-1"
            >
              <div
                className="flex h-6 items-center gap-2 px-1.5 text-[11px] font-medium text-content/60"
                title={prettyCwd(group.cwd)}
              >
                <TickBox
                  label={projectName(group.cwd)}
                  total={group.rows.length}
                  ticked={group.rows.filter(isTicked).length}
                  disabled={locked}
                  onChange={(ticked) => setTicks(group.rows, ticked)}
                />
              </div>
              {group.rows.map((row) => {
                const state = cachedCloseState(row.id, row.updatedAt);
                const title = sessionDisplayTitle(row.title, row.harness);
                return (
                  <div
                    key={row.id}
                    className="flex min-w-0 items-center rounded-md transition-colors duration-150 hover:bg-content/6"
                  >
                    <label className="flex min-h-7 min-w-0 flex-1 items-center gap-2 py-1 pl-1.5">
                      <input
                        type="checkbox"
                        checked={isTicked(row)}
                        disabled={locked}
                        onChange={(event) =>
                          setTicks([row], event.target.checked)
                        }
                        className="shrink-0 accent-accent"
                      />
                      <HarnessIcon
                        harness={row.harness}
                        className="size-3.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-content/85">
                          {title}
                        </span>
                        {state?.kind === "handover" && state.detail ? (
                          <span
                            data-fork-handover-path=""
                            className="block truncate text-[11px] text-content/50"
                            title={state.detail}
                          >
                            {handoverLocation(state.detail, row.cwd)}
                          </span>
                        ) : null}
                      </span>
                      {open.has(row.id) ? (
                        <span
                          className="shrink-0 text-[10px] text-content/45"
                          title="Open in a tab. Archiving or deleting closes the tab."
                        >
                          In a tab
                        </span>
                      ) : null}
                      <CloseBadge
                        sessionId={row.id}
                        updatedAt={row.updatedAt}
                        idle
                      />
                      <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-content/40">
                        {cleanupAge(now - row.updatedAt)}
                      </span>
                    </label>
                    {onOpenSession ? (
                      <button
                        type="button"
                        aria-label={`Go to ${title}`}
                        title="Go to this session"
                        disabled={locked}
                        onClick={() => {
                          onClose();
                          onOpenSession(row.id);
                        }}
                        className="ml-0.5 grid size-6 shrink-0 place-items-center rounded-md text-content/35 transition-colors duration-150 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
                      >
                        <ExternalLink className="size-3" strokeWidth={1.75} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        {failedProjects > 0 ? (
          <p className="shrink-0 px-4 pb-1 text-[11px] text-amber-600 dark:text-amber-400">
            Could not read {failedProjects}{" "}
            {failedProjects === 1 ? "project" : "projects"}.
          </p>
        ) : null}

        <footer className="flex min-h-12 shrink-0 items-center justify-between gap-3 px-4 py-2.5">
          {pendingDelete ? (
            <div
              role="alert"
              className="min-w-0 text-[11px] leading-snug tabular-nums text-content/80"
            >
              <p>{pendingDelete.question}</p>
              {pendingDelete.cautions ? (
                <p className="mt-0.5 text-amber-600 dark:text-amber-400">
                  {pendingDelete.cautions}
                </p>
              ) : null}
            </div>
          ) : (
            <p
              role="status"
              className="min-w-0 text-[11px] leading-snug tabular-nums text-content/55"
            >
              {progress
                ? `${progress.verb} ${progress.done + 1} of ${progress.total}…`
                : (result?.text ??
                  (selected.length === 0
                    ? "Nothing selected"
                    : `${selected.length} selected in ${selectedProjects} ${
                        selectedProjects === 1 ? "project" : "projects"
                      }`))}
            </p>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {pendingDelete ? (
              <>
                {/* Keyed: it must mount, not take over the button clicked. */}
                <SecondaryButton
                  key="keep"
                  autoFocus
                  onClick={() => setPendingDelete(null)}
                >
                  Keep them
                </SecondaryButton>
                <SecondaryButton
                  danger
                  onClick={() => void removeRows("delete", pendingDelete.rows)}
                >
                  {`Delete ${pendingDelete.rows.length} for good`}
                </SecondaryButton>
              </>
            ) : result ? (
              <>
                {result.archived.length > 0 ? (
                  <SecondaryButton onClick={() => void undo(result.archived)}>
                    Undo
                  </SecondaryButton>
                ) : null}
                <PrimaryButton onClick={onClose}>Done</PrimaryButton>
              </>
            ) : (
              <>
                {onDelete ? (
                  <SecondaryButton
                    key="delete"
                    ref={deleteButton}
                    danger
                    disabled={working || selected.length === 0}
                    onClick={askToDelete}
                  >
                    {selected.length > 0
                      ? `Delete ${selected.length}…`
                      : "Delete…"}
                  </SecondaryButton>
                ) : null}
                <SecondaryButton disabled={working} onClick={onClose}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton
                  disabled={working || selected.length === 0}
                  onClick={() => void removeRows("archive", selected)}
                >
                  {selected.length > 0
                    ? `Archive ${selected.length}`
                    : "Archive"}
                </PrimaryButton>
              </>
            )}
          </div>
        </footer>
      </div>
    </Modal>
  );
}

function PrimaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md bg-content px-2.5 py-1 text-[12px] font-medium tabular-nums text-background-base transition-transform duration-150 hover:bg-content/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.97] disabled:cursor-default disabled:opacity-40 disabled:active:scale-100"
    >
      {children}
    </button>
  );
}

/** A checkbox for many rows: mixed while only some are ticked. */
function TickBox({
  label,
  total,
  ticked,
  disabled,
  onChange,
}: {
  label: string;
  total: number;
  ticked: number;
  disabled: boolean;
  onChange: (ticked: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const mixed = ticked > 0 && ticked < total;
  useEffect(() => {
    if (box.current) {
      box.current.indeterminate = mixed;
    }
  }, [mixed]);
  return (
    <label className="flex min-w-0 items-center gap-2">
      <input
        ref={box}
        type="checkbox"
        checked={total > 0 && ticked === total}
        disabled={disabled}
        onChange={() => onChange(ticked < total)}
        className="shrink-0 accent-accent"
      />
      <span className="truncate">{label}</span>
    </label>
  );
}
