import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The branch a checkout is on, read from its HEAD file rather than by running
 * git, so the phone's catalog can show it for every project on every poll.
 * A detached HEAD shows as its short commit; anything else unreadable as "".
 */
export function headBranch(cwd: string): string {
  try {
    let gitDir = join(cwd, ".git");
    let head: string;
    try {
      head = readFileSync(join(gitDir, "HEAD"), "utf8");
    } catch {
      // A worktree's .git is a file naming its real git dir.
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!pointer) return "";
      gitDir = isAbsolute(pointer[1]!.trim())
        ? pointer[1]!.trim()
        : resolve(cwd, pointer[1]!.trim());
      head = readFileSync(join(gitDir, "HEAD"), "utf8");
    }
    const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
    if (ref) return ref[1]!.trim();
    const commit = /^([0-9a-f]{7,64})\s*$/.exec(head.trim());
    return commit ? commit[1]!.slice(0, 7) : "";
  } catch {
    return "";
  }
}
