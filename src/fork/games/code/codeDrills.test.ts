import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUILTIN_DRILLS } from "./codeDrills";
import {
  buildSource,
  makeMarker,
  parseResults,
  validateDrill,
  type Drill,
} from "./codeModel";

const MARKER = makeMarker(() => 0.42);

/** Runs built JavaScript with a capturing console, as node would print it. */
function runJs(source: string): string {
  const lines: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => lines.push(args.map(String).join(" ")) };
  new Function("console", source)(fakeConsole);
  return lines.join("\n");
}

function jsResults(drill: Drill, code: string) {
  return parseResults(runJs(buildSource(drill, code, MARKER)), MARKER, drill.tests.length);
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;

function pythonResults(drill: Drill, code: string) {
  const ran = spawnSync("python3", ["-"], {
    input: buildSource(drill, code, MARKER),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (ran.status !== 0) {
    throw new Error(`python3 failed for ${drill.id}: ${ran.stderr}`);
  }
  return parseResults(ran.stdout, MARKER, drill.tests.length);
}

describe("built-in drills", () => {
  it("ships at least 40, in both languages and all levels", () => {
    expect(BUILTIN_DRILLS.length).toBeGreaterThanOrEqual(40);
    for (const language of ["javascript", "python"] as const) {
      for (const level of ["easy", "mid", "hard"] as const) {
        expect(
          BUILTIN_DRILLS.some(
            (drill) => drill.language === language && drill.level === level,
          ),
          `${language} ${level}`,
        ).toBe(true);
      }
    }
    const topics = new Set(BUILTIN_DRILLS.map((drill) => drill.topic));
    for (const topic of [
      "strings",
      "arrays",
      "objects",
      "recursion",
      "sorting",
      "sets",
      "maps",
      "closures",
      "logic",
      "dynamic programming",
    ]) {
      expect(topics.has(topic), topic).toBe(true);
    }
  });

  it("all parse as sound drills with one id each", () => {
    const ids = new Set<string>();
    for (const drill of BUILTIN_DRILLS) {
      expect(validateDrill(drill), drill.id).toEqual(drill);
      expect(ids.has(drill.id), drill.id).toBe(false);
      ids.add(drill.id);
      expect(drill.hints.length, drill.id).toBeGreaterThan(0);
    }
  });

  it("every JavaScript solution passes all of its tests", () => {
    for (const drill of BUILTIN_DRILLS.filter((item) => item.language === "javascript")) {
      const results = jsResults(drill, drill.solution);
      expect(
        results.map((result) => result.pass),
        drill.id,
      ).toEqual(drill.tests.map(() => true));
    }
  });

  it("no JavaScript starter passes everything already", () => {
    for (const drill of BUILTIN_DRILLS.filter((item) => item.language === "javascript")) {
      const results = jsResults(drill, drill.starter);
      expect(results.every((result) => result.pass), drill.id).toBe(false);
    }
  });

  // Needs a local python3; where there is none this is skipped, not passed.
  it.skipIf(!hasPython)("every Python solution passes all of its tests", () => {
    for (const drill of BUILTIN_DRILLS.filter((item) => item.language === "python")) {
      const results = pythonResults(drill, drill.solution);
      expect(
        results.map((result) => result.pass),
        drill.id,
      ).toEqual(drill.tests.map(() => true));
    }
  });

  it.skipIf(!hasPython)("no Python starter passes everything already", () => {
    for (const drill of BUILTIN_DRILLS.filter((item) => item.language === "python")) {
      const results = pythonResults(drill, drill.starter);
      expect(results.every((result) => result.pass), drill.id).toBe(false);
    }
  });
});
