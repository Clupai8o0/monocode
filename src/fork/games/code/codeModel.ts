/**
 * Fork: the Code tab's plain logic — building a drill run, reading its
 * results, scoring, streaks and picking what to practise next. No React and
 * no Tauri here, so every rule is tested on its own.
 */

export type DrillLevel = "easy" | "mid" | "hard";
export type DrillLanguage = "javascript" | "python";

export type DrillTest = { call: string; expect: string };

/** Same shape as the drills.json Dojo writes (see dojoMono.ts). */
export type Drill = {
  id: string;
  title: string;
  topic: string;
  level: DrillLevel;
  language: DrillLanguage;
  task: string;
  starter: string;
  tests: DrillTest[];
  hints: string[];
  solution: string;
};

/** What the native runner hands back (fork_code_run). */
export type CodeRunResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  /** Stdout was longer than the runner keeps, so early lines are gone. */
  truncated: boolean;
};

export type TestResult = {
  index: number;
  pass: boolean;
  actual?: string;
  expect?: string;
  error?: string;
};

/** Ask Dojo asks App to open the Dojo Mono with this event. */
export const OPEN_DOJO_EVENT = "monocode:fork-open-dojo";

/** The stats row in the panel header listens for this after a run. */
export const CODE_PROGRESS_EVENT = "monocode:fork-code-progress";

const PROGRESS_KEY = "monocode.fork.games.code.progress";

/** Days after a solve when a drill comes back for review. */
export const REVIEW_DAYS = [1, 3, 7, 21] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKey(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The panel's low, mid and hard chips, in drill words. */
export function levelForMode(mode: string): DrillLevel {
  return mode === "low" ? "easy" : mode === "hard" ? "hard" : "mid";
}

/**
 * Result lines start with a marker made fresh for each run, so code under
 * test can't print its own pass lines and be believed.
 */
export function makeMarker(random: () => number = Math.random): string {
  const part = () => Math.floor(random() * 0xffffffff).toString(16);
  return `__dojo_${part()}${part()}__:`;
}

/** The user's code plus a small test runner, ready for the native runner. */
export function buildSource(drill: Drill, code: string, marker: string): string {
  const mark = JSON.stringify(marker);
  if (drill.language === "python") {
    const runs = drill.tests
      .map(
        (test, index) => `try:
    __actual = (${test.call})
    __expect = (${test.expect})
    print("\\n" + ${mark} + json.dumps({"index": ${index}, "pass": bool(__actual == __expect), "actual": __show(__actual), "expect": __show(__expect)}))
except Exception as __error:
    print("\\n" + ${mark} + json.dumps({"index": ${index}, "pass": False, "error": str(__error) or type(__error).__name__}))`,
      )
      .join("\n");
    return `${code}

import json as __dojo_json
json = __dojo_json

def __show(value):
    try:
        return json.dumps(value)
    except Exception:
        return repr(value)

${runs}
`;
  }
  const runs = drill.tests
    .map(
      (test, index) => `try {
  const __actual = (${test.call});
  const __expect = (${test.expect});
  console.log("\\n" + ${mark} + JSON.stringify({ index: ${index}, pass: __same(__actual, __expect), actual: __show(__actual), expect: __show(__expect) }));
} catch (__error) {
  console.log("\\n" + ${mark} + JSON.stringify({ index: ${index}, pass: false, error: __error instanceof Error ? __error.message : String(__error) }));
}`,
    )
    .join("\n");
  return `${code}

function __same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && __same(a[key], b[key]));
}
function __show(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
${runs}
`;
}

/** One result per test; a test that never reported counts as failed. */
export function parseResults(stdout: string, marker: string, count: number): TestResult[] {
  const found = new Map<number, TestResult>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(marker)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line.slice(marker.length));
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const row = parsed as Record<string, unknown>;
      if (typeof row.index !== "number" || typeof row.pass !== "boolean") {
        continue;
      }
      found.set(row.index, {
        index: row.index,
        pass: row.pass,
        actual: typeof row.actual === "string" ? row.actual : undefined,
        expect: typeof row.expect === "string" ? row.expect : undefined,
        error: typeof row.error === "string" ? row.error : undefined,
      });
    } catch {
      // A broken line is not a result; the test it meant fails below.
    }
  }
  return Array.from({ length: count }, (_, index) =>
    found.get(index) ?? { index, pass: false, error: "No result came back for this test." },
  );
}

/** 100 for a clean first try, less for hints and extra tries, never under 10. */
export function scoreFor(tries: number, hintsUsed: number): number {
  const extraTries = Math.max(0, tries - 1);
  return Math.max(10, 100 - 25 * Math.max(0, hintsUsed) - 10 * extraTries);
}

export type DrillProgress = {
  attempts: number;
  /** Hints opened by the latest run on this drill. */
  hintsUsed: number;
  /** When it was last solved, or null while it is still unsolved. */
  solvedAt: number | null;
  /** How many of REVIEW_DAYS have been cleared. */
  reviewsDone: number;
  bestScore: number;
};

export type CodeProgress = {
  totalPoints: number;
  drills: Record<string, DrillProgress>;
  /** Day (dayKey) to the drills solved that day. */
  solvedByDay: Record<string, string[]>;
};

export function emptyProgress(): CodeProgress {
  return { totalPoints: 0, drills: {}, solvedByDay: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads progress back, dropping anything that doesn't look the part. */
export function parseProgress(raw: string | null): CodeProgress {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!isRecord(parsed)) {
      return emptyProgress();
    }
    const drills: Record<string, DrillProgress> = {};
    if (isRecord(parsed.drills)) {
      for (const [id, value] of Object.entries(parsed.drills)) {
        if (!isRecord(value)) {
          continue;
        }
        drills[id] = {
          attempts: typeof value.attempts === "number" ? value.attempts : 0,
          hintsUsed: typeof value.hintsUsed === "number" ? value.hintsUsed : 0,
          solvedAt: typeof value.solvedAt === "number" ? value.solvedAt : null,
          reviewsDone: typeof value.reviewsDone === "number" ? value.reviewsDone : 0,
          bestScore: typeof value.bestScore === "number" ? value.bestScore : 0,
        };
      }
    }
    const solvedByDay: Record<string, string[]> = {};
    if (isRecord(parsed.solvedByDay)) {
      for (const [day, value] of Object.entries(parsed.solvedByDay)) {
        if (Array.isArray(value)) {
          solvedByDay[day] = value.filter((id): id is string => typeof id === "string");
        }
      }
    }
    return {
      totalPoints: typeof parsed.totalPoints === "number" ? parsed.totalPoints : 0,
      drills,
      solvedByDay,
    };
  } catch {
    return emptyProgress();
  }
}

export function loadProgress(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): CodeProgress {
  try {
    return parseProgress(storage?.getItem(PROGRESS_KEY) ?? null);
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(
  progress: CodeProgress,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
) {
  try {
    storage?.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Practice still counts on screen; a full or blocked store just forgets it.
  }
}

/**
 * Folds one finished run into progress. Points only grow past a drill's best
 * score, so solving the same drill over and over earns nothing new.
 */
export function recordRun(
  progress: CodeProgress,
  drillId: string,
  run: { allPassed: boolean; tries: number; hintsUsed: number },
  now: number,
): { progress: CodeProgress; score: number; earned: number } {
  const before: DrillProgress = progress.drills[drillId] ?? {
    attempts: 0,
    hintsUsed: 0,
    solvedAt: null,
    reviewsDone: 0,
    bestScore: 0,
  };
  const next: DrillProgress = {
    ...before,
    attempts: before.attempts + 1,
    hintsUsed: run.hintsUsed,
  };
  let score = 0;
  let earned = 0;
  const solvedByDay = { ...progress.solvedByDay };
  if (run.allPassed) {
    score = scoreFor(run.tries, run.hintsUsed);
    earned = Math.max(0, score - before.bestScore);
    next.bestScore = Math.max(before.bestScore, score);
    // A review only counts when it was actually due; pressing Run again on
    // code that is already solved must not use one up or move the date.
    if (before.solvedAt === null) {
      next.solvedAt = now;
    } else if (isDue(before, now)) {
      next.reviewsDone = Math.min(REVIEW_DAYS.length, before.reviewsDone + 1);
      next.solvedAt = now;
    }
    const day = dayKey(now);
    const solvedToday = solvedByDay[day] ?? [];
    if (!solvedToday.includes(drillId)) {
      solvedByDay[day] = [...solvedToday, drillId];
    }
  }
  return {
    progress: {
      totalPoints: progress.totalPoints + earned,
      drills: { ...progress.drills, [drillId]: next },
      solvedByDay,
    },
    score,
    earned,
  };
}

/** Days in a row with at least one solve, counting back from today. */
export function streakDays(progress: CodeProgress, now: number): number {
  let streak = 0;
  let cursor = now;
  // A streak is still alive in the morning, before today's first solve.
  if (!progress.solvedByDay[dayKey(cursor)]?.length) {
    cursor -= DAY_MS;
  }
  while (progress.solvedByDay[dayKey(cursor)]?.length) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

export function solvedTodayCount(progress: CodeProgress, now: number): number {
  return progress.solvedByDay[dayKey(now)]?.length ?? 0;
}

/** A solved drill whose next review day has arrived. */
export function isDue(entry: DrillProgress | undefined, now: number): boolean {
  if (!entry || entry.solvedAt === null || entry.reviewsDone >= REVIEW_DAYS.length) {
    return false;
  }
  return now - entry.solvedAt >= REVIEW_DAYS[entry.reviewsDone] * DAY_MS;
}

/**
 * What to practise next: reviews that are due first (oldest solve first),
 * then unsolved drills at the chosen level, then anything unsolved in the
 * language. The current drill is skipped while anything else fits.
 */
export function pickNextDrill(
  drills: readonly Drill[],
  progress: CodeProgress,
  pick: { level: DrillLevel; language: DrillLanguage },
  now: number,
  excludeId?: string,
): Drill | null {
  const inLanguage = drills.filter((drill) => drill.language === pick.language);
  const entry = (drill: Drill) => progress.drills[drill.id];
  const due = inLanguage
    .filter((drill) => isDue(entry(drill), now))
    .sort((a, b) => (entry(a)?.solvedAt ?? 0) - (entry(b)?.solvedAt ?? 0));
  const unsolvedAtLevel = inLanguage.filter(
    (drill) => drill.level === pick.level && entry(drill)?.solvedAt == null,
  );
  const unsolved = inLanguage.filter((drill) => entry(drill)?.solvedAt == null);
  const pools = [due, unsolvedAtLevel, unsolved, [...inLanguage]];
  for (const pool of pools) {
    const fresh = pool.find((drill) => drill.id !== excludeId);
    if (fresh) {
      return fresh;
    }
  }
  return inLanguage[0] ?? drills[0] ?? null;
}

const LEVELS: readonly string[] = ["easy", "mid", "hard"];
const LANGUAGES: readonly string[] = ["javascript", "python"];

/** One drills.json entry, or null when any field is missing or mistyped. */
export function validateDrill(value: unknown): Drill | null {
  if (!isRecord(value)) {
    return null;
  }
  const text = (field: string) => (typeof value[field] === "string" ? value[field] : null);
  const id = text("id");
  const title = text("title");
  const topic = text("topic");
  const task = text("task");
  const starter = text("starter");
  const solution = text("solution");
  const level = text("level");
  const language = text("language");
  if (
    !id ||
    !title ||
    topic === null ||
    !task ||
    starter === null ||
    !solution ||
    !level ||
    !LEVELS.includes(level) ||
    !language ||
    !LANGUAGES.includes(language) ||
    !Array.isArray(value.tests) ||
    value.tests.length === 0 ||
    !Array.isArray(value.hints)
  ) {
    return null;
  }
  const tests: DrillTest[] = [];
  for (const test of value.tests) {
    if (!isRecord(test) || typeof test.call !== "string" || typeof test.expect !== "string") {
      return null;
    }
    tests.push({ call: test.call, expect: test.expect });
  }
  const hints: string[] = [];
  for (const hint of value.hints) {
    if (typeof hint !== "string") {
      return null;
    }
    hints.push(hint);
  }
  return {
    id,
    title,
    topic,
    level: level as DrillLevel,
    language: language as DrillLanguage,
    task,
    starter,
    tests,
    hints,
    solution,
  };
}

/** Splits a drills.json file into the drills that work and the names that don't. */
export function validateDrills(data: unknown): { drills: Drill[]; invalid: string[] } {
  if (!Array.isArray(data)) {
    return { drills: [], invalid: ["the whole file (it is not a list)"] };
  }
  const drills: Drill[] = [];
  const invalid: string[] = [];
  data.forEach((entry, index) => {
    const drill = validateDrill(entry);
    if (drill) {
      drills.push(drill);
    } else {
      const name =
        isRecord(entry) && typeof entry.id === "string" && entry.id ? entry.id : null;
      invalid.push(name ?? `the drill at place ${index + 1}`);
    }
  });
  return { drills, invalid };
}

/** Dojo's drills join the built-in ones; on a shared id, Dojo's wording wins. */
export function mergeDrills(
  builtin: readonly Drill[],
  extra: readonly Drill[],
): Drill[] {
  const extraById = new Map(extra.map((drill) => [drill.id, drill]));
  const merged = builtin.map((drill) => extraById.get(drill.id) ?? drill);
  const known = new Set(builtin.map((drill) => drill.id));
  const seen = new Set<string>();
  for (const drill of extra) {
    if (!known.has(drill.id) && !seen.has(drill.id)) {
      merged.push(drill);
    }
    seen.add(drill.id);
  }
  return merged;
}
