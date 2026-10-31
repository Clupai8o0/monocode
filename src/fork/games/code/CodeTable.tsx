import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { readTextFile, writeTextFile } from "../../../platform/tauri/fs";
import { DOJO_FOLDER, DOJO_MONO } from "../../starterMonos/dojoMono";
import { starterMonoId } from "../../starterMonos/starterMono";
import { gamesPanel } from "../gamesPanelStore";
import { BUILTIN_DRILLS } from "./codeDrills";
import {
  CODE_PROGRESS_EVENT,
  OPEN_DOJO_EVENT,
  buildSource,
  levelForMode,
  loadProgress,
  makeMarker,
  mergeDrills,
  parseResults,
  pickNextDrill,
  recordRun,
  saveProgress,
  solvedTodayCount,
  streakDays,
  validateDrills,
  type CodeProgress,
  type CodeRunResult,
  type Drill,
  type DrillLanguage,
  type DrillLevel,
  type TestResult,
} from "./codeModel";

/**
 * Fork: short coding drills in the Games panel, next to the table games.
 * The panel keeps this mounted, and every drill keeps its own code, tries
 * and hints here, so switching tabs never loses work.
 */

// The panel header's chips (see GamesPanel.tsx), used as they are.
const CHIP =
  "h-6 cursor-pointer whitespace-nowrap rounded px-1.5 text-[11px] leading-none";
const CHIP_ON = "bg-content/10 text-content";
const CHIP_OFF = "text-content/50 hover:bg-content/10 hover:text-content";

const LEVELS: DrillLevel[] = ["easy", "mid", "hard"];
const LANGUAGES: { id: DrillLanguage; label: string }[] = [
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

export type RunCode = (language: DrillLanguage, source: string) => Promise<CodeRunResult>;

const nativeRunCode: RunCode = (language, source) =>
  invoke<CodeRunResult>("fork_code_run", { language, source });

/** Ask Dojo only closes the panel while its Mono is still there. */
const hasDojoMono = () => starterMonoId(DOJO_MONO) !== undefined;

/** Dojo's own drills, when the folder and file are there. Missing is normal. */
async function loadDojoDrills(): Promise<{ drills: Drill[]; invalid: string[] }> {
  let text: string;
  try {
    text = await readTextFile(`${DOJO_FOLDER}/drills.json`);
  } catch {
    return { drills: [], invalid: [] };
  }
  try {
    return validateDrills(JSON.parse(text) as unknown);
  } catch {
    return { drills: [], invalid: ["the whole file (it is not JSON)"] };
  }
}

/** A copy of progress for Dojo to read, only while its folder exists. */
async function saveDojoProgress(progress: CodeProgress): Promise<void> {
  try {
    const found = await invoke<{ isDir: boolean }[]>("inspect_paths", {
      paths: [DOJO_FOLDER],
    });
    if (!found.some((entry) => entry.isDir)) {
      return;
    }
    await writeTextFile(
      `${DOJO_FOLDER}/progress.json`,
      `${JSON.stringify(progress, null, 2)}\n`,
    );
  } catch {
    // The game keeps its own copy; Dojo's can wait for a better day.
  }
}

type LastRun = {
  results: TestResult[];
  hadResults: boolean;
  output: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  score: number;
  allPassed: boolean;
};

type Session = { tries: number; failed: number };

export function CodeTable({
  mode,
  runId,
  active,
  onInput,
  runCode = nativeRunCode,
  drills: drillsProp,
  loadExtraDrills = loadDojoDrills,
  saveProgressFile = saveDojoProgress,
  hasDojo = hasDojoMono,
}: {
  mode: ArcadeMode;
  runId: number;
  active?: boolean;
  waiting?: number;
  onExit?: () => void;
  onInput?: () => void;
  runCode?: RunCode;
  drills?: Drill[];
  loadExtraDrills?: typeof loadDojoDrills;
  saveProgressFile?: typeof saveDojoProgress;
  hasDojo?: () => boolean;
}) {
  const [progress, setProgress] = useState<CodeProgress>(loadProgress);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const [drills, setDrills] = useState<Drill[]>(() => drillsProp ?? BUILTIN_DRILLS);
  const drillsRef = useRef(drills);
  drillsRef.current = drills;
  const [language, setLanguage] = useState<DrillLanguage>("javascript");
  const [level, setLevel] = useState<DrillLevel>(() => levelForMode(mode));
  const [currentId, setCurrentId] = useState<string | null>(
    () =>
      pickNextDrill(
        drillsProp ?? BUILTIN_DRILLS,
        progressRef.current,
        { level: levelForMode(mode), language: "javascript" },
        Date.now(),
      )?.id ?? null,
  );
  const [codeById, setCodeById] = useState<Record<string, string>>({});
  const [sessionById, setSessionById] = useState<Record<string, Session>>({});
  const [hintsById, setHintsById] = useState<Record<string, number>>({});
  const [lastRunById, setLastRunById] = useState<Record<string, LastRun>>({});
  const [showSolution, setShowSolution] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const drill = drills.find((item) => item.id === currentId) ?? drills[0] ?? null;
  const code = drill ? (codeById[drill.id] ?? drill.starter) : "";
  const session: Session = (drill && sessionById[drill.id]) || { tries: 0, failed: 0 };
  const hintsShown = drill ? (hintsById[drill.id] ?? 0) : 0;
  const lastRun = drill ? lastRunById[drill.id] : undefined;

  // Dojo's drills load whenever this tab is shown. The panel keeps it
  // mounted, so a drill Dojo writes later would otherwise never appear.
  // The editor's code lives apart from this list, so it survives the reload.
  // A test harness that hands drills in skips this.
  useEffect(() => {
    if (drillsProp || active === false) {
      return;
    }
    let live = true;
    void loadExtraDrills()
      .then(({ drills: extra, invalid }) => {
        if (!live) {
          return;
        }
        if (extra.length) {
          setDrills((current) => mergeDrills(current, extra));
        }
        if (invalid.length) {
          setNote(
            `Some drills in the Dojo folder could not be used: ${invalid.join(", ")}.`,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [active, drillsProp, loadExtraDrills]);

  const goTo = (next: Drill | null) => {
    if (!next || next.id === currentId) {
      return;
    }
    setCurrentId(next.id);
    setLanguage(next.language);
    setShowSolution(false);
    setRunError(null);
  };

  const pickFor = (nextLevel: DrillLevel, nextLanguage: DrillLanguage) => {
    if (drill && drill.language === nextLanguage && drill.level === nextLevel) {
      return;
    }
    goTo(
      pickNextDrill(
        drillsRef.current,
        progressRef.current,
        { level: nextLevel, language: nextLanguage },
        Date.now(),
      ),
    );
  };

  // The panel's difficulty chips drive the level here too.
  const modeLevel = levelForMode(mode);
  useEffect(() => {
    setLevel(modeLevel);
    pickFor(modeLevel, language);
    // pickFor reads the drill of the moment; the mode change is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeLevel]);

  // The panel's New game button moves on to another drill. The other table
  // games share that counter, so only a run started while this tab is up
  // may move the hidden Code tab to a different drill.
  const seenRun = useRef(runId);
  useEffect(() => {
    if (seenRun.current === runId) {
      return;
    }
    seenRun.current = runId;
    if (!active) {
      return;
    }
    goTo(
      pickNextDrill(
        drillsRef.current,
        progressRef.current,
        { level, language },
        Date.now(),
        drill?.id,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, active]);

  const run = async () => {
    if (!drill || running) {
      return;
    }
    onInput?.();
    setRunning(true);
    setRunError(null);
    const marker = makeMarker();
    const source = buildSource(drill, code, marker);
    const tries = session.tries + 1;
    try {
      const outcome = await runCode(drill.language, source);
      const lines = outcome.stdout.split("\n");
      const results = parseResults(outcome.stdout, marker, drill.tests.length);
      const allPassed = results.every((result) => result.pass);
      // Another window may have scored since this one last saved, so start
      // from the store's copy instead of overwriting those points.
      const latest = loadProgress();
      progressRef.current = latest;
      const recorded = recordRun(
        latest,
        drill.id,
        { allPassed, tries, hintsUsed: hintsShown },
        Date.now(),
      );
      setProgress(recorded.progress);
      saveProgress(recorded.progress);
      window.dispatchEvent(new Event(CODE_PROGRESS_EVENT));
      void saveProgressFile(recorded.progress).catch(() => undefined);
      setSessionById((current) => ({
        ...current,
        [drill.id]: { tries, failed: session.failed + (allPassed ? 0 : 1) },
      }));
      setLastRunById((current) => ({
        ...current,
        [drill.id]: {
          results,
          hadResults: lines.some((line) => line.startsWith(marker)),
          output: lines
            .filter((line) => !line.startsWith(marker))
            .join("\n")
            .trim(),
          stderr: outcome.stderr.trim(),
          timedOut: outcome.timedOut,
          truncated: outcome.truncated,
          score: recorded.score,
          allPassed,
        },
      }));
    } catch (error) {
      setSessionById((current) => ({
        ...current,
        [drill.id]: { tries, failed: session.failed + 1 },
      }));
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Nothing typed here may reach the panel's game keys.
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void run();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (!drill) {
        return;
      }
      const box = event.currentTarget;
      const indent = drill.language === "python" ? "    " : "  ";
      const next =
        box.value.slice(0, box.selectionStart) +
        indent +
        box.value.slice(box.selectionEnd);
      const caret = box.selectionStart + indent.length;
      setCodeById((current) => ({ ...current, [drill.id]: next }));
      requestAnimationFrame(() => {
        box.selectionStart = caret;
        box.selectionEnd = caret;
      });
    }
  };

  if (!drill) {
    return (
      <div
        data-fork-code-table=""
        className="flex h-full items-center justify-center p-3 text-[12px] text-content/60"
      >
        No drills yet. Ask Dojo to set some.
      </div>
    );
  }

  const now = Date.now();
  const streak = streakDays(progress, now);
  const canSeeSolution = session.failed >= 2;

  return (
    <div
      data-fork-code-table=""
      className="flex h-full flex-col gap-2 overflow-y-auto px-3 pt-1 pb-3"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-0.5" aria-label="Language">
          {LANGUAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              tabIndex={-1}
              aria-pressed={language === item.id}
              className={`${CHIP} ${language === item.id ? CHIP_ON : CHIP_OFF}`}
              onClick={() => {
                setLanguage(item.id);
                pickFor(level, item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5" aria-label="Level">
          {LEVELS.map((id) => (
            <button
              key={id}
              type="button"
              tabIndex={-1}
              aria-pressed={level === id}
              className={`${CHIP} ${level === id ? CHIP_ON : CHIP_OFF}`}
              onClick={() => {
                setLevel(id);
                pickFor(id, language);
              }}
            >
              {id}
            </button>
          ))}
        </div>
        <span
          className="ml-auto font-mono text-[11px] tabular-nums text-content/55"
          data-fork-code-stats=""
        >
          <span data-fork-code-points={progress.totalPoints}>
            points {progress.totalPoints}
          </span>
          {` · streak ${streak} ${streak === 1 ? "day" : "days"} · solved today ${solvedTodayCount(progress, now)}`}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-medium text-content">{drill.title}</h3>
        <span className="text-[11px] text-content/45">
          {drill.topic} · {drill.level}
        </span>
      </div>
      <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-content/75">
        {drill.task}
      </p>
      {note ? (
        <p className="text-[11px] text-content/50" data-fork-code-note="">
          {note}
        </p>
      ) : null}

      <textarea
        data-table-board=""
        data-fork-code-editor=""
        aria-label="Your code"
        spellCheck={false}
        className="h-44 w-full shrink-0 resize-none rounded bg-content/5 p-2 font-mono text-[12px] leading-relaxed text-content outline-none"
        value={code}
        onChange={(event) =>
          setCodeById((current) => ({ ...current, [drill.id]: event.target.value }))
        }
        onKeyDown={onEditorKeyDown}
      />

      <div className="flex flex-wrap items-center gap-0.5">
        <button
          type="button"
          tabIndex={-1}
          disabled={running}
          className={`${CHIP} ${CHIP_ON} disabled:opacity-40`}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Run"}
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={hintsShown >= drill.hints.length}
          className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
          onClick={() =>
            setHintsById((current) => ({
              ...current,
              [drill.id]: Math.min(drill.hints.length, hintsShown + 1),
            }))
          }
        >
          Hint
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={!canSeeSolution}
          title={canSeeSolution ? undefined : "Try twice first"}
          className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
          onClick={() => setShowSolution((shown) => !shown)}
        >
          Show solution
        </button>
        <button
          type="button"
          tabIndex={-1}
          className={`${CHIP} ${CHIP_OFF}`}
          onClick={() =>
            goTo(pickNextDrill(drills, progress, { level, language }, Date.now(), drill.id))
          }
        >
          Next
        </button>
        <button
          type="button"
          tabIndex={-1}
          className={`${CHIP} ${CHIP_OFF} ml-auto`}
          onClick={() => {
            onInput?.();
            if (!hasDojo()) {
              setNote("Dojo was removed.");
              return;
            }
            window.dispatchEvent(new Event(OPEN_DOJO_EVENT));
            gamesPanel.hide();
          }}
        >
          Ask Dojo
        </button>
      </div>

      {drill.hints.slice(0, hintsShown).map((hint, index) => (
        <p key={index} className="text-[12px] leading-relaxed text-content/65">
          Hint: {hint}
        </p>
      ))}

      {runError ? (
        <p role="alert" className="text-[12px] text-content/80">
          {runError}
        </p>
      ) : null}

      {lastRun ? (
        <div className="flex flex-col gap-1" data-fork-code-results="">
          {lastRun.allPassed ? (
            <p
              role="status"
              className="text-[12px] font-medium text-content"
              data-fork-code-score={lastRun.score}
            >
              Solved. {lastRun.score} points.
            </p>
          ) : null}
          {lastRun.timedOut ? (
            <p className="text-[12px] text-content/80">
              It ran too long and was stopped.
            </p>
          ) : null}
          {lastRun.hadResults
            ? lastRun.results.map((result) => (
                <p
                  key={result.index}
                  className="font-mono text-[11px] leading-relaxed text-content/70"
                  data-fork-code-result={result.index}
                  data-pass={result.pass ? "" : undefined}
                >
                  {result.pass ? "Pass" : "Fail"} — {drill.tests[result.index]?.call}
                  {!result.pass && result.error
                    ? `: ${result.error}`
                    : !result.pass
                      ? `: expected ${result.expect ?? drill.tests[result.index]?.expect}, got ${result.actual ?? "nothing"}`
                      : ""}
                </p>
              ))
            : null}
          {!lastRun.hadResults && lastRun.stderr ? (
            <pre className="overflow-x-auto rounded bg-content/5 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-content/75">
              {lastRun.stderr.split("\n").slice(-6).join("\n")}
            </pre>
          ) : null}
          {!lastRun.hadResults && !lastRun.stderr && !lastRun.timedOut ? (
            <p className="text-[12px] text-content/80">
              No test results came back. Check the code runs at all.
            </p>
          ) : null}
          {lastRun.output ? (
            <div>
              <p className="text-[11px] text-content/45">Your output</p>
              <pre
                data-fork-code-output=""
                className="overflow-x-auto rounded bg-content/5 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-content/75"
              >
                {lastRun.truncated
                  ? "Earlier output was cut; this is the last 64 KB.\n"
                  : ""}
                {lastRun.output.slice(0, 2000)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {showSolution && canSeeSolution ? (
        <pre
          data-fork-code-solution=""
          className="overflow-x-auto rounded bg-content/5 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-content/80"
        >
          {drill.solution}
        </pre>
      ) : null}
    </div>
  );
}
