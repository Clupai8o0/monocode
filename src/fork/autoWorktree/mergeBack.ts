import { invoke } from "@tauri-apps/api/core";
import { notifyGitChanged } from "../../platform/tauri/fs";

export type MergeStatus = {
  branch: string;
  base: string;
  baseCheckout: string | null;
  baseBusy: boolean;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  files: number;
  uncommitted: number;
  conflicts: string[];
};

export type MergeOutcome = {
  kind: "fast-forward" | "merged" | "up-to-date" | "conflict";
  conflicts: string[];
};

export const loadMergeStatus = (cwd: string, path: string) =>
  invoke<MergeStatus>("fork_worktree_merge_status", { cwd, path });

export async function mergeWorktreeBack(cwd: string, path: string) {
  const outcome = await invoke<MergeOutcome>("fork_worktree_merge_back", {
    cwd,
    path,
  });
  notifyGitChanged();
  return outcome;
}

export async function deleteMergedBranch(
  cwd: string,
  branch: string,
  base: string,
) {
  await invoke<void>("fork_worktree_delete_merged_branch", {
    cwd,
    branch,
    base,
  });
  notifyGitChanged();
}

export type MergeViewKind =
  | "nothing"
  | "uncommitted"
  | "base-busy"
  | "conflict"
  | "fast-forward"
  | "merge"
  | "merged";

export type MergeView = {
  kind: MergeViewKind;
  title: string;
  detail: string;
  /** Merge back can run right now. */
  canMerge: boolean;
  /** The agent can sort this out: commit the work, or resolve the conflicts. */
  agentPrompt: string | null;
  agentLabel: string | null;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** Turns what Git reports into the one thing the person should do next. */
export function mergeView(status: MergeStatus, merged = false): MergeView {
  const { base, branch, ahead, behind, uncommitted, conflicts } = status;
  const none = { canMerge: false, agentPrompt: null, agentLabel: null };
  if (merged) {
    return {
      ...none,
      kind: "merged",
      title: `Merged into ${base}`,
      detail: "The work is on the base branch. This worktree is no longer needed.",
    };
  }
  if (uncommitted > 0) {
    return {
      kind: "uncommitted",
      title: `${plural(uncommitted, "file")} not committed yet`,
      detail: "Only commits are merged. Commit this work first so it comes along.",
      canMerge: false,
      agentPrompt: "Commit the uncommitted changes in this worktree with a clear message.",
      agentLabel: "Ask the agent to commit",
    };
  }
  if (ahead === 0) {
    return {
      ...none,
      kind: "nothing",
      title: "Nothing to merge yet",
      detail: `${branch} has no commits that ${base} is missing.`,
    };
  }
  if (conflicts.length > 0) {
    return {
      kind: "conflict",
      title: `${plural(conflicts.length, "file")} changed on both sides`,
      detail: `Nothing was touched. Bring ${base} into this worktree, fix the overlap there, then merge back.`,
      canMerge: false,
      agentPrompt: `Merge ${base} into this branch and resolve the conflicts in ${conflicts.join(", ")}. Keep both sides' intent, run the relevant tests, and commit the merge.`,
      agentLabel: "Ask the agent to fix",
    };
  }
  if (status.baseBusy) {
    return {
      ...none,
      kind: "base-busy",
      title: `${base} is in the middle of a merge or rebase`,
      detail: "Finish that in the base checkout, then merge back.",
    };
  }
  if (behind === 0) {
    return {
      ...none,
      kind: "fast-forward",
      title: `Ready to bring ${plural(ahead, "commit")} into ${base}`,
      detail: `${base} has not moved, so it simply moves forward to this work.`,
      canMerge: true,
    };
  }
  return {
    ...none,
    kind: "merge",
    title: `Ready to merge ${plural(ahead, "commit")} into ${base}`,
    detail: `${base} gained ${plural(behind, "commit")} since this started. They don't overlap.`,
    canMerge: true,
  };
}

/** Whether the strip offers Merge back, or only names the branch. */
export const mergeWorthShowing = (status: MergeStatus | null) =>
  !!status && (status.ahead > 0 || status.uncommitted > 0);
