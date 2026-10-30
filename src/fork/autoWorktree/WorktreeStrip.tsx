import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeGitChanged } from "../../platform/tauri/fs";
import { formatInteger } from "../../shared/lib/numbers";
import { projectName } from "../../shared/lib/paths";
import {
  ChevronRight,
  Folder,
  FolderTree,
  GitMerge,
  Loader,
  X,
} from "../../shared/ui/icons";
import {
  autoPickReason,
  autoPicksVersion,
  autoWorktreeReasonText,
  coachSeen,
  markCoachSeen,
  removeSessionWorktree,
  subscribeAutoPicks,
  type AutoWorktreeReason,
} from "./autoWorktree";
import { BranchChip, useProjectColor } from "./BranchChip";
import {
  deleteMergedBranch,
  loadMergeStatus,
  mergeView,
  mergeWorktreeBack,
  mergeWorthShowing,
  type MergeStatus,
} from "./mergeBack";
import { MergeGraph } from "./MergeGraph";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

function Stats({ status }: { status: MergeStatus }) {
  if (!status.additions && !status.deletions) return null;
  return (
    <span className="flex shrink-0 gap-1.5 text-[11px] font-medium tabular-nums">
      <span className="text-diff-add-fg">+{formatInteger(status.additions)}</span>
      <span className="text-diff-del-fg">-{formatInteger(status.deletions)}</span>
    </span>
  );
}

/** The panel Merge back opens: a picture of the merge, and the next step. */
export function MergePanel({
  status,
  color,
  merged,
  working,
  error,
  onMerge,
  onRemove,
  onAskAgent,
}: {
  status: MergeStatus;
  color: string;
  merged: boolean;
  working: boolean;
  error?: string;
  onMerge: () => void;
  onRemove: () => void;
  onAskAgent?: (prompt: string) => void;
}) {
  const view = mergeView(status, merged);
  return (
    <div
      data-fork-merge-panel={view.kind}
      className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-content/[0.05] px-3 py-2.5 font-sans"
    >
      <span className="text-content/70">
        <MergeGraph
          kind={view.kind}
          ahead={status.ahead}
          behind={status.behind}
          color={color}
        />
      </span>
      <div className="min-w-[14rem] flex-1">
        <p className="text-[13px] font-medium text-content [text-wrap:pretty]">
          {view.title}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-content/55 [text-wrap:pretty]">
          {view.detail}
        </p>
        {view.kind === "conflict" ? (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {status.conflicts.slice(0, 6).map((file) => (
              <li
                key={file}
                className="truncate font-mono text-[11px] text-diff-del-fg"
                title={file}
              >
                {file}
              </li>
            ))}
            {status.conflicts.length > 6 ? (
              <li className="text-[11px] text-content/45">
                and {status.conflicts.length - 6} more
              </li>
            ) : null}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-diff-del-fg">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {view.canMerge ? (
          <button
            type="button"
            disabled={working}
            onClick={onMerge}
            className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-content px-2.5 text-[12px] font-medium text-background-base hover:bg-content/85 ${PRESS}`}
          >
            {working ? (
              <Loader className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <GitMerge className="size-3.5" strokeWidth={1.75} aria-hidden />
            )}
            {working ? "Merging" : `Merge into ${status.base}`}
          </button>
        ) : null}
        {view.agentPrompt && view.agentLabel && onAskAgent ? (
          <button
            type="button"
            disabled={working}
            onClick={() => onAskAgent(view.agentPrompt!)}
            className={`inline-flex h-7 items-center rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
          >
            {view.agentLabel}
          </button>
        ) : null}
        {merged ? (
          <button
            type="button"
            disabled={working}
            onClick={onRemove}
            className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
          >
            {working ? <Loader className="size-3.5 animate-spin" aria-hidden /> : null}
            Remove worktree
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** First auto worktree: says what just happened and how to get back. */
export function WorktreeCoachCard({
  reason,
  branch,
  base,
  color,
  onDismiss,
  onOpenSettings,
}: {
  reason: AutoWorktreeReason;
  branch: string;
  base: string;
  color: string;
  onDismiss: () => void;
  onOpenSettings?: () => void;
}) {
  const steps = [
    { icon: Folder, tint: undefined, label: `${base} stays as it is`, note: "Your main checkout is not touched" },
    { icon: FolderTree, tint: color, label: `The agent works on ${branch}`, note: "In its own copy of the project" },
    { icon: GitMerge, tint: color, label: "Merge back when you like it", note: "The button below shows what will change" },
  ];
  return (
    <div
      data-fork-worktree-coach
      className="mb-1.5 rounded-xl bg-content/[0.05] px-3.5 py-3 font-sans motion-safe:animate-[fork-coach-in_220ms_cubic-bezier(0.23,1,0.32,1)]"
    >
      <style>{`@keyframes fork-coach-in { from { opacity: 0; transform: translateY(6px); } }`}</style>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold tracking-[-0.01em] text-content">
            This session got its own worktree
          </p>
          <p className="mt-0.5 text-[12px] text-content/55">
            {autoWorktreeReasonText(reason)}, so they can't step on each other.
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className={`grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content ${PRESS}`}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <ol className="mt-3 flex flex-wrap gap-x-5 gap-y-2.5">
        {steps.map(({ icon: Icon, tint, label, note }) => (
          <li key={label} className="flex min-w-[11rem] flex-1 items-start gap-2">
            <span
              className="grid size-6 shrink-0 place-items-center rounded-md bg-content/8 text-content/60"
              style={
                tint
                  ? {
                      color: `color-mix(in srgb, ${tint} 65%, var(--color-content))`,
                      backgroundColor: `color-mix(in srgb, ${tint} 14%, transparent)`,
                    }
                  : undefined
              }
            >
              <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block break-words text-[12px] font-medium text-content">
                {label}
              </span>
              <span className="block text-[11px] leading-relaxed text-content/50">
                {note}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDismiss}
          className={`inline-flex h-7 items-center rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
        >
          Got it
        </button>
        {onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className={`inline-flex h-7 items-center rounded-lg px-2.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content ${PRESS}`}
          >
            Change when this happens
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A draft the app moved to a worktree: says why, with a one-click way back. */
export function AutoPickNote({
  reason,
  onStay,
}: {
  reason: AutoWorktreeReason;
  onStay: () => void;
}) {
  return (
    <div
      data-fork-auto-pick
      className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 px-2 font-sans text-[12px] text-content/55"
    >
      <FolderTree className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0">
        {autoWorktreeReasonText(reason)}, so this starts in a new worktree.
      </span>
      <button
        type="button"
        onClick={onStay}
        className={`rounded-md px-1 text-content/75 underline-offset-2 hover:text-content hover:underline ${PRESS}`}
      >
        Stay in this checkout
      </button>
    </div>
  );
}

/**
 * Fork: the line above the composer for a session in a worktree. It names the
 * branch in the project's colour and carries Merge back.
 */
export function WorktreeStrip({
  sessionId,
  cwd,
  worktreeCwd,
  branch,
  busy,
  draft,
  onStayInCheckout,
  onAskAgent,
  onOpenSettings,
}: {
  sessionId: string;
  cwd: string;
  worktreeCwd?: string;
  branch?: string;
  busy: boolean;
  /** Still blank and set to start in a worktree. */
  draft: boolean;
  onStayInCheckout: () => void;
  onAskAgent: (prompt: string) => void;
  onOpenSettings?: () => void;
}) {
  useSyncExternalStore(subscribeAutoPicks, autoPicksVersion);
  const reason = autoPickReason(sessionId, cwd);
  const color = useProjectColor(cwd);
  const [status, setStatus] = useState<MergeStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [merged, setMerged] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  const latestRead = useRef(0);

  const refresh = useCallback(async () => {
    if (!worktreeCwd) return;
    const read = ++latestRead.current;
    try {
      const next = await loadMergeStatus(cwd, worktreeCwd);
      if (read !== latestRead.current) return;
      setStatus(next);
      // New work after a merge means there is something to merge again.
      if (next.ahead > 0 || next.uncommitted > 0) setMerged(false);
    } catch {
      // Detached or on no branch: the chip alone is still right.
      if (read === latestRead.current) setStatus(null);
    }
  }, [cwd, worktreeCwd]);

  useEffect(() => {
    setStatus(null);
    setOpen(false);
    setMerged(false);
    setError(undefined);
    if (!worktreeCwd) return;
    void refresh();
    return subscribeGitChanged(() => void refresh());
  }, [refresh, worktreeCwd]);

  // Agents commit without telling the app, so look again when a turn ends.
  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh]);

  if (draft) {
    return reason ? <AutoPickNote reason={reason} onStay={onStayInCheckout} /> : null;
  }
  if (!worktreeCwd) return null;

  const shownBranch = status?.branch ?? branch;
  const worth = mergeWorthShowing(status) || merged;

  const merge = async () => {
    setWorking(true);
    setError(undefined);
    try {
      const outcome = await mergeWorktreeBack(cwd, worktreeCwd);
      if (outcome.kind === "conflict") {
        setStatus((current) =>
          current ? { ...current, conflicts: outcome.conflicts } : current,
        );
      } else {
        setMerged(true);
      }
    } catch (failure) {
      setError(String(failure));
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    if (!status) return;
    setWorking(true);
    setError(undefined);
    try {
      await removeSessionWorktree(cwd, worktreeCwd);
      // The merge is safe in the base, so the finished branch can go too.
      await deleteMergedBranch(cwd, status.branch, status.base).catch(
        () => undefined,
      );
    } catch (failure) {
      setError(String(failure));
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      {reason && !coachSeen() && shownBranch ? (
        <WorktreeCoachCard
          reason={reason}
          branch={shownBranch}
          base={status?.base ?? projectName(cwd)}
          color={color}
          onDismiss={markCoachSeen}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
      <div data-fork-worktree-strip className="mb-1.5 flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2 px-1 font-sans">
          {shownBranch ? (
            <BranchChip cwd={cwd} branch={shownBranch} className="shrink" />
          ) : null}
          {status ? (
            <span className="min-w-0 shrink-[2] truncate text-[11px] text-content/40">
              from {status.base}
            </span>
          ) : null}
          {status ? <Stats status={status} /> : null}
          {worth && status ? (
            <button
              type="button"
              aria-expanded={open}
              disabled={busy}
              onClick={() => setOpen(!open)}
              className={`ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-content/75 hover:bg-content/8 hover:text-content ${
                open ? "bg-content/8 text-content" : ""
              } ${PRESS}`}
            >
              <GitMerge className="size-3.5" strokeWidth={1.75} aria-hidden />
              Merge back
              <ChevronRight
                className={`size-3 transition-transform duration-200 motion-reduce:transition-none ${open ? "-rotate-90" : ""}`}
                strokeWidth={2}
                aria-hidden
              />
            </button>
          ) : null}
        </div>
        {open && status ? (
          <MergePanel
            status={status}
            color={color}
            merged={merged}
            working={working}
            error={error}
            onMerge={() => void merge()}
            onRemove={() => void remove()}
            onAskAgent={(prompt) => {
              setOpen(false);
              onAskAgent(prompt);
            }}
          />
        ) : null}
      </div>
    </>
  );
}
