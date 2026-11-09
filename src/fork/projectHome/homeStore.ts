/**
 * Fork feature: Project home. Which home page is open (one project's, or All
 * projects), each project's parsed roadmap, chats put on a phase by hand,
 * and the launcher App registers for starting chats from the page.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { isInFlightSession } from "../../features/sessions/model/inFlight";
import type { Session } from "../../features/sessions/model/session";
import {
  readTextFile,
  statFiles,
  writeTextFile,
} from "../../platform/tauri/fs";
import {
  PLAN_FILES,
  parsePlan,
  setPhaseStatus,
  type PhaseStatus,
  type Plan,
} from "./planModel";

/** Off under the test runner, so upstream tests see no extra reads. */
export const FORK_PROJECT_HOME = import.meta.env.MODE !== "test";

// --- Which page is open -------------------------------------------------------

export type HomePage = { kind: "home"; cwd: string } | { kind: "all" };

/** A project switch right after opening moves the active tab; ignore that. */
const OPEN_GRACE_MS = 3000;

let page: HomePage | null = null;
let openedAt = 0;
/** Goes up each time the user opens a home page. */
let openCount = 0;
const pageListeners = new Set<() => void>();

function emitPage() {
  for (const listener of pageListeners) {
    listener();
  }
}

function subscribePage(listener: () => void): () => void {
  pageListeners.add(listener);
  return () => {
    pageListeners.delete(listener);
  };
}

function currentPage(): HomePage | null {
  return page;
}

export function useHomePage(): HomePage | null {
  return useSyncExternalStore(subscribePage, currentPage, currentPage);
}

export function homePageOpen(): boolean {
  return page !== null;
}

export function openProjectHome(cwd: string) {
  openCount += 1;
  followProjectHome(cwd);
}

/** Points an open home at the sidebar's new project; not a user open. */
export function followProjectHome(cwd: string) {
  openedAt = Date.now();
  if (page?.kind === "home" && page.cwd === cwd) {
    return;
  }
  page = { kind: "home", cwd };
  emitPage();
}

export function openAllProjects() {
  openCount += 1;
  openedAt = Date.now();
  if (page?.kind === "all") {
    return;
  }
  page = { kind: "all" };
  emitPage();
}

/** Read before a slow step; pass to closeHomePage to keep a page opened since. */
export function homeOpenCount(): number {
  return openCount;
}

/** Closes the page, unless `ifOpenCount` is given and the user opened one since. */
export function closeHomePage(ifOpenCount?: number) {
  if (!page || (ifOpenCount !== undefined && ifOpenCount !== openCount)) {
    return;
  }
  page = null;
  emitPage();
}

/** True while a tab change is still part of opening the page. */
export function withinOpenGrace(now: number = Date.now()): boolean {
  return now - openedAt < OPEN_GRACE_MS;
}

// --- Roadmaps -------------------------------------------------------------------

export type PlanState = {
  /** False until the first look at the project's files finishes. */
  loaded: boolean;
  /** Project-relative path of the roadmap, or null when there is none. */
  file: string | null;
  plan: Plan | null;
  mtimeMs: number | null;
};

const EMPTY: PlanState = { loaded: false, file: null, plan: null, mtimeMs: null };
const NONE: PlanState = { loaded: true, file: null, plan: null, mtimeMs: null };
const POLL_MS = 20_000;

const plans = new Map<string, PlanState>();
const planListeners = new Set<() => void>();
const loading = new Map<string, Promise<void>>();

function emitPlans() {
  for (const listener of planListeners) {
    listener();
  }
}

function subscribePlans(listener: () => void): () => void {
  planListeners.add(listener);
  return () => {
    planListeners.delete(listener);
  };
}

function root(cwd: string): string {
  return cwd.replace(/\/+$/, "");
}

function local(cwd: string): boolean {
  return cwd.startsWith("/");
}

async function load(cwd: string): Promise<void> {
  if (!FORK_PROJECT_HOME || !local(cwd)) {
    plans.set(cwd, NONE);
    emitPlans();
    return;
  }
  const paths = PLAN_FILES.map((file) => `${root(cwd)}/${file}`);
  let stats: { path: string; mtimeMs: number | null }[] = [];
  try {
    stats = await statFiles(paths);
  } catch {
    stats = [];
  }
  const found = PLAN_FILES.map((file, i) => ({
    file,
    mtimeMs: stats.find((stat) => stat.path === paths[i])?.mtimeMs ?? null,
  }));
  // The first file that exists and holds a roadmap table wins.
  for (const candidate of found) {
    if (!candidate.mtimeMs) {
      continue;
    }
    const before = plans.get(cwd);
    if (before?.file === candidate.file && before.mtimeMs === candidate.mtimeMs) {
      return;
    }
    let text: string;
    try {
      text = await readTextFile(`${root(cwd)}/${candidate.file}`);
    } catch {
      continue;
    }
    const plan = parsePlan(text);
    if (!plan) {
      continue;
    }
    plans.set(cwd, {
      loaded: true,
      file: candidate.file,
      plan,
      mtimeMs: candidate.mtimeMs,
    });
    emitPlans();
    return;
  }
  const before = plans.get(cwd);
  if (!before || before.loaded === false || before.file !== null) {
    plans.set(cwd, NONE);
    emitPlans();
  }
}

/**
 * Re-reads the project's roadmap (skipped when the file did not change).
 * `fresh` waits out a read already under way, which may predate a write.
 */
export function refreshPlan(cwd: string, fresh = false): Promise<void> {
  const running = loading.get(cwd);
  if (running) {
    return fresh ? running.then(() => refreshPlan(cwd)) : running;
  }
  const next = load(cwd).finally(() => {
    loading.delete(cwd);
  });
  loading.set(cwd, next);
  return next;
}

export function planFor(cwd: string): PlanState {
  return plans.get(cwd) ?? EMPTY;
}

/** The roadmaps of `cwds`, kept fresh while the caller is mounted. */
export function usePlans(cwds: readonly string[]): ReadonlyMap<string, PlanState> {
  const version = useSyncExternalStore(subscribePlans, plansVersion, plansVersion);
  const key = cwds.join("\n");
  useEffect(() => {
    const list = key ? key.split("\n") : [];
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      for (const cwd of list) {
        void refreshPlan(cwd);
      }
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [key]);
  void version;
  return new Map(cwds.map((cwd) => [cwd, planFor(cwd)]));
}

let planVersionCounter = 0;
planListeners.add(() => {
  planVersionCounter += 1;
});

function plansVersion(): number {
  return planVersionCounter;
}

/**
 * Sets one phase's status in the roadmap file, re-reading it first so an
 * agent's edit a moment ago is kept. `name` is the phase as shown, so a row
 * an agent moved since is still found. Returns false when it could not.
 */
export function savePhaseStatus(
  cwd: string,
  phaseId: string,
  status: PhaseStatus,
  note: string,
  name?: string,
): Promise<boolean> {
  // One save at a time per project, so a quick second change reads the first.
  const run = (saving.get(cwd) ?? Promise.resolve(true))
    .catch(() => false)
    .then(() => saveNow(cwd, phaseId, status, note, name));
  saving.set(cwd, run);
  void run.finally(() => {
    if (saving.get(cwd) === run) {
      saving.delete(cwd);
    }
  });
  return run;
}

const saving = new Map<string, Promise<boolean>>();

async function saveNow(
  cwd: string,
  phaseId: string,
  status: PhaseStatus,
  note: string,
  name?: string,
): Promise<boolean> {
  const file = planFor(cwd).file;
  if (!file || !local(cwd)) {
    return false;
  }
  const path = `${root(cwd)}/${file}`;
  let saved = false;
  try {
    // An agent may save the file while we edit it: then read it again.
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      const before = await mtimeOf(path);
      const text = await readTextFile(path);
      const next = setPhaseStatus(text, phaseId, status, note, name);
      if (next === null) {
        return false;
      }
      if (next === text) {
        saved = true;
      } else if ((await mtimeOf(path)) === before) {
        await writeTextFile(path, next);
        saved = true;
      }
    }
  } catch {
    return false;
  }
  if (saved) {
    await refreshPlan(cwd, true);
  }
  return saved;
}

async function mtimeOf(path: string): Promise<number | null> {
  const [stat] = await statFiles([path]);
  return stat?.mtimeMs ?? null;
}

// --- Chats put on a phase by hand ---------------------------------------------

const LINKS_KEY = "monocode.fork.projectHome.links";
const MAX_LINKS = 500;
const linkListeners = new Set<() => void>();
let linkVersion = 0;
let linkCache: Record<string, string> | null = null;

function readLinks(): Record<string, string> {
  if (linkCache) {
    return linkCache;
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(LINKS_KEY) ?? "{}") as unknown;
    linkCache = parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    linkCache = {};
  }
  return linkCache;
}

function subscribeLinks(listener: () => void): () => void {
  linkListeners.add(listener);
  return () => {
    linkListeners.delete(listener);
  };
}

function linksVersion(): number {
  return linkVersion;
}

/** Session id → phase id, for chats the user put on a phase. */
export function usePhaseLinks(): Readonly<Record<string, string>> {
  useSyncExternalStore(subscribeLinks, linksVersion, linksVersion);
  return readLinks();
}

/** Puts a chat on a phase; "" keeps it off every phase, even by title. */
export function linkSessionToPhase(sessionId: string, phaseId: string) {
  const next = { ...readLinks() };
  delete next[sessionId];
  next[sessionId] = phaseId;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LINKS))) {
    delete next[key];
  }
  linkCache = next;
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: linked for this run only.
  }
  linkVersion += 1;
  for (const listener of linkListeners) {
    listener();
  }
}

// --- Launcher -----------------------------------------------------------------

export type HomeLaunch = {
  cwd: string;
  prompt: string;
  title: string;
  /** Open the new chat now (true) or start it in the background (false). */
  reveal: boolean;
};

/** Resolves to the new session's id once the chat is accepted, or null. */
type Launcher = (launch: HomeLaunch) => Promise<string | null>;

let launcher: Launcher | null = null;

/** App registers how to start a chat that sends `prompt` at once. */
export function setHomeLauncher(fn: Launcher | null) {
  launcher = fn;
  if (fn) {
    pumpFillQueue(null);
  }
}

/** Starts a chat; its session id, or null when it could not start. */
export function launchHomeChat(launch: HomeLaunch): Promise<string | null> {
  return launcher ? launcher(launch) : Promise.resolve(null);
}

// --- Roadmap chats, a few at a time -------------------------------------------

/** How many roadmap chats run at once; the rest wait their turn. */
export const FILL_AT_ONCE = 3;
/** A chat that never shows up as running within this long is counted as gone. */
const FILL_START_GRACE_MS = 90_000;
/** A launch not accepted within this long is given up on, freeing its slot. */
const FILL_LAUNCH_TIMEOUT_MS = 120_000;

/**
 * `id` is null until the launch is accepted. `since` is when the slot was
 * taken, then when the launch was accepted. `dropped` runs no longer hold a
 * slot, so a late answer from their launch is ignored.
 */
type FillRun = { id: string | null; since: number; seenRunning: boolean; dropped: boolean };

let fillWaiting: HomeLaunch[] = [];
let fillRunning: FillRun[] = [];
let fillStarted = 0;
let fillVersion = 0;
const fillListeners = new Set<() => void>();

function emitFill() {
  fillVersion += 1;
  for (const listener of fillListeners) {
    listener();
  }
}

function subscribeFill(listener: () => void): () => void {
  fillListeners.add(listener);
  return () => {
    fillListeners.delete(listener);
  };
}

function fillVersionNow(): number {
  return fillVersion;
}

export type FillProgress = { started: number; running: number; waiting: number };

/** How the queued roadmap chats are getting on. */
export function useFillProgress(): FillProgress {
  useSyncExternalStore(subscribeFill, fillVersionNow, fillVersionNow);
  return { started: fillStarted, running: fillRunning.length, waiting: fillWaiting.length };
}

/** Queues roadmap chats; they start in the background, FILL_AT_ONCE at a time. */
export function queueFillChats(launches: readonly HomeLaunch[], now: number = Date.now()) {
  const queued = new Set(fillWaiting.map((launch) => launch.cwd));
  for (const launch of launches) {
    if (!queued.has(launch.cwd)) {
      fillWaiting.push({ ...launch, reveal: false });
      queued.add(launch.cwd);
    }
  }
  pumpFillQueue(null, now);
}

/**
 * Drops finished roadmap chats and starts waiting ones while there is room.
 * `running` says whether a session is still working (null: not known yet).
 */
export function pumpFillQueue(
  running: ((id: string) => boolean | null) | null,
  now: number = Date.now(),
) {
  if (!fillWaiting.length && !fillRunning.length) {
    return;
  }
  const kept = fillRunning.filter((run) => {
    const keep = holdsSlot(run, running, now);
    if (!keep) {
      run.dropped = true;
    }
    return keep;
  });
  let changed = kept.length !== fillRunning.length;
  fillRunning = kept;
  while (fillWaiting.length && fillRunning.length < FILL_AT_ONCE && launcher) {
    const run: FillRun = { id: null, since: now, seenRunning: false, dropped: false };
    fillRunning.push(run);
    changed = true;
    void launcher(fillWaiting.shift()!).catch(() => null).then((id) => {
      if (id) {
        fillStarted += 1;
      }
      if (run.dropped) {
        // Given up on already; its slot has gone to another chat.
        emitFill();
        return;
      }
      if (id) {
        run.id = id;
        run.since = Date.now();
      } else {
        fillRunning = fillRunning.filter((other) => other !== run);
      }
      emitFill();
      pumpFillQueue(null);
    });
  }
  if (changed) {
    emitFill();
  }
}

/** Whether a roadmap chat still holds one of the FILL_AT_ONCE slots. */
function holdsSlot(
  run: FillRun,
  running: ((id: string) => boolean | null) | null,
  now: number,
): boolean {
  if (run.id === null) {
    return now - run.since < FILL_LAUNCH_TIMEOUT_MS;
  }
  if (!running) {
    return true;
  }
  if (running(run.id) === true) {
    run.seenRunning = true;
    return true;
  }
  // Not running: finished once it was seen running, else still starting.
  return !run.seenRunning && now - run.since < FILL_START_GRACE_MS;
}

/** For tests: forget every queued and running roadmap chat. */
export function resetFillQueue() {
  for (const run of fillRunning) {
    run.dropped = true;
  }
  fillWaiting = [];
  fillRunning = [];
  fillStarted = 0;
  emitFill();
}

/** App runs this so queued roadmap chats start as earlier ones finish. */
export function useFillQueuePump(sessions: readonly Session[]) {
  const latest = useRef(sessions);
  latest.current = sessions;
  useEffect(() => {
    const pump = () => {
      if (!fillWaiting.length && !fillRunning.length) {
        return;
      }
      const byId = new Map(latest.current.map((session) => [session.id, session]));
      pumpFillQueue((id) => {
        const session = byId.get(id);
        return session ? isInFlightSession(session) : null;
      });
    };
    pump();
    // Also on a timer, for a chat that never started.
    const timer = setInterval(pump, 15_000);
    return () => clearInterval(timer);
  }, [sessions]);
}
