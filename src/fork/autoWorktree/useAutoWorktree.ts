import { useEffect, useState, useSyncExternalStore } from "react";
import {
  listWorktrees,
  type Worktrees,
} from "../../features/source-control/model/worktrees";
import { useProjectBranchesState } from "../../features/source-control/hooks/useProjectBranches";
import { subscribeGitChanged } from "../../platform/tauri/fs";
import { REMOTE_PATH_PREFIX } from "../../shared/lib/remotePaths";
import {
  autoPicksVersion,
  checkoutDirty,
  decideAutoWorktree,
  loadAutoWorktreePolicy,
  noteAutoPick,
  otherSessionBusy,
  subscribeAutoPicks,
  subscribeAutoWorktreePolicy,
  subscribeBusySessions,
  userChoseWorkspace,
} from "./autoWorktree";
import type { WorkspaceMode } from "../../features/sessions/model/session";

export function useAutoWorktreePolicy() {
  return useSyncExternalStore(
    subscribeAutoWorktreePolicy,
    loadAutoWorktreePolicy,
  );
}

/** Applies the setting to a blank session while it can still choose. */
export function useAutoWorktree({
  sessionId,
  cwd,
  draft,
  mode,
  branch,
  onChange,
}: {
  sessionId: string;
  cwd: string;
  /** Local, blank, and not tied to a worktree yet. */
  draft: boolean;
  mode: WorkspaceMode | undefined;
  branch: string | undefined;
  onChange: (mode: WorkspaceMode, base?: string) => void;
}) {
  const policy = useAutoWorktreePolicy();
  useSyncExternalStore(subscribeAutoPicks, autoPicksVersion);
  const busy = useSyncExternalStore(subscribeBusySessions, () =>
    otherSessionBusy(sessionId, cwd),
  );
  const local = !cwd.startsWith(REMOTE_PATH_PREFIX) && cwd !== "~";
  const active =
    draft &&
    local &&
    policy !== "never" &&
    mode !== "worktree" &&
    !userChoseWorkspace(sessionId, cwd);
  const { branches } = useProjectBranchesState(cwd, active);
  const base = branch || branches?.current || undefined;
  const checkDirty = active && policy === "smart" && !busy;
  const [dirty, setDirty] = useState<boolean | null>(null);

  useEffect(() => {
    setDirty(null);
    if (!checkDirty) return;
    let live = true;
    const check = () => {
      listWorktrees(cwd)
        .then((listed: Worktrees) => {
          if (live) setDirty(checkoutDirty(cwd, listed.worktrees));
        })
        .catch(() => {
          // Not a repository, or Git is busy: leave the session where it is.
          if (live) setDirty(null);
        });
    };
    check();
    const unsubscribe = subscribeGitChanged(check);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [checkDirty, cwd]);

  useEffect(() => {
    if (!active || !base) return;
    const reason = decideAutoWorktree({
      policy,
      otherSessionBusy: busy,
      dirty,
    });
    if (!reason) return;
    noteAutoPick(sessionId, cwd, reason);
    onChange("worktree", base);
    // onChange is a fresh closure each render; the inputs above decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, base, busy, cwd, dirty, policy, sessionId]);
}
