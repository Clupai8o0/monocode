import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Added and removed line counts for each project's working tree, as the
 * phone's project list shows them. Counting runs git, too slow to do for every
 * project on every catalog poll, so it happens here in the background, one git
 * process at a time, and the catalog reads whatever was counted last.
 */

export type DiffStats = { additions: number; deletions: number };

/** Counts one checkout; null when it is not a git repo or git failed. */
export type DiffCounter = (cwd: string) => Promise<DiffStats | null>;

const exec = promisify(execFile);
/** A repo slower than this is left at its last count. */
const GIT_TIMEOUT_MS = 15_000;
/** Projects active this recently are recounted every `REFRESH_MS`. */
const ACTIVE_MS = 10 * 60_000;
const REFRESH_MS = 60_000;
/** Untracked files whose lines are counted, at most. */
const MAX_UNTRACKED = 200;

const git = async (cwd: string, args: string[]) =>
  (
    await exec("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
  ).stdout;

/** Tracked changes against HEAD, plus the lines of untracked files. */
export const gitDiffStats: DiffCounter = async (cwd) => {
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true")
      return null;
  } catch {
    return null;
  }
  try {
    let additions = 0;
    let deletions = 0;
    // A repo with no commit yet has no HEAD; its files all count as untracked.
    let numstat = "";
    try {
      numstat = await git(cwd, ["diff", "--numstat", "HEAD", "--"]);
    } catch {
      numstat = "";
    }
    for (const line of numstat.split("\n")) {
      const [added, removed] = line.split("\t");
      // Binary files show "-" for both.
      additions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
    const untracked = (
      await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED);
    // One file at a time, so a count never runs more than one git. `git diff
    // --no-index` exits 1 when files differ, so its output is read from the
    // error too.
    for (const path of untracked) {
      let out = "";
      try {
        out = await git(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", path]);
      } catch (error) {
        out = String((error as { stdout?: unknown }).stdout ?? "");
      }
      additions += Number(out.split("\t")[0]) || 0;
    }
    return { additions, deletions };
  } catch {
    return null;
  }
};

export type DiffStatsCache = ReturnType<typeof createDiffStats>;

/**
 * The cache the catalog reads. `refresh` queues a project to be counted;
 * counts run strictly one after another, and a project already queued is not
 * queued twice. `onChange` hears when any count changed.
 */
export function createDiffStats(
  options: {
    count?: DiffCounter;
    /** The projects to recount periodically, with when each was last active. */
    active?: () => Array<{ id: string; cwd: string; updatedAt: number }>;
    onChange?: () => void;
    now?: () => number;
    intervalMs?: number;
  } = {},
) {
  const count = options.count ?? gitDiffStats;
  const now = options.now ?? Date.now;
  const stats = new Map<string, DiffStats>();
  const queue = new Map<string, string>();
  let running: Promise<void> | null = null;

  const drain = async () => {
    for (const [id, cwd] of queue) {
      queue.delete(id);
      let next: DiffStats | null = null;
      try {
        next = await count(cwd);
      } catch {
        next = null;
      }
      const before = stats.get(id);
      if (!next) {
        if (before) {
          stats.delete(id);
          options.onChange?.();
        }
        continue;
      }
      if (before?.additions !== next.additions || before?.deletions !== next.deletions) {
        stats.set(id, next);
        options.onChange?.();
      }
    }
  };

  const start = (): Promise<void> =>
    drain().finally(() => {
      // A refresh that came in as the last count finished still runs.
      running = queue.size ? start() : null;
    });
  const refresh = (id: string, cwd: string): Promise<void> => {
    queue.set(id, cwd);
    running ??= start();
    return running;
  };

  const tick = () => {
    try {
      const cutoff = now() - ACTIVE_MS;
      for (const project of options.active?.() ?? [])
        if (project.updatedAt >= cutoff) void refresh(project.id, project.cwd);
    } catch (error) {
      console.debug("[monocode] diff stats", error);
    }
  };
  const timer = options.active
    ? setInterval(tick, options.intervalMs ?? REFRESH_MS)
    : null;
  timer?.unref();

  return {
    /** The last count, or zeros before the first one or outside git. */
    get: (id: string): DiffStats => stats.get(id) ?? { additions: 0, deletions: 0 },
    refresh,
    tick,
    /** Resolves once everything queued so far has been counted. */
    idle: async () => {
      while (running) await running;
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
