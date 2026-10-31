import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { remoteRequest } from "../../features/connections/model/connections";
import type { Block, Session } from "../../features/sessions/model/session";
import { sessionWorkCwd } from "../../features/sessions/model/session";
import { getHarness } from "../../integrations/harness/core/registry";
import { loadAccountHomes } from "../accounts/accountHomes";
import { knownLocalProjectPaths, readExternalSession } from "../externalSessions/externalSessionsStore";
import type { ExternalSession, ExternalTurn } from "../externalSessions/externalSessionsModel";
import {
  journalFinished,
  labKey,
  macAccountFor,
  moveAvailability,
  openJournal,
  parseMoved,
  stepText,
  withMoved,
  type MovedMap,
  type MovedRecord,
  type MoveFacts,
} from "./sessionMoveModel";
import { LONG_OPS, moveSlug, SESSION_MOVE_CAPABILITY, type MoveAccount, type SourceState } from "./sessionMoveProtocol";
import {
  createCancel,
  recoverMove,
  runMove,
  type MoveCall,
  type MoveDeps,
  type MoveJournal,
  type MoveOutcome,
  type MovePlan,
  type MoveProgress,
  type MoveResult,
} from "./sessionMoveRunner";

/**
 * Fork feature: moves in progress and the cards they leave, kept here so the
 * menu, the session's line and the card agree. App.tsx lends the few things
 * only it can do through `registerMoveHost`.
 */

export type MoveHost = {
  session: (id: string) => Session | undefined;
  needsInput: (session: Session) => boolean;
  isMono: (id: string) => boolean;
  /** A lead or a worker of an orchestration run. */
  isOrchestration: (id: string) => boolean;
  /** Opens a tab that resumes the conversation in the new worktree. */
  openMovedTab: (input: {
    repo: string;
    cwd: string;
    branch: string;
    providerSessionId: string;
    providerAccountId?: string;
    title: string;
    blocks: Block[];
  }) => string;
  /** Deletes a tab `openMovedTab` opened, and its saved record. */
  closeMovedTab: (id: string) => Promise<void>;
  openSession: (id: string) => void;
  /** A tab just became a card, so its conversation is no longer the app's. */
  onMoved: () => void;
};

const MOVED_KEY = "monocode.fork.movedSessions";
const JOURNAL_KEY = "monocode.fork.moveJournal";
const DESCRIBE_EVERY_MS = 60_000;
const POLL_MS = 1_000;
const POLL_MISSES = 20;

export type MoveView = {
  step: MoveProgress;
  text: string;
  cancel?: () => void;
};

type TargetInfo = { online: boolean; known: boolean; capabilities: readonly string[]; at: number };

let host: MoveHost | null = null;
let moved: MovedMap = readMoved();
const active = new Map<string, MoveView & { locked: boolean }>();
const failures = new Map<string, string>();
/** Failed moves whose copy on the target may still run: no new turn here. */
const stuck = new Set<string>(
  readJournal().flatMap((entry) => (entry.tabId ? [entry.plan.sessionId, entry.tabId] : [entry.plan.sessionId])),
);
/** Tabs a move to this Mac opened and hasn't finished with: no turn yet. */
const opened = new Set<string>();
const recovering = new Set<string>();
const targets = new Map<string, TargetInfo>();
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function readMoved(): MovedMap {
  try {
    return parseMoved(localStorage.getItem(MOVED_KEY));
  } catch {
    return {};
  }
}

/**
 * Throws when it can't be stored: the runner then rolls the move back, because
 * after a restart this tab would take turns again while the other copy runs.
 */
function saveMoved(next: MovedMap) {
  try {
    localStorage.setItem(MOVED_KEY, JSON.stringify(next));
  } catch {
    throw new Error("Could not save the move on this Mac");
  }
  moved = next;
  host?.onMoved();
  bump();
}

/**
 * Whether a record still stops something taking turns: a tab that is still
 * here, or a lab session, whose copy lives on wherever it went.
 */
function holdsLock(id: string): boolean {
  return !host || id.startsWith("lab:") || Boolean(host.session(id));
}

function readJournal(): MoveJournal[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as MoveJournal[]) : [];
  } catch {
    return [];
  }
}

/** Throws when it can't be stored: a move without one must not stop the source. */
function writeJournal(next: MoveJournal[]) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(next));
}

function journalWithout(moveId: string): MoveJournal[] {
  return openJournal(readJournal(), moved, moveId);
}

function dropJournal(moveId: string) {
  writeJournal(journalWithout(moveId));
}

const localCall: MoveCall = (op, params) =>
  invoke("fork_session_move", {
    op,
    params: op === "check" || op === "unpackCode" ? { ...params, projects: knownLocalProjectPaths() } : params,
  });

/** A long step starts and is asked after, so it can outlast one request. */
async function hostLongCall<T>(machineId: string, op: string, params: Record<string, unknown>): Promise<T> {
  const moveId = params.moveId;
  await remoteRequest(machineId, "sessionMove", { op: "begin", inner: { op, ...params } });
  let misses = 0;
  for (;;) {
    await new Promise((done) => setTimeout(done, POLL_MS));
    let answer: { done: boolean; result?: T; error?: string };
    try {
      answer = await remoteRequest(machineId, "sessionMove", { op: "poll", moveId, inner: op });
      misses = 0;
    } catch (error) {
      // A dropped connection is worth a wait. Only a run of them is an answer.
      misses += 1;
      if (misses >= POLL_MISSES) throw error;
      continue;
    }
    if (answer.done) {
      if (answer.error) throw new Error(answer.error);
      return answer.result as T;
    }
  }
}

function hostCall(machineId: string): MoveCall {
  return <T,>(op: string, params: Record<string, unknown>) =>
    LONG_OPS.has(op)
      ? hostLongCall<T>(machineId, op, params)
      : remoteRequest<T>(machineId, "sessionMove", { op, ...params });
}

// ---- reading state ----

export function isSessionMoved(id: string): boolean {
  return Boolean(moved[id]);
}

/** No new turn may start: stopped for a move, or already moved. */
export function isMoveLocked(id: string): boolean {
  return Boolean(moved[id]) || stuck.has(id) || opened.has(id) || active.get(id)?.locked === true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion() {
  return version;
}

export function useMoveVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export function useMovedRecord(id: string): MovedRecord | undefined {
  useMoveVersion();
  return moved[id];
}

export function useMoveView(id: string): {
  view?: MoveView;
  failure?: string;
  clearFailure: () => void;
  retry?: () => void;
} {
  useMoveVersion();
  const entry = stuck.has(id) && !recovering.has(id) ? readJournal().find((one) => one.plan.sessionId === id) : undefined;
  return {
    view: active.get(id),
    failure: failures.get(id),
    retry: entry ? () => void retryEntry(entry) : undefined,
    clearFailure: () => {
      failures.delete(id);
      bump();
    },
  };
}

/** What a host said it can do, read at most once a minute. */
export function refreshMoveTarget(machineId: string, force = false) {
  const known = targets.get(machineId);
  if (!force && known && Date.now() - known.at < DESCRIBE_EVERY_MS) {
    return;
  }
  void remoteRequest<{ capabilities?: unknown }>(machineId, "environment.describe", {}).then(
    (describe) => {
      const capabilities = Array.isArray(describe?.capabilities) ? (describe.capabilities as string[]) : [];
      targets.set(machineId, { online: true, known: true, capabilities, at: Date.now() });
      bump();
    },
    () => {
      targets.set(machineId, { online: false, known: true, capabilities: [], at: Date.now() });
      bump();
    },
  );
}

function targetFacts(machineId: string, name: string): MoveFacts["target"] {
  const info = targets.get(machineId);
  return {
    name,
    online: info ? info.online : true,
    known: info?.known ?? false,
    capabilities: info?.capabilities ?? [SESSION_MOVE_CAPABILITY],
  };
}

export function tabMoveFacts(session: Session, machineId: string, name: string): MoveFacts {
  return {
    harness: session.harness,
    cwd: sessionWorkCwd(session),
    isMono: host?.isMono(session.id) ?? false,
    isOrchestration: Boolean(session.orchestrationLeadId) || (host?.isOrchestration(session.id) ?? false),
    worktreeRemoved: session.worktreeRemoved,
    hasConversation: Boolean(session.providerSessionId),
    needsInput: host?.needsInput(session) ?? false,
    moved: isSessionMoved(session.id),
    moving: active.has(session.id) || stuck.has(session.id),
    target: targetFacts(machineId, name),
  };
}

/** The lab session's item, in its viewer. */
export function labMoveAvailability(session: ExternalSession) {
  return moveAvailability({
    harness: session.source === "claude" || session.source === "claude-cx" ? "claude" : session.source,
    cwd: session.cwd,
    isMono: false,
    isOrchestration: false,
    hasConversation: session.hasTranscript,
    needsInput: false,
    moved: false,
    moving: active.has(labKey(session.id)) || stuck.has(labKey(session.id)),
    target: { name: "this Mac", online: true, known: true, capabilities: [SESSION_MOVE_CAPABILITY] },
  });
}

export { labKey };

// ---- running a move ----

async function run(
  key: string,
  plan: MovePlan,
  toName: string,
  deps: Omit<MoveDeps, "sleep" | "now" | "journal">,
  journal: MoveJournal,
): Promise<MoveOutcome> {
  const cancel = createCancel();
  failures.delete(key);
  const report = (step: MoveProgress) => {
    active.set(key, {
      step,
      text: stepText(step.step, toName, step),
      cancel: step.cancellable ? cancel.cancel : undefined,
      locked: !step.cancellable,
    });
    bump();
  };
  const outcome = await runMove(
    plan,
    {
      ...deps,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: Date.now,
      journal: {
        begin: () => writeJournal([...journalWithout(plan.moveId), journal]),
        end: () => dropJournal(plan.moveId),
      },
    },
    report,
    cancel,
  );
  active.delete(key);
  if (outcome.kind === "failed" && outcome.targetMayRun) {
    stuck.add(key);
  }
  if (outcome.kind === "failed") {
    failures.set(
      key,
      outcome.rollbackProblem ? `${outcome.reason}. ${outcome.rollbackProblem}` : outcome.reason,
    );
  }
  bump();
  return outcome;
}

function record(
  moveId: string,
  sessionId: string,
  providerSessionId: string,
  toName: string,
  live: MovedRecord["live"],
  result: MoveResult,
): MovedRecord {
  return {
    sessionId,
    providerSessionId,
    moveId,
    toName,
    at: Date.now(),
    live,
    cwd: result.cwd,
    branch: result.branch,
    leftBehind: result.leftBehind,
    leftBehindMore: result.leftBehindMore,
  };
}

function labSource(account: MoveAccount) {
  return account === "cx" ? "claude-cx" : "claude";
}

/** A tab on this Mac to a host's lab session. */
export function moveTabToHost(sessionId: string, machineId: string, machineName: string) {
  const session = host?.session(sessionId);
  const providerSessionId = session?.providerSessionId;
  if (!session || !providerSessionId || active.has(sessionId) || isMoveLocked(sessionId)) {
    return;
  }
  const remote = hostCall(machineId);
  const moveId = crypto.randomUUID();
  const cwd = sessionWorkCwd(session);
  const plan: MovePlan = {
    moveId,
    sessionId,
    providerSessionId,
    name: moveSlug(session.title, providerSessionId),
    cwd,
    sourceAccountId: session.providerAccountId,
  };
  const current = () => host?.session(sessionId);
  void run(
    sessionId,
    plan,
    machineName,
    {
      source: localCall,
      target: remote,
      sourceState: async (): Promise<SourceState["state"]> => {
        const now = current();
        if (!now) return "gone";
        if (host?.needsInput(now)) return "waiting";
        return now.busy || (now.queuedMessages?.length ?? 0) > 0 ? "busy" : "idle";
      },
      stopSource: async () => {
        const now = current();
        if (!now || now.busy) return false;
        await getHarness(now.harness)?.stopSession(sessionId);
        return true;
      },
      // The conversation never left; its next turn resumes it.
      resumeSource: async () => {},
      startTarget: () =>
        remote<{ name: string }>("start", { moveId, sessionId: providerSessionId, name: plan.name }),
      confirmTarget: (name) => remote("confirm", { moveId, sessionId: providerSessionId, name }),
      finishSource: (result) => {
        saveMoved(
          withMoved(
            moved,
            record(
              moveId,
              sessionId,
              providerSessionId,
              machineName,
              { kind: "host", machineId, name: result.name, cwd: result.cwd, source: labSource(result.account) },
              result,
            ),
            holdsLock,
          ),
        );
      },
    },
    { plan, machineId, direction: "to-host" },
  );
}

function turnBlocks(turns: readonly ExternalTurn[]): Block[] {
  const blocks: Block[] = [];
  for (const turn of turns) {
    if (turn.role === "tool") continue;
    blocks.push({ id: crypto.randomUUID(), role: turn.role, text: turn.text } as Block);
  }
  return blocks;
}

async function macCxAccountId(): Promise<string | undefined> {
  const homes = await loadAccountHomes().catch(() => null);
  return homes?.accounts.find((entry) => entry.role === "cx")?.id;
}

/** A host's lab session to a tab on this Mac. */
export function moveLabToMac(session: ExternalSession, machineId: string) {
  const key = labKey(session.id);
  if (active.has(key) || isMoveLocked(key)) {
    return;
  }
  // Taken now: the account lookup below waits, and a second click must not start another.
  const firstStep: MoveProgress = { step: "check", cancellable: false };
  active.set(key, { step: firstStep, text: stepText("check", "this Mac"), locked: false });
  bump();
  const remote = hostCall(machineId);
  const moveId = crypto.randomUUID();
  const name = moveSlug(session.name, session.id);
  const account: MoveAccount = session.source === "claude-cx" ? "cx" : "main";
  void (async () => {
    const cxAccountId = account === "cx" ? await macCxAccountId() : undefined;
    const targetAccountId = macAccountFor(account, cxAccountId);
    let tabId = "";
    let turns: readonly ExternalTurn[] = [];
    const plan: MovePlan = {
      moveId,
      sessionId: key,
      providerSessionId: session.id,
      name,
      cwd: session.cwd,
      targetAccountId,
    };
    const journal: MoveJournal = { plan, machineId, direction: "to-mac" };
    const closeTab = async () => {
      if (!tabId) return;
      await host?.closeMovedTab(tabId);
      opened.delete(tabId);
      tabId = "";
    };
    await run(
      key,
      plan,
      "this Mac",
      {
        source: remote,
        target: localCall,
        sourceState: async () => (await remote<SourceState>("state", { sessionId: session.id })).state,
        stopSource: async () => {
          // Read now: a stopped session can't be read through its host any more.
          const page = await readExternalSession(
            { kind: "remote", machineId, projectId: "" },
            session.id,
          ).catch(() => null);
          turns = page?.turns ?? [];
          return (await remote<{ stopped: boolean }>("stop", { sessionId: session.id })).stopped;
        },
        resumeSource: async () => {
          await remote("restart", { sessionId: session.id, name, cwd: session.cwd });
        },
        startTarget: async ({ repo, cwd, branch, account: landed }) => {
          tabId =
            host?.openMovedTab({
              repo,
              cwd,
              branch,
              providerSessionId: session.id,
              // Where its transcript landed, whatever account the project picks.
              providerAccountId: macAccountFor(landed, cxAccountId),
              title: session.name ?? name,
              blocks: turnBlocks(turns),
            }) ?? "";
          if (!tabId) throw new Error("Could not open a tab for it");
          opened.add(tabId);
          bump();
          // So a crash from here closes it again; a journal that can't take it fails the move.
          writeJournal(
            readJournal().map((entry) => (entry.plan.moveId === moveId ? { ...entry, tabId } : entry)),
          );
          return { name };
        },
        closeTarget: closeTab,
        // Claude resumes with the tab's first turn; its transcript is in place.
        confirmTarget: async () => ({ state: "up" }),
        finishSource: (result) => {
          saveMoved(
            withMoved(
              moved,
              record(moveId, key, session.id, "this Mac", { kind: "tab", sessionId: tabId }, result),
              holdsLock,
            ),
          );
          opened.delete(tabId);
          host?.openSession(tabId);
        },
      },
      journal,
    );
  })();
}

/** Undoes one move the app lost track of, or settles one that had finished. */
async function recoverEntry(entry: MoveJournal): Promise<boolean> {
  const remote = hostCall(entry.machineId);
  const toHost = entry.direction === "to-host";
  const finished = journalFinished(moved, entry.plan.sessionId, entry.plan.moveId);
  const done = await recoverMove(
    entry,
    {
      source: toHost ? localCall : remote,
      target: toHost ? remote : localCall,
      closeTarget: async () => {
        if (entry.tabId) await host?.closeMovedTab(entry.tabId);
      },
      resumeSource: async () => {
        if (!toHost) {
          await remote("restart", {
            sessionId: entry.plan.providerSessionId,
            name: entry.plan.name,
            cwd: entry.plan.cwd,
          });
        }
      },
    },
    finished,
  );
  if (!done) return false;
  try {
    dropJournal(entry.plan.moveId);
  } catch {
    return false;
  }
  stuck.delete(entry.plan.sessionId);
  if (entry.tabId) stuck.delete(entry.tabId);
  return true;
}

const STUCK_TEXT = "An earlier move couldn't be undone, so it stays stopped here";

/** After an app restart mid-move: back to where it was. */
async function recoverJournal() {
  for (const entry of readJournal()) {
    const finished = journalFinished(moved, entry.plan.sessionId, entry.plan.moveId);
    if (await recoverEntry(entry)) {
      if (!finished) failures.set(entry.plan.sessionId, "The app closed during the move, so it was undone");
    } else {
      failures.set(entry.plan.sessionId, STUCK_TEXT);
    }
  }
  bump();
}

/** Try again on a move that stayed stopped, without an app restart. */
async function retryEntry(entry: MoveJournal) {
  const key = entry.plan.sessionId;
  if (recovering.has(key)) return;
  recovering.add(key);
  failures.set(key, "Undoing it now");
  bump();
  try {
    const done = await recoverEntry(entry).catch(() => false);
    if (done) {
      failures.delete(key);
    } else {
      failures.set(key, `${STUCK_TEXT}. Try again once the other machine is back`);
    }
  } finally {
    recovering.delete(key);
    bump();
  }
}

let recovered = false;

export function registerMoveHost(next: MoveHost | null) {
  host = next;
  if (next && !recovered) {
    recovered = true;
    void recoverJournal().catch(() => undefined);
  }
}

export const moveHost = () => host;

