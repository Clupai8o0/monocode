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
  moveAvailability,
  parseMoved,
  stepText,
  withMoved,
  type MovedMap,
  type MovedRecord,
  type MoveFacts,
} from "./sessionMoveModel";
import { moveSlug, SESSION_MOVE_CAPABILITY, type MoveAccount, type SourceState } from "./sessionMoveProtocol";
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
  openSession: (id: string) => void;
  /** A tab just became a card, so its conversation is no longer the app's. */
  onMoved: () => void;
};

const MOVED_KEY = "monocode.fork.movedSessions";
const JOURNAL_KEY = "monocode.fork.moveJournal";
const DESCRIBE_EVERY_MS = 60_000;
const LONG_MS = 10 * 60_000;

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

function saveMoved(next: MovedMap) {
  moved = next;
  try {
    localStorage.setItem(MOVED_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the card lasts until the app closes.
  }
  host?.onMoved();
  bump();
}

function readJournal(): MoveJournal[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as MoveJournal[]) : [];
  } catch {
    return [];
  }
}

function writeJournal(next: MoveJournal[]) {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(next));
  } catch {
    // Without it, a crash mid-move leaves the target's copy to be cleared by hand.
  }
}

const localCall: MoveCall = (op, params) =>
  invoke("fork_session_move", {
    op,
    params: op === "check" || op === "unpackCode" ? { ...params, projects: knownLocalProjectPaths() } : params,
  });

function hostCall(machineId: string): MoveCall {
  return (op, params, longMs) => remoteRequest(machineId, "sessionMove", { op, ...params }, longMs);
}

// ---- reading state ----

export function isSessionMoved(id: string): boolean {
  return Boolean(moved[id]);
}

/** No new turn may start: stopped for a move, or already moved. */
export function isMoveLocked(id: string): boolean {
  return Boolean(moved[id]) || active.get(id)?.locked === true;
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

export function useMoveView(id: string): { view?: MoveView; failure?: string; clearFailure: () => void } {
  useMoveVersion();
  return {
    view: active.get(id),
    failure: failures.get(id),
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
    isOrchestration: Boolean(session.orchestrationLeadId),
    worktreeRemoved: session.worktreeRemoved,
    hasConversation: Boolean(session.providerSessionId),
    needsInput: host?.needsInput(session) ?? false,
    moved: isSessionMoved(session.id),
    moving: active.has(session.id),
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
    moving: active.has(labKey(session.id)),
    target: { name: "this Mac", online: true, known: true, capabilities: [SESSION_MOVE_CAPABILITY] },
  });
}

export function labKey(providerSessionId: string) {
  return `lab:${providerSessionId}`;
}

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
        begin: () => writeJournal([...readJournal().filter((entry) => entry.plan.moveId !== plan.moveId), journal]),
        end: () => writeJournal(readJournal().filter((entry) => entry.plan.moveId !== plan.moveId)),
      },
    },
    report,
    cancel,
  );
  active.delete(key);
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
  sessionId: string,
  providerSessionId: string,
  toName: string,
  live: MovedRecord["live"],
  result: MoveResult,
): MovedRecord {
  return {
    sessionId,
    providerSessionId,
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
  if (!session || !providerSessionId || active.has(sessionId)) {
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
      confirmTarget: (name) => remote("confirm", { sessionId: providerSessionId, name }),
      finishSource: (result) => {
        saveMoved(
          withMoved(
            moved,
            record(
              sessionId,
              providerSessionId,
              machineName,
              { kind: "host", machineId, name: result.name, cwd: result.cwd, source: labSource(result.account) },
              result,
            ),
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

async function macAccountId(account: MoveAccount): Promise<string | undefined> {
  if (account !== "cx") return undefined;
  const homes = await loadAccountHomes().catch(() => null);
  return homes?.accounts.find((entry) => entry.role === "cx")?.id;
}

/** A host's lab session to a tab on this Mac. */
export function moveLabToMac(session: ExternalSession, machineId: string) {
  const key = labKey(session.id);
  if (active.has(key)) {
    return;
  }
  const remote = hostCall(machineId);
  const moveId = crypto.randomUUID();
  const name = moveSlug(session.name, session.id);
  const account: MoveAccount = session.source === "claude-cx" ? "cx" : "main";
  void (async () => {
    const targetAccountId = await macAccountId(account);
    let tabId = "";
    const plan: MovePlan = {
      moveId,
      sessionId: key,
      providerSessionId: session.id,
      name,
      cwd: session.cwd,
      targetAccountId,
    };
    await run(
      key,
      plan,
      "this Mac",
      {
        source: remote,
        target: localCall,
        sourceState: async () => (await remote<SourceState>("state", { sessionId: session.id })).state,
        stopSource: async () => (await remote<{ stopped: boolean }>("stop", { sessionId: session.id }, LONG_MS)).stopped,
        resumeSource: async () => {
          await remote("restart", { sessionId: session.id, name, cwd: session.cwd });
        },
        startTarget: async ({ repo, cwd, branch }) => {
          const page = await readExternalSession(
            { kind: "remote", machineId, projectId: "" },
            session.id,
          ).catch(() => null);
          tabId =
            host?.openMovedTab({
              repo,
              cwd,
              branch,
              providerSessionId: session.id,
              providerAccountId: targetAccountId,
              title: session.name ?? name,
              blocks: turnBlocks(page?.turns ?? []),
            }) ?? "";
          if (!tabId) throw new Error("Could not open a tab for it");
          return { name };
        },
        // Claude resumes with the tab's first turn; its transcript is in place.
        confirmTarget: async () => ({ state: "up" }),
        finishSource: (result) => {
          saveMoved(
            withMoved(moved, record(key, session.id, "this Mac", { kind: "tab", sessionId: tabId }, result)),
          );
          host?.openSession(tabId);
        },
      },
      { plan, machineId, direction: "to-mac" },
    );
  })();
}

/** After an app restart mid-move: back to where it was. */
async function recoverJournal() {
  for (const entry of readJournal()) {
    const remote = hostCall(entry.machineId);
    const toHost = entry.direction === "to-host";
    const done = await recoverMove(entry, {
      source: toHost ? localCall : remote,
      target: toHost ? remote : localCall,
      resumeSource: async () => {
        if (!toHost) {
          await remote("restart", {
            sessionId: entry.plan.providerSessionId,
            name: entry.plan.name,
            cwd: entry.plan.cwd,
          });
        }
      },
    });
    if (done) {
      writeJournal(readJournal().filter((other) => other.plan.moveId !== entry.plan.moveId));
    }
    failures.set(entry.plan.sessionId, "The app closed during the move, so it was undone");
  }
  bump();
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

