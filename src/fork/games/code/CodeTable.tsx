import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { readTextFile, writeTextFile } from "../../../platform/tauri/fs";
import { DOJO_FOLDER, DOJO_MONO } from "../../starterMonos/dojoMono";
import { starterMonoId } from "../../starterMonos/starterMono";
import { ChipSelect } from "../ChipSelect";
import { gamesPanel } from "../gamesPanelStore";
import { CodeConsole } from "./CodeConsole";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { testCallNames } from "./codeNames";
import { BUILTIN_DRILLS } from "./codeDrills";
import {
  loadLeetcode,
  loadSavedLeetcode,
  parseLeetcodeInput,
  saveLeetcode,
  withPythonImports,
  type LeetcodeFetch,
  type LeetcodeRequest,
} from "./leetcode";
import {
  LEETCODE_ACCOUNT_EVENT,
  SYNC_EVERY_MS,
  ago,
  drillLanguageFor,
  drillSlug,
  loadSnapshot,
  loadSubmissionCode,
  loadSubmissions,
  parsePicks,
  pickPrompt,
  problemState,
  saveSnapshot,
  snapshotForDojo,
  syncLeetcode,
  verdictLine,
  waitForVerdict,
  type LeetcodePick,
  type LeetcodeVerdict,
  type LeetcodeSnapshot,
  type LeetcodeSubmission,
} from "./leetcodeAccount";
import {
  CODE_PROGRESS_EVENT,
  OPEN_DOJO_EVENT,
  buildSource,
  levelForMode,
  loadProgress,
  makeMarker,
  mergeDrills,
  parseResults,
  parseRunError,
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
  type RunErrorSummary,
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

const LEVEL_OPTIONS = (["easy", "mid", "hard"] as DrillLevel[]).map((id) => ({
  id,
  label: id,
}));
const LANGUAGES: { id: DrillLanguage; label: string }[] = [
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

export type RunCode = (language: DrillLanguage, source: string) => Promise<CodeRunResult>;

const nativeRunCode: RunCode = (language, source) =>
  invoke<CodeRunResult>("fork_code_run", { language, source });

const nativeFetchLeetcode: LeetcodeFetch = (kind, value) =>
  invoke<unknown>("fork_leetcode_fetch", { kind, value });

/** The account side of LeetCode: sign-in, sign-out, and Dojo's files. */
export type LeetcodeAccountApi = {
  /** The connected username, or null. */
  current: () => Promise<string | null>;
  /** Opens the sign-in window; the account arrives through onChange. */
  connect: () => Promise<void>;
  /** A pasted LEETCODE_SESSION and csrftoken; gives back the username. */
  paste: (session: string, csrf: string) => Promise<string>;
  disconnect: () => Promise<void>;
  onChange: (listener: (event: { username?: string | null; error?: string | null }) => void) => () => void;
  /** leetcode.json for Dojo, only while its folder exists. */
  writeForDojo: (text: string) => Promise<void>;
  /** Dojo's leetcode-picks.json, or "" when there is none. */
  readPicks: () => Promise<string>;
  /** Sends an answer to LeetCode's judge; gives back the submission id. */
  submit: (slug: string, language: DrillLanguage, code: string) => Promise<string>;
};

async function dojoFolderExists(): Promise<boolean> {
  const found = await invoke<{ isDir: boolean }[]>("inspect_paths", { paths: [DOJO_FOLDER] });
  return found.some((entry) => entry.isDir);
}

const nativeLeetcodeAccount: LeetcodeAccountApi = {
  current: () => invoke<string | null>("fork_leetcode_account"),
  connect: () => invoke<void>("fork_leetcode_connect"),
  paste: (session, csrf) => invoke<string>("fork_leetcode_connect_paste", { session, csrf }),
  disconnect: () => invoke<void>("fork_leetcode_disconnect"),
  onChange: (listener) => {
    const pending = listen<{ username?: string | null; error?: string | null }>(
      LEETCODE_ACCOUNT_EVENT,
      ({ payload }) => listener(payload),
    );
    // Outside the app (tests) there is nothing to listen to.
    pending.catch(() => undefined);
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => undefined);
    };
  },
  writeForDojo: async (text) => {
    if (await dojoFolderExists()) {
      await writeTextFile(`${DOJO_FOLDER}/leetcode.json`, text);
    }
  },
  submit: (slug, language, code) =>
    invoke<string>("fork_leetcode_submit", { slug, lang: language, code }),
  readPicks: async () => {
    try {
      return await readTextFile(`${DOJO_FOLDER}/leetcode-picks.json`);
    } catch {
      return "";
    }
  },
};

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
  /** The code as it was run: run-file line N is this code's line N. */
  codeLines: string[];
  errorSummary: RunErrorSummary | null;
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
  fetchLeetcode = nativeFetchLeetcode,
  leetcodeAccount = nativeLeetcodeAccount,
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
  fetchLeetcode?: LeetcodeFetch;
  leetcodeAccount?: LeetcodeAccountApi;
}) {
  const [progress, setProgress] = useState<CodeProgress>(loadProgress);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  // LeetCode drills fetched before stay, so their reviews come back too.
  const [drills, setDrills] = useState<Drill[]>(
    () => drillsProp ?? mergeDrills(BUILTIN_DRILLS, loadSavedLeetcode()),
  );
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
  const [syntaxErrors, setSyntaxErrors] = useState(0);
  const [leetcodeText, setLeetcodeText] = useState("");
  const [leetcodeBusy, setLeetcodeBusy] = useState(false);
  const [nameWarnings, setNameWarnings] = useState(0);
  // The connected LeetCode account: undefined until the keychain answers.
  const [lcUser, setLcUser] = useState<string | null | undefined>(undefined);
  const [lcSnapshot, setLcSnapshot] = useState<LeetcodeSnapshot | null>(loadSnapshot);
  const [lcSyncing, setLcSyncing] = useState(false);
  const [lcPanel, setLcPanel] = useState<"account" | "paste" | null>(null);
  const [lcPaste, setLcPaste] = useState({ session: "", csrf: "" });
  const [lcPicks, setLcPicks] = useState<LeetcodePick[]>([]);
  // LeetCode's verdict on the last answer sent from each drill.
  const [lcVerdicts, setLcVerdicts] = useState<
    Record<string, { judging: true } | { judging: false; verdict: LeetcodeVerdict }>
  >({});
  const [lcSubmissions, setLcSubmissions] = useState<{
    slug: string;
    list: LeetcodeSubmission[] | null;
  } | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);

  const drill = drills.find((item) => item.id === currentId) ?? drills[0] ?? null;
  const code = drill ? (codeById[drill.id] ?? drill.starter) : "";
  const session: Session = (drill && sessionById[drill.id]) || { tries: 0, failed: 0 };
  const hintsShown = drill ? (hintsById[drill.id] ?? 0) : 0;
  const lastRun = drill ? lastRunById[drill.id] : undefined;
  // What the editor shows now, so a run that ends after a drill switch or an
  // edit doesn't mark a line in code it never ran.
  const shownRef = useRef({ id: drill?.id, code });
  shownRef.current = { id: drill?.id, code };

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

  // Each sign-in or sign-out starts a new generation; a sync from an older
  // one finishes without touching anything.
  const lcGeneration = useRef(0);
  const syncAccount = async (username: string) => {
    const generation = lcGeneration.current;
    setLcSyncing(true);
    try {
      const snapshot = await syncLeetcode(fetchLeetcode, username);
      if (generation !== lcGeneration.current) {
        return false;
      }
      setLcSnapshot(snapshot);
      saveSnapshot(snapshot);
      await leetcodeAccount.writeForDojo(snapshotForDojo(snapshot)).catch(() => undefined);
      return true;
    } catch (error) {
      if (generation === lcGeneration.current) {
        setNote(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (generation === lcGeneration.current) {
        setLcSyncing(false);
      }
    }
  };

  const onConnected = (username: string) => {
    lcGeneration.current += 1;
    setLcUser(username);
    setLcPanel(null);
    setLcPaste({ session: "", csrf: "" });
    setNote(`Connected to LeetCode as ${username}. Loading your problems…`);
    void syncAccount(username).then((ok) => {
      if (ok) {
        setNote(null);
      }
    });
  };
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Who is connected, and the sign-in window's answer when it comes.
  useEffect(() => {
    let live = true;
    void leetcodeAccount
      .current()
      .then((name) => {
        if (live) {
          setLcUser(name);
        }
      })
      .catch(() => {
        if (live) {
          setLcUser(null);
        }
      });
    const stop = leetcodeAccount.onChange(({ username, error }) => {
      if (username) {
        onConnectedRef.current(username);
      } else if (error) {
        setNote(error);
      }
    });
    return () => {
      live = false;
      stop();
    };
  }, [leetcodeAccount]);

  // A stale sync runs again, and Dojo's picks are read, whenever the tab shows.
  useEffect(() => {
    if (active === false || !lcUser) {
      return;
    }
    let live = true;
    if (!lcSnapshot || lcSnapshot.username !== lcUser || Date.now() - lcSnapshot.syncedAt > SYNC_EVERY_MS) {
      void syncAccount(lcUser);
    }
    void leetcodeAccount
      .readPicks()
      .then((text) => {
        if (live) {
          setLcPicks(parsePicks(text));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // syncAccount reads the props of the moment; showing the tab is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, lcUser]);

  const connectAccount = () => {
    onInput?.();
    setNote("Sign in on the LeetCode window. It closes by itself once you are in.");
    leetcodeAccount.connect().catch((error: unknown) => {
      setNote(error instanceof Error ? error.message : String(error));
    });
  };

  const pasteAccount = () => {
    onInput?.();
    setNote("Checking with LeetCode…");
    leetcodeAccount
      .paste(lcPaste.session, lcPaste.csrf)
      .then(onConnected)
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error));
      });
  };

  const disconnectAccount = () => {
    onInput?.();
    void leetcodeAccount
      .disconnect()
      .then(() => {
        lcGeneration.current += 1;
        setLcSyncing(false);
        setLcUser(null);
        setLcSnapshot(null);
        saveSnapshot(null);
        setLcPanel(null);
        setLcSubmissions(null);
        setNote("Disconnected from LeetCode.");
      })
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error));
      });
  };

  const askDojo = (prompt?: string) => {
    onInput?.();
    if (!hasDojo()) {
      setNote("Dojo was removed.");
      return;
    }
    window.dispatchEvent(new CustomEvent(OPEN_DOJO_EVENT, { detail: prompt ? { prompt } : null }));
    // Dojo's chat on the left, this drill on the right.
    gamesPanel.dock(true);
  };

  const showSubmissions = async (slug: string) => {
    if (lcSubmissions?.slug === slug) {
      setLcSubmissions(null);
      return;
    }
    onInput?.();
    setLcSubmissions({ slug, list: null });
    try {
      const list = await loadSubmissions(fetchLeetcode, slug);
      setLcSubmissions((current) => (current?.slug === slug ? { slug, list } : current));
    } catch (error) {
      setLcSubmissions(null);
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  /** Puts a past submission's code into the drill of its language. */
  const openSubmission = async (slug: string, submission: LeetcodeSubmission) => {
    const target = drillLanguageFor(submission.lang);
    const id = target ? `lc-${slug}-${target === "python" ? "py" : "js"}` : null;
    const into = id ? drillsRef.current.find((item) => item.id === id) : undefined;
    if (!into) {
      setNote(`The Code tab can't run ${submission.lang || "that language"}.`);
      return;
    }
    onInput?.();
    try {
      const { code: past } = await loadSubmissionCode(fetchLeetcode, submission.id);
      // LeetCode's Python adds typing, collections and the like by itself.
      const runnable = into.language === "python" ? withPythonImports(past) : past;
      setCodeById((current) => ({ ...current, [into.id]: runnable }));
      goTo(into);
      setNote(`Loaded your ${submission.status.toLowerCase()} submission from ${ago(submission.time)}.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  /** Sends this drill's code to LeetCode, and shows the verdict here. */
  const submitToLeetcode = async () => {
    const target = drill;
    const targetSlug = target ? drillSlug(target.id) : null;
    if (!target || !targetSlug || lcVerdicts[target.id]?.judging) {
      return;
    }
    onInput?.();
    const answer = codeById[target.id] ?? target.starter;
    setLcVerdicts((current) => ({ ...current, [target.id]: { judging: true } }));
    try {
      const id = await leetcodeAccount.submit(targetSlug, target.language, answer);
      const verdict = await waitForVerdict(fetchLeetcode, id);
      setLcVerdicts((current) => ({ ...current, [target.id]: { judging: false, verdict } }));
      // The solved list, Dojo's copy and Your submissions catch up.
      setLcSubmissions((current) => (current?.slug === targetSlug ? null : current));
      if (verdict.accepted && lcUser) {
        void syncAccount(lcUser);
      }
    } catch (error) {
      setLcVerdicts((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      });
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  const fetchFromLeetcode = async (request: LeetcodeRequest | null) => {
    if (leetcodeBusy) {
      return;
    }
    if (!request) {
      setNote("Type a LeetCode number, name or link.");
      return;
    }
    onInput?.();
    setLeetcodeBusy(true);
    setNote("Fetching from LeetCode…");
    try {
      const fresh = await loadLeetcode(fetchLeetcode, request);
      saveLeetcode(fresh);
      setDrills((current) => mergeDrills(current, fresh));
      const next = fresh.find((item) => item.language === language) ?? fresh[0];
      setNote(
        next.language === language
          ? null
          : `LeetCode has no ${language === "python" ? "Python" : "JavaScript"} starter for this one.`,
      );
      setLeetcodeText("");
      setLevel(next.level);
      goTo(next);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setLeetcodeBusy(false);
    }
  };

  const run = async () => {
    if (!drill || running) {
      return;
    }
    onInput?.();
    setRunning(true);
    setRunError(null);
    editorRef.current?.clearErrorLine();
    const marker = makeMarker();
    const codeLines = code.split("\n");
    const source = buildSource(drill, code, marker);
    const tries = session.tries + 1;
    try {
      const outcome = await runCode(drill.language, source);
      const lines = outcome.stdout.split("\n");
      const results = parseResults(outcome.stdout, marker, drill.tests.length);
      const errorSummary = parseRunError(drill.language, outcome.stderr, codeLines);
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
          codeLines,
          errorSummary,
        },
      }));
      if (
        errorSummary?.where === "code" &&
        errorSummary.line !== null &&
        shownRef.current.id === drill.id &&
        shownRef.current.code === code
      ) {
        editorRef.current?.markErrorLine(errorSummary.line);
      }
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
  const slug = drillSlug(drill.id);
  const slugState = slug ? problemState(lcSnapshot, slug) : null;

  return (
    <div
      data-fork-code-table=""
      className="flex h-full flex-col gap-2 overflow-hidden px-3 pt-1 pb-3"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <ChipSelect
            label="Language"
            value={language}
            options={LANGUAGES}
            onChange={(id) => {
              setLanguage(id);
              pickFor(level, id);
            }}
            width={130}
          />
          <ChipSelect
            label="Level"
            value={level}
            options={LEVEL_OPTIONS}
            onChange={(id) => {
              setLevel(id);
              pickFor(id, language);
            }}
            width={110}
          />
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

      <div className="flex flex-wrap items-center gap-0.5" data-fork-code-leetcode="">
        <span className="pr-1 text-[11px] text-content/45">LeetCode</span>
        <button
          type="button"
          tabIndex={-1}
          disabled={leetcodeBusy}
          className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
          onClick={() => void fetchFromLeetcode({ kind: "daily" })}
        >
          Daily
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={leetcodeBusy}
          title={`A random ${level} problem`}
          className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
          onClick={() => void fetchFromLeetcode({ kind: "random", level })}
        >
          Random
        </button>
        <input
          type="text"
          value={leetcodeText}
          disabled={leetcodeBusy}
          placeholder="number, name or link"
          aria-label="LeetCode problem"
          spellCheck={false}
          className="h-6 w-40 rounded bg-content/5 px-1.5 text-[11px] text-content placeholder:text-content/35 focus:outline-none"
          onChange={(event) => setLeetcodeText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void fetchFromLeetcode(parseLeetcodeInput(leetcodeText));
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={leetcodeBusy || !leetcodeText.trim()}
          className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
          onClick={() => void fetchFromLeetcode(parseLeetcodeInput(leetcodeText))}
        >
          {leetcodeBusy ? "Fetching…" : "Load"}
        </button>
        <span className="ml-auto flex items-center gap-0.5" data-fork-leetcode-account="">
          {lcUser ? (
            <>
              <button
                type="button"
                tabIndex={-1}
                title="Dojo picks your next problems from your LeetCode history"
                className={`${CHIP} ${CHIP_OFF}`}
                data-fork-leetcode-pick=""
                onClick={() => askDojo(pickPrompt(DOJO_FOLDER))}
              >
                Pick for me
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-pressed={lcPanel === "account"}
                className={`${CHIP} ${lcPanel === "account" ? CHIP_ON : CHIP_OFF}`}
                onClick={() => setLcPanel(lcPanel === "account" ? null : "account")}
              >
                {lcSyncing ? "Syncing…" : `@${lcUser}`}
              </button>
            </>
          ) : lcUser === null ? (
            <>
              <button
                type="button"
                tabIndex={-1}
                className={`${CHIP} ${CHIP_OFF}`}
                data-fork-leetcode-connect=""
                onClick={connectAccount}
              >
                Connect account
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-pressed={lcPanel === "paste"}
                title="Paste your LeetCode session instead of signing in here"
                className={`${CHIP} ${lcPanel === "paste" ? CHIP_ON : CHIP_OFF}`}
                onClick={() => setLcPanel(lcPanel === "paste" ? null : "paste")}
              >
                Paste
              </button>
            </>
          ) : null}
        </span>
      </div>

      {lcPanel === "account" && lcUser ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content/60"
          data-fork-leetcode-summary=""
        >
          {lcSnapshot ? (
            <span>
              {lcSnapshot.solved.length} solved ({lcSnapshot.solvedCount.easy} easy,{" "}
              {lcSnapshot.solvedCount.medium} medium, {lcSnapshot.solvedCount.hard} hard),{" "}
              {lcSnapshot.attempted.length} tried, synced {ago(lcSnapshot.syncedAt / 1000, now)}
            </span>
          ) : (
            <span>Not synced yet.</span>
          )}
          <button
            type="button"
            tabIndex={-1}
            disabled={lcSyncing}
            className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
            onClick={() => void syncAccount(lcUser)}
          >
            Sync
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={`${CHIP} ${CHIP_OFF}`}
            onClick={disconnectAccount}
          >
            Disconnect
          </button>
        </div>
      ) : null}

      {lcPanel === "paste" && !lcUser ? (
        <form
          className="flex flex-wrap items-center gap-1 text-[11px] text-content/60"
          data-fork-leetcode-paste=""
          onSubmit={(event) => {
            event.preventDefault();
            pasteAccount();
          }}
        >
          <span>From leetcode.com cookies:</span>
          <input
            type="password"
            value={lcPaste.session}
            placeholder="LEETCODE_SESSION"
            aria-label="LEETCODE_SESSION"
            className="h-6 w-36 rounded bg-content/5 px-1.5 text-[11px] text-content placeholder:text-content/35 focus:outline-none"
            onChange={(event) => setLcPaste({ ...lcPaste, session: event.target.value })}
          />
          <input
            type="password"
            value={lcPaste.csrf}
            placeholder="csrftoken"
            aria-label="csrftoken"
            className="h-6 w-28 rounded bg-content/5 px-1.5 text-[11px] text-content placeholder:text-content/35 focus:outline-none"
            onChange={(event) => setLcPaste({ ...lcPaste, csrf: event.target.value })}
          />
          <button
            type="submit"
            tabIndex={-1}
            disabled={!lcPaste.session.trim() || !lcPaste.csrf.trim()}
            className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
          >
            Connect
          </button>
        </form>
      ) : null}

      {lcUser && lcPicks.length ? (
        <div className="flex flex-wrap items-center gap-0.5" data-fork-leetcode-picks="">
          <span className="pr-1 text-[11px] text-content/45">Dojo picks</span>
          {lcPicks.map((pick) => {
            const state = problemState(lcSnapshot, pick.slug);
            const known =
              lcSnapshot?.solved.find((item) => item.slug === pick.slug) ??
              lcSnapshot?.attempted.find((item) => item.slug === pick.slug);
            return (
              <button
                key={pick.slug}
                type="button"
                tabIndex={-1}
                disabled={leetcodeBusy}
                title={pick.why || undefined}
                className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
                onClick={() => void fetchFromLeetcode({ kind: "question", slug: pick.slug })}
              >
                {known?.title ?? pick.slug}
                {state === "solved" ? " ✓" : state === "tried" ? " ·" : ""}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-medium text-content">{drill.title}</h3>
        <span className="text-[11px] text-content/45">
          {drill.topic} · {drill.level}
        </span>
        {lcUser && slug ? (
          <span className="ml-auto flex items-baseline gap-1">
            {slugState ? (
              <span className="text-[11px] text-content/45" data-fork-leetcode-state={slugState}>
                {slugState === "solved" ? "solved on LeetCode" : "tried on LeetCode"}
              </span>
            ) : null}
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={lcSubmissions?.slug === slug}
              className={`${CHIP} ${lcSubmissions?.slug === slug ? CHIP_ON : CHIP_OFF}`}
              data-fork-leetcode-submissions-toggle=""
              onClick={() => void showSubmissions(slug)}
            >
              Your submissions
            </button>
          </span>
        ) : null}
      </div>
      {lcSubmissions && lcSubmissions.slug === slug ? (
        <div className="flex max-h-28 shrink-0 flex-col gap-0.5 overflow-y-auto" data-fork-leetcode-submissions="">
          {lcSubmissions.list === null ? (
            <p className="text-[11px] text-content/50">Loading your submissions…</p>
          ) : lcSubmissions.list.length === 0 ? (
            <p className="text-[11px] text-content/50">No submissions on LeetCode yet.</p>
          ) : (
            lcSubmissions.list.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-[11px] text-content/65">
                <span className={item.status === "Accepted" ? "text-content" : "text-content/55"}>
                  {item.status}
                </span>
                <span className="text-content/45">
                  {item.lang} · {ago(item.time, now)}
                </span>
                {drillLanguageFor(item.lang) ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`${CHIP} ${CHIP_OFF} ml-auto`}
                    onClick={() => void openSubmission(slug, item)}
                  >
                    Open
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
      <p className="max-h-40 shrink-0 overflow-y-auto text-[12px] leading-relaxed whitespace-pre-wrap text-content/75">
        {drill.task}
      </p>
      {note ? (
        <p className="text-[11px] text-content/50" data-fork-code-note="">
          {note}
        </p>
      ) : null}

      <div className="flex min-h-44 flex-1 flex-col">
        <CodeEditor
          ref={editorRef}
          drillId={drill.id}
          language={drill.language}
          value={code}
          onChange={(next) =>
            setCodeById((current) => ({ ...current, [drill.id]: next }))
          }
          onRun={() => void run()}
          onSyntaxErrors={setSyntaxErrors}
          onNameWarnings={setNameWarnings}
          testNames={testCallNames(drill.tests)}
        />
      </div>

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
        {lcUser && slug ? (
          <button
            type="button"
            tabIndex={-1}
            disabled={lcVerdicts[drill.id]?.judging === true}
            title="Send this answer to LeetCode's judge, as you"
            data-fork-leetcode-submit=""
            className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}
            onClick={() => void submitToLeetcode()}
          >
            {lcVerdicts[drill.id]?.judging ? "Judging…" : "Submit to LeetCode"}
          </button>
        ) : null}
        {syntaxErrors > 0 ? (
          <span
            data-fork-code-syntax-errors=""
            className="px-1 text-[11px] text-content/45"
          >
            {syntaxErrors} syntax {syntaxErrors === 1 ? "error" : "errors"}
          </span>
        ) : nameWarnings > 0 ? (
          <span
            data-fork-code-name-warnings=""
            className="px-1 text-[11px] text-amber-400/80"
          >
            {nameWarnings} {nameWarnings === 1 ? "name" : "names"} to check
          </span>
        ) : null}
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
          data-fork-code-format=""
          className={`${CHIP} ${CHIP_OFF}`}
          onClick={() => void editorRef.current?.format()}
        >
          Format
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
          onClick={() => askDojo()}
        >
          Ask Dojo
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {drill.hints.slice(0, hintsShown).map((hint, index) => (
          <p key={index} className="text-[12px] leading-relaxed text-content/65">
            Hint: {hint}
          </p>
        ))}

        {(() => {
          const entry = lcVerdicts[drill.id];
          if (!entry || entry.judging) {
            return null;
          }
          const { verdict } = entry;
          return (
            <div className="flex flex-col gap-0.5" data-fork-leetcode-verdict={verdict.status}>
              <p
                className={`text-[12px] ${verdict.accepted ? "font-medium text-content" : "text-content/80"}`}
              >
                LeetCode: {verdictLine(verdict)}
              </p>
              {verdict.detail ? (
                <pre className="font-mono text-[11px] whitespace-pre-wrap text-content/60">
                  {verdict.detail}
                </pre>
              ) : null}
            </div>
          );
        })()}

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
                    {result.pass ? "Pass" : "Fail"} —{" "}
                    {drill.tests[result.index]?.label ?? drill.tests[result.index]?.call}
                    {!result.pass && result.error
                      ? `: ${result.error}`
                      : !result.pass
                        ? `: expected ${result.expect ?? drill.tests[result.index]?.expect}, got ${result.actual ?? "nothing"}`
                        : ""}
                  </p>
                ))
              : null}
            {!lastRun.hadResults && !lastRun.stderr && !lastRun.timedOut ? (
              <p className="text-[12px] text-content/80">
                No test results came back. Check the code runs at all.
              </p>
            ) : null}
            {lastRun.output || lastRun.stderr || lastRun.truncated ? (
              <CodeConsole
                key={`${drill.id}:${session.tries}`}
                language={drill.language}
                stdout={lastRun.output}
                stderr={lastRun.stderr}
                truncated={lastRun.truncated}
                codeLines={lastRun.codeLines}
                summary={lastRun.errorSummary}
                openOnErrors={!lastRun.hadResults}
                onGoToLine={(line) => editorRef.current?.goToLine(line)}
              />
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
    </div>
  );
}
