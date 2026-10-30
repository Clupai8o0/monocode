import { useProjectAppearance } from "../../features/projects/hooks/useProjectAppearance";
import { resolveTabGroupColor } from "../../features/workspace/model/tabGroups";
import { projectKey, projectName } from "../../shared/lib/paths";
import { FolderTree } from "../../shared/ui/icons";

export function useProjectColor(cwd: string): string {
  const { groupColors, groupCustomColors } = useProjectAppearance();
  return resolveTabGroupColor(
    projectKey(cwd),
    groupColors,
    groupCustomColors,
    projectName(cwd),
  );
}

/** Fork: a worktree's branch, in its project's colour. */
export function BranchChip({
  cwd,
  branch,
  title,
  className = "",
}: {
  /** The project, not the worktree, so every chip in it matches. */
  cwd: string;
  branch: string;
  title?: string;
  className?: string;
}) {
  const color = useProjectColor(cwd);
  return (
    <span
      data-fork-branch-chip
      title={title ?? branch}
      style={{
        // Mixed toward the text colour, so pale project colours stay readable.
        color: `color-mix(in srgb, ${color} 65%, var(--color-content))`,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      className={`inline-flex h-[18px] min-w-0 max-w-full items-center gap-1 rounded-[5px] px-1.5 font-sans text-[11px] font-medium ${className}`}
    >
      <FolderTree className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 truncate">{branch}</span>
    </span>
  );
}
