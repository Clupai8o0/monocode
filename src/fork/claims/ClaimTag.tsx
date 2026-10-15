import {
  holdersOf,
  tagLabel,
  tagTone,
  tagTooltip,
  type ClaimTone,
} from "./claimsModel";
import { useClaims } from "./claimsStore";

const TONE: Record<ClaimTone, string> = {
  claude: "bg-orange-400/15 text-orange-700 dark:text-orange-300",
  codex: "bg-sky-400/15 text-sky-700 dark:text-sky-300",
  other: "bg-content/10 text-content/70",
};

/**
 * Fork: a small tag naming the live session(s) editing this file, or files
 * in this folder, from `claims.py`. Hover shows each one's status note.
 * Renders nothing when nobody holds it.
 */
export function ClaimTag({
  root,
  path,
  isDir = false,
}: {
  /** The project folder the path sits in (Explorer root, or the tab's cwd). */
  root: string | undefined;
  path: string;
  isDir?: boolean;
}) {
  const snapshot = useClaims(root);
  if (!snapshot || !root) {
    return null;
  }
  const holders = holdersOf(snapshot, root, path, isDir);
  if (holders.length === 0) {
    return null;
  }
  const first = holders[0];
  const label = tagLabel(holders);
  const tooltip = tagTooltip(holders, isDir, Date.now());
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      data-fork-claim-tag
      className={`ml-auto max-w-[45%] shrink-0 truncate rounded-[5px] px-1.5 py-px text-[11px] font-semibold leading-[1.4] ${
        TONE[tagTone(first.name)]
      } ${first.otherTree ? "border border-dashed border-current/40 opacity-70" : ""}`}
    >
      {label}
    </span>
  );
}
