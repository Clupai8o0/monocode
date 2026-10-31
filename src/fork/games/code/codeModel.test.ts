import { describe, expect, it } from "vitest";
import {
  REVIEW_DAYS,
  buildSource,
  dayKey,
  emptyProgress,
  isDue,
  levelForMode,
  loadProgress,
  makeMarker,
  mergeDrills,
  parseProgress,
  parseResults,
  pickNextDrill,
  recordRun,
  saveProgress,
  scoreFor,
  solvedTodayCount,
  streakDays,
  validateDrills,
  type CodeProgress,
  type Drill,
} from "./codeModel";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 0, 10, 12).getTime();

function drill(id: string, over: Partial<Drill> = {}): Drill {
  return {
    id,
    title: id,
    topic: "logic",
    level: "easy",
    language: "javascript",
    task: "Do it.",
    starter: "function f(x) {}\n",
    tests: [{ call: "f(1)", expect: "1" }],
    hints: ["Think."],
    solution: "function f(x) { return x; }\n",
    ...over,
  };
}

/** Runs built JavaScript with a capturing console, as node would print it. */
function runJs(source: string): string {
  const lines: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => lines.push(args.map(String).join(" ")) };
  new Function("console", source)(fakeConsole);
  return lines.join("\n");
}

describe("buildSource and parseResults", () => {
  it("reports each test on its own, and a throw fails only that test", () => {
    const marker = makeMarker(() => 0.5);
    const two = drill("two", {
      tests: [
        { call: "f(1)", expect: "1" },
        { call: "f(2)", expect: "2" },
      ],
    });
    const code =
      "function f(x) { if (x === 1) { throw new Error(\"boom\"); } return x; }\n";
    const results = parseResults(runJs(buildSource(two, code, marker)), marker, 2);
    expect(results[0]).toMatchObject({ index: 0, pass: false, error: "boom" });
    expect(results[1]).toMatchObject({ index: 1, pass: true });
  });

  it("compares lists and objects by value", () => {
    const marker = makeMarker(() => 0.25);
    const shapes = drill("shapes", {
      tests: [
        { call: "f(1)", expect: "[1, { a: 2 }]" },
        { call: "f(2)", expect: "({ b: 1 })" },
      ],
    });
    const code = "function f(x) { return x === 1 ? [1, { a: 2 }] : { b: 2 }; }\n";
    const results = parseResults(runJs(buildSource(shapes, code, marker)), marker, 2);
    expect(results.map((result) => result.pass)).toEqual([true, false]);
    expect(results[1].actual).toBe('{"b":2}');
  });

  it("ignores printouts that fake a pass without the run's marker", () => {
    const marker = makeMarker(() => 0.75);
    const stdout = [
      JSON.stringify({ index: 0, pass: true }),
      `__dojo_fake__:${JSON.stringify({ index: 0, pass: true })}`,
      "just chatting",
    ].join("\n");
    const results = parseResults(stdout, marker, 1);
    expect(results[0].pass).toBe(false);
    expect(results[0].error).toMatch(/No result/);
  });

  it("makes a fresh marker each time", () => {
    const values = [0.1, 0.2, 0.3, 0.4];
    const random = () => values.shift() ?? 0;
    expect(makeMarker(random)).not.toBe(makeMarker(random));
  });

  it("builds the same shape for python", () => {
    const source = buildSource(
      drill("py", { language: "python" }),
      "def f(x):\n    return x\n",
      "__dojo_x__:",
    );
    expect(source).toContain("json.dumps");
    expect(source).toContain("__dojo_x__:");
    expect(source).toContain("except Exception");
  });
});

describe("scoreFor", () => {
  it("is 100 clean, less for hints and tries, never under 10", () => {
    expect(scoreFor(1, 0)).toBe(100);
    expect(scoreFor(1, 1)).toBe(75);
    expect(scoreFor(1, 2)).toBe(50);
    expect(scoreFor(2, 0)).toBe(90);
    expect(scoreFor(3, 2)).toBe(30);
    expect(scoreFor(20, 5)).toBe(10);
  });
});

describe("progress", () => {
  it("counts attempts, banks points once, and marks the day solved", () => {
    const failed = recordRun(
      emptyProgress(),
      "a",
      { allPassed: false, tries: 1, hintsUsed: 0 },
      NOW,
    );
    expect(failed.progress.drills.a.attempts).toBe(1);
    expect(failed.progress.totalPoints).toBe(0);

    const solved = recordRun(
      failed.progress,
      "a",
      { allPassed: true, tries: 2, hintsUsed: 1 },
      NOW,
    );
    expect(solved.score).toBe(65);
    expect(solved.earned).toBe(65);
    expect(solved.progress.drills.a.solvedAt).toBe(NOW);
    expect(solved.progress.drills.a.hintsUsed).toBe(1);
    expect(solvedTodayCount(solved.progress, NOW)).toBe(1);

    const again = recordRun(
      solved.progress,
      "a",
      { allPassed: true, tries: 3, hintsUsed: 1 },
      NOW,
    );
    expect(again.earned).toBe(0);
    expect(again.progress.totalPoints).toBe(65);
    expect(solvedTodayCount(again.progress, NOW)).toBe(1);
  });

  it("keeps a streak over days in a row, alive the next morning", () => {
    const progress: CodeProgress = {
      totalPoints: 0,
      drills: {},
      solvedByDay: {
        [dayKey(NOW)]: ["a"],
        [dayKey(NOW - DAY)]: ["b"],
        [dayKey(NOW - 2 * DAY)]: ["c"],
        [dayKey(NOW - 4 * DAY)]: ["d"],
      },
    };
    expect(streakDays(progress, NOW)).toBe(3);
    expect(streakDays(progress, NOW + DAY)).toBe(3);
    expect(streakDays(progress, NOW + 2 * DAY)).toBe(0);
    expect(streakDays(emptyProgress(), NOW)).toBe(0);
  });

  it("round-trips through storage and shrugs off junk", () => {
    const cells = new Map<string, string>();
    const storage = {
      getItem: (key: string) => cells.get(key) ?? null,
      setItem: (key: string, value: string) => void cells.set(key, value),
    };
    const solved = recordRun(
      emptyProgress(),
      "a",
      { allPassed: true, tries: 1, hintsUsed: 0 },
      NOW,
    ).progress;
    saveProgress(solved, storage);
    expect(loadProgress(storage)).toEqual(solved);
    expect(parseProgress("not json")).toEqual(emptyProgress());
    expect(parseProgress('{"totalPoints":"many"}')).toEqual(emptyProgress());
  });
});

describe("pickNextDrill", () => {
  const drills = [
    drill("easy-1"),
    drill("easy-2"),
    drill("mid-1", { level: "mid" }),
    drill("py-1", { language: "python" }),
  ];

  it("takes a due review before anything new", () => {
    let progress = recordRun(
      emptyProgress(),
      "mid-1",
      { allPassed: true, tries: 1, hintsUsed: 0 },
      NOW - 2 * DAY,
    ).progress;
    progress = recordRun(
      progress,
      "easy-1",
      { allPassed: true, tries: 1, hintsUsed: 0 },
      NOW,
    ).progress;
    const next = pickNextDrill(
      drills,
      progress,
      { level: "easy", language: "javascript" },
      NOW,
    );
    expect(next?.id).toBe("mid-1");
  });

  it("follows the review steps 1, 3, 7 and 21 days, then stops", () => {
    expect(REVIEW_DAYS).toEqual([1, 3, 7, 21]);
    const solvedLongAgo = {
      attempts: 1,
      hintsUsed: 0,
      solvedAt: NOW - 30 * DAY,
      reviewsDone: 0,
      bestScore: 100,
    };
    expect(isDue(solvedLongAgo, NOW)).toBe(true);
    expect(isDue({ ...solvedLongAgo, reviewsDone: 4 }, NOW)).toBe(false);
    expect(isDue({ ...solvedLongAgo, solvedAt: NOW }, NOW)).toBe(false);
    expect(isDue(undefined, NOW)).toBe(false);
  });

  it("then takes unsolved drills at the chosen level and language", () => {
    const progress = recordRun(
      emptyProgress(),
      "easy-1",
      { allPassed: true, tries: 1, hintsUsed: 0 },
      NOW,
    ).progress;
    expect(
      pickNextDrill(drills, progress, { level: "easy", language: "javascript" }, NOW)?.id,
    ).toBe("easy-2");
    expect(
      pickNextDrill(drills, progress, { level: "easy", language: "python" }, NOW)?.id,
    ).toBe("py-1");
  });

  it("skips the drill on screen while another fits", () => {
    const next = pickNextDrill(
      drills,
      emptyProgress(),
      { level: "easy", language: "javascript" },
      NOW,
      "easy-1",
    );
    expect(next?.id).toBe("easy-2");
    expect(levelForMode("low")).toBe("easy");
    expect(levelForMode("mid")).toBe("mid");
    expect(levelForMode("hard")).toBe("hard");
  });
});

describe("drills.json handling", () => {
  it("keeps sound drills and names the broken ones", () => {
    const good = drill("from-dojo");
    const { drills, invalid } = validateDrills([
      good,
      { id: "no-tests", title: "X" },
      { title: "nameless" },
      "text",
      { ...good, id: "bad-level", level: "steep" },
    ]);
    expect(drills).toEqual([good]);
    expect(invalid).toEqual(["no-tests", "the drill at place 3", "the drill at place 4", "bad-level"]);
    expect(validateDrills({ not: "a list" }).invalid).toHaveLength(1);
  });

  it("merges Dojo drills over built-in ones with the same id", () => {
    const builtin = [drill("a"), drill("b")];
    const extra = [drill("b", { title: "Dojo's b" }), drill("c"), drill("c")];
    const merged = mergeDrills(builtin, extra);
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(merged[1].title).toBe("Dojo's b");
  });
});
