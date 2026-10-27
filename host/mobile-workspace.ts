import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { HostEngine } from "./engine";
import {
  existingPath,
  hostFileDiff,
  hostGitAction,
  hostGitIndex,
  indexHostFiles,
  listHostFiles,
} from "./workspace";
import { hostWorktrees, resolveHostWorktreeAsync } from "./git-worktrees";
import { buildUnifiedFile } from "../src/features/source-control/model/unifiedDiff";
import { scorePath } from "../src/shared/lib/fuzzy";

/**
 * The Files, Changes and worktree half of the phone's protocol, answered by the
 * host itself. The desktop answers these from `src/features/mobile`, over Tauri;
 * here they run against the host's own git and filesystem modules, in the same
 * response shapes so one phone build talks to either.
 *
 * Syntax colours are the one thing left out: the desktop highlights with Shiki
 * in its renderer, which the host has no equivalent of. Both `highlighted` and
 * `highlightJob` are optional, so the phone falls back to plain text.
 */

const exec = promisify(execFile);

/** Enough of a file to read on a phone; the desktop sends the same slice. */
const MAX_FILE_CHARS = 1024 * 1024;
/** Diffs in one Changes reply, and the characters they may spend between them. */
const MAX_DIFF_FILES = 30;
const DIFF_BUDGET = 1_000_000;
/** Ranked search results returned, matching the desktop's quick open. */
const MAX_SEARCH_RESULTS = 50;
/** How long a Git action is waited for before the phone is told to ask again. */
const GIT_ACTION_WAIT_MS = 10_000;
/** Git actions remembered by command id, so a retry joins the first run. */
const MAX_GIT_JOBS = 100;

export type Job = {
  signature: string;
  result: Promise<unknown>;
  /** Whether the work has finished, so the entry may be evicted. */
  settled: boolean;
};

export type MobileWorkspace = ReturnType<typeof createMobileWorkspace>;

export function createMobileWorkspace(engine: HostEngine) {
  const gitJobs = new Map<string, Job>();

  /** The project checkout, or one of its worktrees when the phone names one. */
  const root = async (params: Record<string, unknown>) => {
    const project = engine.store.project(String(params.projectId ?? ""));
    return resolveHostWorktreeAsync(project.cwd, params.worktreePath);
  };
  const worktreeEcho = (params: Record<string, unknown>) =>
    typeof params.worktreePath === "string" && params.worktreePath
      ? { worktreePath: params.worktreePath }
      : {};

  const files = async (params: Record<string, unknown>) => {
    const cwd = await root(params);
    const entries = await listHostFiles(cwd, String(params.path ?? ""));
    return {
      entries: entries.map((entry) => ({
        name: entry.name,
        isDir: entry.isDir,
        ignored: entry.ignored,
      })),
    };
  };

  const file = async (params: Record<string, unknown>) => {
    const cwd = await root(params);
    const asked = String(params.path ?? "");
    // A path from a transcript may carry a line number (`app.ts:12`) or be
    // shortened to its name; try it as written, then without the line, then
    // find it the way the desktop's transcript links do.
    const withoutLine = asked.replace(/:\d+(?::\d+)?$/, "");
    const tries = [asked, ...(withoutLine !== asked ? [withoutLine] : [])];
    let failure: unknown;
    for (const candidate of tries) {
      try {
        // Awaited inside the try: a returned promise's rejection would not be
        // caught here, and the fallbacks are the whole point.
        return await readPrefix(cwd, candidate);
      } catch (error) {
        failure ??= error;
      }
    }
    const found = await locate(cwd, withoutLine);
    if (!found) throw failure;
    return readPrefix(cwd, found);
  };

  const search = async (params: Record<string, unknown>) => {
    const query = String(params.query ?? "").trim();
    if (!query) return { results: [] };
    const cwd = await root(params);
    const ranked = [];
    for (const path of await indexHostFiles(cwd)) {
      const name = basename(path);
      const hit = scorePath(query, path, name);
      if (hit) ranked.push({ path, name, score: hit.score });
    }
    ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return {
      results: ranked
        .slice(0, MAX_SEARCH_RESULTS)
        .map(({ path, name }) => ({ path, name })),
    };
  };

  const changes = async (params: Record<string, unknown>) => {
    const cwd = await root(params);
    const index = await hostGitIndex(cwd);
    let budget = DIFF_BUDGET;
    const out = [];
    for (const changed of index.files) {
      let lines: ReturnType<typeof buildUnifiedFile>["lines"] = [];
      if (budget > 0 && out.length < MAX_DIFF_FILES) {
        const diff = await hostFileDiff(
          cwd,
          changed.relative,
          !changed.unstaged,
          index,
        ).catch(() => null);
        const size = diff ? diff.original.length + diff.current.length : 0;
        if (diff && !diff.binary && !diff.tooLarge && size <= budget) {
          budget -= size;
          try {
            lines = buildUnifiedFile(diff.original, diff.current).lines;
          } catch {
            // A diff too big to lay out (hundreds of thousands of lines) is
            // listed without one, rather than taking the whole page down.
            lines = [];
          }
        }
      }
      out.push({
        relative: changed.relative,
        status: ["added", "deleted", "untracked"].includes(changed.status)
          ? changed.status
          : "modified",
        additions: changed.additions,
        deletions: changed.deletions,
        staged: changed.staged,
        unstaged: changed.unstaged,
        lines,
      });
    }
    // Echoed so the phone can tell these are the changes it asked for.
    return {
      branch: index.branch ?? "",
      files: out,
      ...worktreeEcho(params),
    };
  };

  const git = async (params: Record<string, unknown>) => {
    const cwd = await root(params);
    const index = await hostGitIndex(cwd);
    return {
      branch: index.branch ?? "",
      files: index.files.length,
      remote: !!index.remote,
      upstream: !!index.upstream,
      defaultBranch: index.defaultBranch ?? "",
      ahead: index.ahead,
      behind: index.behind,
      aheadOfDefault: index.aheadOfDefault,
      // Writing a commit message means running an agent; the host has no
      // equivalent of the desktop's generate yet, so the sheet hides it.
      canGenerate: false,
      pr: await pullRequest(cwd),
    };
  };

  /**
   * Staging is quick; a commit, a sync or a pull request is not, and a request
   * may not outlive the server's timeout. So the phone is told `pending` and
   * asks again under the same command id until the action has its answer.
   */
  const gitAction = (commandId: string, params: Record<string, unknown>) => {
    const running = once(gitJobs, commandId, params, MAX_GIT_JOBS, () =>
      runGitAction(params),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      running,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ pending: true }), GIT_ACTION_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  const runGitAction = async (params: Record<string, unknown>) => {
    const cwd = await root(params);
    const paths = Array.isArray(params.paths)
      ? params.paths.filter((path): path is string => typeof path === "string")
      : [];
    switch (params.action) {
      case "stage":
      case "unstage":
        for (const path of paths) await hostGitAction(cwd, params.action, path);
        return {};
      case "stageAll":
      case "unstageAll":
        await hostGitAction(cwd, params.action);
        return {};
      case "commit":
        await hostGitAction(cwd, "commit", undefined, params.message);
        return {};
      case "sync":
        await hostGitAction(cwd, "sync");
        return {};
      case "pr": {
        const url = await hostGitAction(cwd, "createPr");
        return typeof url === "string" && url ? { url } : {};
      }
      case "generate":
        throw new Error(
          "Writing a commit message isn't available on this machine yet",
        );
      default:
        throw new Error("Unsupported Git action");
    }
  };

  const worktrees = async (params: Record<string, unknown>) => {
    const project = engine.store.project(String(params.projectId ?? ""));
    const listed = await hostWorktrees(project.cwd);
    return {
      worktrees: listed.worktrees
        .filter((tree) => !tree.isMain && !tree.missing)
        .map((tree) => ({
          path: tree.path,
          name: tree.branch ?? basename(tree.path),
        })),
    };
  };

  return { files, file, search, changes, git, gitAction, worktrees };
}

/**
 * As much of a text file as a phone reads, and whether there is more, under
 * the path it was found at relative to the working copy — the phone shows
 * that, so `./src/app.ts` and a full host path both come back as `src/app.ts`.
 * A file over the limit is still worth opening, so only its first slice is
 * read rather than the whole thing being refused.
 */
async function readPrefix(
  root: string,
  input: unknown,
): Promise<{ path: string; text: string; truncated: boolean }> {
  const path = await existingPath(root, input);
  const found = relative(root, path).split(sep).join("/");
  if (!(await stat(path)).isFile()) throw new Error("Path is not a file");
  const handle = await open(path, "r");
  try {
    // The limit counts characters, so read up to the most bytes that many can
    // take, and let the decoder hold back a sequence cut off at the end rather
    // than turn it into a replacement character.
    const buffer = Buffer.alloc(MAX_FILE_CHARS * 4 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const read = buffer.subarray(0, bytesRead);
    if (read.includes(0)) throw new Error("Binary file cannot be previewed");
    const decoded = new StringDecoder("utf8").write(read);
    let text = decoded.slice(0, MAX_FILE_CHARS);
    // The cut may land between the halves of an astral character; keep neither.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    return {
      path: found,
      text,
      truncated: decoded.length > MAX_FILE_CHARS || bytesRead > buffer.length - 1,
    };
  } finally {
    await handle.close();
  }
}

/**
 * The file a transcript meant, when its path does not resolve as written:
 * a trailing `:12` line reference dropped, then the shortest indexed path
 * ending in what was asked for.
 */
async function locate(root: string, trimmed: string): Promise<string | null> {
  if (!trimmed) return null;
  // An absolute path may name this working copy, or another checkout of the
  // same repository; either way only the part inside it can be looked up.
  const inside = isAbsolute(trimmed)
    ? relative(root, trimmed).split(sep).join("/")
    : trimmed.replace(/^\.\//, "");
  const wanted =
    inside && !inside.startsWith("..") ? inside : trimmed.replace(/^\/+/, "");
  if (!wanted) return null;
  const paths = await indexHostFiles(root).catch(() => [] as string[]);
  if (paths.includes(wanted)) return wanted;
  // Then the longest trailing run of its segments that any one file ends with,
  // so `src/app.ts` is preferred over any `app.ts`, and the shortest such path
  // wins among equals.
  const segments = wanted.split("/").filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    const tail = segments.slice(start).join("/");
    // Equality too, so a root-level `README.md` answers `/old/checkout/README.md`.
    const matches = paths.filter(
      (path) => path === tail || path.endsWith(`/${tail}`),
    );
    if (matches.length)
      return matches.reduce((best, path) =>
        path.length < best.length ? path : best,
      );
  }
  return null;
}

/** The branch's open pull request, when `gh` is installed and authenticated. */
async function pullRequest(
  cwd: string,
): Promise<{ number: number; url: string } | null> {
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "view", "--json", "number,url,state"],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object") return null;
    const { number, url, state } = value as {
      number?: unknown;
      url?: unknown;
      state?: unknown;
    };
    // `gh` still answers with a branch's merged or closed pull request; only an
    // open one should hide the Create PR action.
    if (state !== "OPEN") return null;
    if (typeof number !== "number" || typeof url !== "string") return null;
    return { number, url };
  } catch {
    // No `gh`, not logged in, or no pull request for this branch.
    return null;
  }
}

/**
 * Runs `work` once per command id, and answers every later ask with the same
 * outcome. The phone retries a request whose reply it lost under the same id,
 * and polls a Git action under it until the action is done; a start that has
 * already created a session, or a worktree, must not create a second one.
 *
 * The oldest finished entry is dropped once `limit` is reached. One still
 * running is kept, or a retry of its id would start a second write.
 */
export function once(
  jobs: Map<string, Job>,
  id: string,
  params: Record<string, unknown>,
  limit: number,
  work: () => Promise<unknown>,
): Promise<unknown> {
  // Hashed, not kept whole: a message's attachments are megabytes of base64.
  const signature = createHash("sha256")
    .update(JSON.stringify(params))
    .digest("hex");
  const existing = jobs.get(id);
  if (existing) {
    if (existing.signature !== signature)
      throw new Error("Command ID was already used with different input");
    return existing.result;
  }
  if (jobs.size >= limit) {
    // Only a job that has finished; one still running must stay, or a retry of
    // its command id would start a second write to the same index.
    const settled = [...jobs].find(([, job]) => job.settled);
    if (settled) jobs.delete(settled[0]);
  }
  const job: Job = { signature, result: work(), settled: false };
  jobs.set(id, job);
  // The outcome is kept either way. A Git action answered `pending` is polled
  // under the same id, so its failure has to be there to report rather than
  // being run a second time; and the phone makes a new id for a fresh attempt.
  // Settled here too, so an awaited failure is not an unhandled rejection.
  const settle = () => {
    job.settled = true;
  };
  job.result.then(settle, settle);
  return job.result;
}

