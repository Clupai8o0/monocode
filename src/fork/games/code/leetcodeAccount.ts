import type { DrillLanguage } from "./codeModel";
import type { LeetcodeFetch } from "./leetcode";

/**
 * Fork: a connected LeetCode account. The session itself stays in Rust
 * (fork_leetcode.rs); this side reads what it fetches: what the user solved
 * and tried, their recent submissions, and the code of any one of them.
 * A snapshot goes to Dojo's folder as leetcode.json, and Dojo answers with
 * leetcode-picks.json, the problems it wants them on next.
 */

export const LEETCODE_ACCOUNT_EVENT = "monocode:fork-leetcode-account";
export const LEETCODE_SNAPSHOT_KEY = "monocode:fork-code-leetcode-account";
/** A sync older than this runs again when the Code tab shows. */
export const SYNC_EVERY_MS = 30 * 60 * 1000;
const MAX_PAGES = 40;
const RECENT_PAGES = 3;

export type LeetcodeProblem = {
  slug: string;
  title: string;
  number: string;
  difficulty: string;
  tags: string[];
  submissions: number;
  lastSubmitted: string | null;
};

export type LeetcodeSubmission = {
  id: string;
  slug: string;
  title: string;
  status: string;
  lang: string;
  /** Seconds since 1970. */
  time: number;
};

export type LeetcodeSnapshot = {
  username: string;
  syncedAt: number;
  solvedCount: { easy: number; medium: number; hard: number };
  solved: LeetcodeProblem[];
  attempted: LeetcodeProblem[];
  recent: LeetcodeSubmission[];
  tags: { tag: string; solved: number }[];
};

export type LeetcodePick = { slug: string; why: string };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function readProblem(raw: unknown): LeetcodeProblem | null {
  const item = asRecord(raw);
  const slug = asString(item.titleSlug);
  if (!slug) {
    return null;
  }
  return {
    slug,
    title: asString(item.title) || slug,
    number: asString(item.frontendId),
    difficulty: asString(item.difficulty).toLowerCase(),
    tags: asArray(item.topicTags)
      .map((tag) => asString(asRecord(tag).name))
      .filter(Boolean),
    submissions: Number(item.numSubmitted) || 0,
    lastSubmitted: asString(item.lastSubmittedAt) || null,
  };
}

export function readSubmission(raw: unknown): LeetcodeSubmission | null {
  const item = asRecord(raw);
  const id = asString(item.id);
  const slug = asString(item.titleSlug);
  if (!id || !slug) {
    return null;
  }
  return {
    id,
    slug,
    title: asString(item.title) || slug,
    status: asString(item.statusDisplay) || "Unknown",
    lang: asString(item.lang),
    time: Number(item.timestamp) || 0,
  };
}

/** A signed-out session reads as null lists rather than an error. */
const SIGNED_OUT = "LeetCode signed you out. Connect again.";

/** Everything a sync reads, page by page. */
export async function syncLeetcode(
  fetch: LeetcodeFetch,
  username: string,
  now = Date.now(),
): Promise<LeetcodeSnapshot> {
  const solved: LeetcodeProblem[] = [];
  const attempted: LeetcodeProblem[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = asRecord(await fetch("progress", String(page * 100)));
    const list = data.userProgressQuestionList;
    if (!list) {
      throw new Error(SIGNED_OUT);
    }
    const questions = asArray(asRecord(list).questions);
    for (const raw of questions) {
      const problem = readProblem(raw);
      if (!problem) {
        continue;
      }
      const status = asString(asRecord(raw).questionStatus).toUpperCase();
      (status === "SOLVED" ? solved : attempted).push(problem);
    }
    const total = Number(asRecord(list).totalNum) || 0;
    if (questions.length < 100 || (page + 1) * 100 >= total) {
      break;
    }
  }

  const recent: LeetcodeSubmission[] = [];
  for (let page = 0; page < RECENT_PAGES; page += 1) {
    const data = asRecord(await fetch("recent", String(page * 20)));
    const list = asRecord(data.submissionList);
    for (const raw of asArray(list.submissions)) {
      const submission = readSubmission(raw);
      if (submission) {
        recent.push(submission);
      }
    }
    if (list.hasNext !== true) {
      break;
    }
  }

  const solvedCount = { easy: 0, medium: 0, hard: 0 };
  const tags: { tag: string; solved: number }[] = [];
  const user = asRecord(asRecord(await fetch("profile", "")).matchedUser);
  for (const entry of asArray(asRecord(user.submitStatsGlobal).acSubmissionNum)) {
    const row = asRecord(entry);
    const key = asString(row.difficulty).toLowerCase();
    if (key === "easy" || key === "medium" || key === "hard") {
      solvedCount[key] = Number(row.count) || 0;
    }
  }
  const counts = asRecord(user.tagProblemCounts);
  for (const group of ["fundamental", "intermediate", "advanced"]) {
    for (const entry of asArray(counts[group])) {
      const row = asRecord(entry);
      const tag = asString(row.tagName);
      if (tag) {
        tags.push({ tag, solved: Number(row.problemsSolved) || 0 });
      }
    }
  }
  tags.sort((a, b) => b.solved - a.solved || a.tag.localeCompare(b.tag));

  return { username, syncedAt: now, solvedCount, solved, attempted, recent, tags };
}

/** The snapshot as Dojo reads it: plain JSON with a line on what it is. */
export function snapshotForDojo(snapshot: LeetcodeSnapshot): string {
  return `${JSON.stringify(
    {
      about:
        "Written by the Code tab from the user's LeetCode account. Read only. Pick problems into leetcode-picks.json.",
      ...snapshot,
      syncedAt: new Date(snapshot.syncedAt).toISOString(),
    },
    null,
    2,
  )}\n`;
}

export function loadSnapshot(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): LeetcodeSnapshot | null {
  try {
    const raw = JSON.parse(storage?.getItem(LEETCODE_SNAPSHOT_KEY) ?? "null") as unknown;
    const item = asRecord(raw);
    if (!asString(item.username) || !Array.isArray(item.solved)) {
      return null;
    }
    return raw as LeetcodeSnapshot;
  } catch {
    return null;
  }
}

export function saveSnapshot(
  snapshot: LeetcodeSnapshot | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage,
) {
  try {
    if (snapshot) {
      storage?.setItem(LEETCODE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } else {
      storage?.removeItem(LEETCODE_SNAPSHOT_KEY);
    }
  } catch {
    // The next sync writes it again.
  }
}

/** Solved, tried, or neither, by what the last sync saw. */
export function problemState(
  snapshot: LeetcodeSnapshot | null,
  slug: string,
): "solved" | "tried" | null {
  if (!snapshot) {
    return null;
  }
  if (snapshot.solved.some((problem) => problem.slug === slug)) {
    return "solved";
  }
  if (snapshot.attempted.some((problem) => problem.slug === slug)) {
    return "tried";
  }
  return null;
}

/** The slug of a LeetCode drill (lc-<slug>-js|py), or null. */
export function drillSlug(id: string): string | null {
  const match = /^lc-([a-z0-9-]+)-(?:js|py)$/.exec(id);
  return match ? match[1] : null;
}

/** Dojo's picks, keeping only well-formed entries, in its order, no repeats. */
export function parsePicks(text: string): LeetcodePick[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : asArray(asRecord(raw).picks);
  const seen = new Set<string>();
  const picks: LeetcodePick[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    const slug = asString(item.slug).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,120}$/.test(slug) || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    picks.push({ slug, why: asString(item.why).trim().slice(0, 200) });
    if (picks.length >= 12) {
      break;
    }
  }
  return picks;
}

/** The user's submissions on one problem, newest first. */
export async function loadSubmissions(
  fetch: LeetcodeFetch,
  slug: string,
): Promise<LeetcodeSubmission[]> {
  const data = asRecord(await fetch("submissions", slug));
  const list = data.questionSubmissionList;
  if (!list) {
    throw new Error(SIGNED_OUT);
  }
  return asArray(asRecord(list).submissions)
    .map(readSubmission)
    .filter((item): item is LeetcodeSubmission => item !== null)
    .sort((a, b) => b.time - a.time);
}

/** The Code tab language a LeetCode language runs as, or null. */
export function drillLanguageFor(lang: string): DrillLanguage | null {
  const name = lang.toLowerCase();
  if (name === "javascript") {
    return "javascript";
  }
  if (name === "python3" || name === "python") {
    return "python";
  }
  return null;
}

/** One submission's code. */
export async function loadSubmissionCode(
  fetch: LeetcodeFetch,
  id: string,
): Promise<{ code: string; lang: string }> {
  const details = asRecord(asRecord(await fetch("submission", id)).submissionDetails);
  const code = asString(details.code);
  if (!code) {
    throw new Error("LeetCode did not send that submission's code.");
  }
  return { code, lang: asString(asRecord(details.lang).name) };
}

/** "just now", "3h ago", "2d ago", or a date for anything older than a month. */
export function ago(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, now / 1000 - seconds);
  if (diff < 60) {
    return "just now";
  }
  if (diff < 3600) {
    return `${Math.max(1, Math.round(diff / 60))}m ago`;
  }
  if (diff < 86400) {
    return `${Math.round(diff / 3600)}h ago`;
  }
  if (diff < 30 * 86400) {
    return `${Math.round(diff / 86400)}d ago`;
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** What Ask Dojo sends when the user wants LeetCode problems picked. */
export function pickPrompt(dojoFolder: string): string {
  return [
    "Pick my next LeetCode problems.",
    `My LeetCode account is synced to ${dojoFolder}/leetcode.json (solved, attempted, recent submissions, solved count by topic). Read it with progress.md and plan.md.`,
    `Write ${dojoFolder}/leetcode-picks.json: a JSON array of 3 to 6 {"slug","why"}, best first. slug is the problem's LeetCode slug (two-sum). why is one short line on the skill it trains.`,
    "Prefer: problems I tried and never solved, weak topics, a solved one that is due for review, a step up in difficulty when a topic is solid. Skip Premium problems and anything I solved recently.",
    "The Code tab runs JavaScript and Python against the examples, but not linked lists, trees, class-design or in-place problems; I can still open those on LeetCode, so pick them only when they matter.",
    "Then tell me in a few lines why these, and update progress.md.",
  ].join("\n");
}

/** LeetCode's judge on one submission. */
export type LeetcodeVerdict = {
  accepted: boolean;
  status: string;
  passed: number | null;
  total: number | null;
  runtime: string;
  memory: string;
  /** What went wrong, in a few lines, or "". */
  detail: string;
};

const VERDICTS: Record<number, string> = {
  10: "Accepted",
  11: "Wrong Answer",
  12: "Memory Limit Exceeded",
  13: "Output Limit Exceeded",
  14: "Time Limit Exceeded",
  15: "Runtime Error",
  16: "Internal Error",
  20: "Compile Error",
};

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A judged submission's verdict, or null while LeetCode is still judging. */
export function readVerdict(raw: unknown): LeetcodeVerdict | null {
  const details = asRecord(asRecord(raw).submissionDetails);
  const code = Number(details.statusCode);
  const status = VERDICTS[code];
  if (!status) {
    return null;
  }
  const total = Number.isFinite(Number(details.totalTestcases)) && details.totalTestcases != null
    ? Number(details.totalTestcases)
    : null;
  const passed = Number.isFinite(Number(details.totalCorrect)) && details.totalCorrect != null
    ? Number(details.totalCorrect)
    : null;
  const lines: string[] = [];
  const compile = asString(details.compileError);
  const runtime = asString(details.runtimeError);
  const input = asString(details.lastTestcase);
  if (code === 20 && compile) {
    lines.push(clip(compile));
  }
  if (code === 15 && runtime) {
    lines.push(clip(runtime));
  }
  if (code !== 10 && code !== 20 && input) {
    lines.push(`Input: ${clip(input.replace(/\n/g, ", "))}`);
    const expected = asString(details.expectedOutput);
    const got = asString(details.codeOutput);
    if (code === 11 && expected) {
      lines.push(`Expected: ${clip(expected)}`);
    }
    if (code === 11 && got) {
      lines.push(`Got: ${clip(got)}`);
    }
  }
  return {
    accepted: code === 10,
    status,
    passed,
    total,
    runtime: asString(details.runtimeDisplay),
    memory: asString(details.memoryDisplay),
    detail: lines.join("\n"),
  };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks for the verdict until LeetCode has judged it, about a minute at most. */
export async function waitForVerdict(
  fetch: LeetcodeFetch,
  id: string,
  { tries = 40, wait = pause }: { tries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<LeetcodeVerdict> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await wait(attempt === 0 ? 1000 : 1500);
    const verdict = readVerdict(await fetch("submission", id));
    if (verdict) {
      return verdict;
    }
  }
  throw new Error("LeetCode is still judging. Its verdict will show in Your submissions.");
}

/** "Accepted · 3/3 tests · 52 ms · 17.1 MB" */
export function verdictLine(verdict: LeetcodeVerdict): string {
  const parts = [verdict.status];
  if (verdict.passed !== null && verdict.total !== null) {
    parts.push(`${verdict.passed}/${verdict.total} tests`);
  }
  if (verdict.accepted && verdict.runtime) {
    parts.push(verdict.runtime);
  }
  if (verdict.accepted && verdict.memory) {
    parts.push(verdict.memory);
  }
  return parts.join(" · ");
}
