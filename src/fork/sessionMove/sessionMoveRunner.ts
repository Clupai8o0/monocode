/**
 * Fork feature: the steps of a move, in order, with rollback. Everything that
 * touches a machine comes in through `MoveDeps`, so each failure can be tested.
 *
 * Before the source stops, a failure only needs saying. After it, anything
 * made on the target is removed and the source is resumed where it was. Only
 * when the session is confirmed up on the target does the source become a card.
 */
import { CANCELLABLE, type MoveStep } from "./sessionMoveModel";
import {
  CHUNK_BYTES,
  manifestProblem,
  type CheckResult,
  type InspectResult,
  type MoveAccount,
  type MoveManifest,
} from "./sessionMoveProtocol";

export type MoveCall = <T>(op: string, params: Record<string, unknown>) => Promise<T>;

export type MoveDeps = {
  /** Ops on the machine the session is on, and on the one it goes to. */
  source: MoveCall;
  target: MoveCall;
  /** Is the session idle now; from the tab, or the lab's registry. */
  sourceState: () => Promise<"idle" | "busy" | "waiting" | "gone">;
  /** Stops it. False when a new turn beat the stop: back to waiting. */
  stopSource: () => Promise<boolean>;
  /** Puts it back after a failure. */
  resumeSource: () => Promise<void>;
  /** Starts it on the target; a Mac opens a tab, a host a lab session. */
  startTarget: (input: { repo: string; cwd: string; branch: string; account: MoveAccount }) => Promise<{ name: string }>;
  /** Closes what `startTarget` opened here, before the undo removes its folder. */
  closeTarget?: () => Promise<void> | void;
  /** Whether it has come up on this session id. */
  confirmTarget: (name: string) => Promise<{ state: "up" | "queued" | "starting" | "failed"; detail?: string }>;
  /** Turns the source into a card. */
  finishSource: (result: MoveResult) => Promise<void> | void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /**
   * Written just before the stop and cleared after, so a crash can be undone.
   * `begin` throws when it can't be saved, and the move then never stops the source.
   */
  journal?: { begin: () => void; end: () => void };
};

/** A stopped source and a half-made target, as the app last knew them. */
export type MoveJournal = {
  plan: MovePlan;
  machineId: string;
  direction: "to-host" | "to-mac";
  /** The tab a move to this Mac opened, closed again on undo. */
  tabId?: string;
};

export type MovePlan = {
  moveId: string;
  sessionId: string;
  /** Provider session id. */
  providerSessionId: string;
  name: string;
  cwd: string;
  /** The account the source reads; a Mac's account id when it has one. */
  sourceAccountId?: string;
  /** The account to land on, on a Mac target. */
  targetAccountId?: string;
};

export type MoveResult = {
  cwd: string;
  branch: string;
  name: string;
  account: MoveAccount;
  leftBehind: string[];
  leftBehindMore: number;
};

export type MoveProgress = { step: MoveStep; queued?: boolean; percent?: number; cancellable: boolean };

export type MoveOutcome =
  | { kind: "moved"; result: MoveResult }
  | { kind: "cancelled" }
  /** Refused or failed, in one plain line; the source runs as before. */
  | {
      kind: "failed";
      reason: string;
      rollbackProblem?: string;
      targetMayRun?: boolean;
      /** Cleaned up there but not resumed here: stopped, with the journal kept for Try again. */
      resumeFailed?: boolean;
    };

const WAIT_POLL_MS = 1_500;
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_MISSES = 5;
/** Time to come up once it is out of the gate's line. */
const START_TIMEOUT_MS = 90_000;
const QUEUE_TIMEOUT_MS = 15 * 60_000;

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCancel() {
  let cancelled = false;
  return { cancel: () => void (cancelled = true), get cancelled() { return cancelled; } };
}

export async function runMove(
  plan: MovePlan,
  deps: MoveDeps,
  report: (progress: MoveProgress) => void,
  cancel: { readonly cancelled: boolean },
): Promise<MoveOutcome> {
  const step = (name: MoveStep, extra: Partial<MoveProgress> = {}) =>
    report({ step: name, cancellable: CANCELLABLE.has(name), ...extra });
  const base = { moveId: plan.moveId, sessionId: plan.providerSessionId };
  const endJournal = () => {
    try {
      deps.journal?.end();
    } catch {
      // A journal left behind is settled at the next launch.
    }
  };

  // 1. Refuse early.
  step("check");
  let facts: InspectResult;
  let checked: CheckResult;
  try {
    facts = await deps.source<InspectResult>("inspect", {
      cwd: plan.cwd,
      sessionId: plan.providerSessionId,
      accountId: plan.sourceAccountId,
    });
    if (!facts.hasTranscript) return { kind: "failed", reason: "This session has no conversation to carry yet" };
    if (facts.remotes.length === 0)
      return { kind: "failed", reason: "This repository has no remote to match on the other machine" };
    checked = await deps.target<CheckResult>("check", {
      sourcePath: plan.cwd,
      urls: facts.remotes.map((remote) => remote.url),
    });
  } catch (error) {
    return { kind: "failed", reason: text(error) };
  }
  if (!checked.ok) return { kind: "failed", reason: checked.reason };
  const urls = facts.remotes.map((remote) => remote.url);
  const sourceRemote =
    facts.remotes.find((remote) => remote.url === checked.matchedUrl)?.name ?? facts.remotes[0].name;
  const queuedAtStart = checked.queued === true;

  // 2 and 3. Wait for the turn to end, then stop; a new turn keeps it waiting.
  for (;;) {
    if (cancel.cancelled) return { kind: "cancelled" };
    let state;
    try {
      state = await deps.sourceState();
    } catch (error) {
      return { kind: "failed", reason: text(error) };
    }
    if (state === "gone") return { kind: "failed", reason: "The session has ended" };
    if (state === "waiting") return { kind: "failed", reason: "It is waiting for your answer" };
    if (state === "idle") {
      if (cancel.cancelled) return { kind: "cancelled" };
      step("stop");
      try {
        deps.journal?.begin();
      } catch {
        // Without it, a crash after the target starts would leave two copies running.
        return { kind: "failed", reason: "Could not save the move on this Mac, so it did not start" };
      }
      try {
        if (await deps.stopSource()) break;
      } catch (error) {
        // It may be half stopped, so it gets the full rollback.
        return rollback(plan, deps, text(error));
      }
      endJournal();
    }
    step("wait");
    await deps.sleep(WAIT_POLL_MS);
  }

  // No way back for Cancel past here.
  try {
    // 4. The code. The pack holds the conversation too, taken while stopped.
    step("code");
    const manifest = await deps.source<MoveManifest>(
      "pack",
      { ...base, cwd: plan.cwd, remoteName: sourceRemote, accountId: plan.sourceAccountId },
    );
    const problem = manifestProblem(manifest);
    if (problem) throw new Error(problem);
    const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;
    for (const file of manifest.files) {
      let offset = 0;
      if (file.size === 0) {
        await deps.target("write", { ...base, path: file.path, offset: 0, data: "" });
      }
      while (offset < file.size) {
        const { data } = await deps.source<{ data: string }>("read", {
          moveId: plan.moveId,
          path: file.path,
          offset,
        });
        if (!data) throw new Error(`A file ended early: ${file.path}`);
        await deps.target("write", { ...base, path: file.path, offset, data });
        const bytes = base64Bytes(data);
        offset += bytes;
        sent += bytes;
        step("code", { percent: total ? Math.min(100, Math.round((sent / total) * 100)) : 100 });
      }
    }
    if (offset0(CHUNK_BYTES)) step("code");
    const code = await deps.target<{ repo: string; cwd: string; branch: string }>(
      "unpackCode",
      { moveId: plan.moveId, name: plan.name, manifest, urls },
    );

    // 5. The conversation, into the target account's folder for the new path.
    step("conversation");
    const landed = await deps.target<{ account: MoveAccount }>(
      "unpackConversation",
      { moveId: plan.moveId, manifest, account: facts.account, accountId: plan.targetAccountId },
    );

    // 6. Start, and confirm it came up on that session id.
    step("start");
    const started = await deps.startTarget({ repo: code.repo, cwd: code.cwd, branch: code.branch, account: landed.account });
    step("confirm", { queued: queuedAtStart });
    await waitUp(deps, started.name, (queued) => step("confirm", { queued }));

    // 7. Only then the card. Never deletes the source's worktree or transcript.
    step("finish");
    const result: MoveResult = {
      cwd: code.cwd,
      branch: code.branch,
      name: started.name,
      account: landed.account,
      leftBehind: manifest.ignored,
      leftBehindMore: manifest.ignoredMore,
    };
    await deps.finishSource(result);
    endJournal();
    await deps.target("done", { moveId: plan.moveId }).catch(() => undefined);
    await deps.source("done", { moveId: plan.moveId }).catch(() => undefined);
    return { kind: "moved", result };
  } catch (error) {
    return rollback(plan, deps, text(error));
  }
}

function offset0(_: number) {
  return false;
}

function base64Bytes(data: string) {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

async function waitUp(
  deps: MoveDeps,
  name: string,
  report: (queued: boolean) => void,
): Promise<void> {
  const began = deps.now();
  let outOfLine = deps.now();
  let misses = 0;
  for (;;) {
    let answer;
    try {
      answer = await deps.confirmTarget(name);
      misses = 0;
    } catch (error) {
      // A dropped reply isn't a failed start: only a run of them is an answer.
      misses += 1;
      if (misses >= CONFIRM_MISSES) throw error;
      await deps.sleep(CONFIRM_POLL_MS);
      continue;
    }
    const { state, detail } = answer;
    if (state === "up") return;
    if (state === "failed") throw new Error(detail ?? "It did not start on the other machine");
    if (state === "queued") {
      outOfLine = deps.now();
      if (deps.now() - began > QUEUE_TIMEOUT_MS) throw new Error("The other machine stayed full for 15 minutes");
    } else if (deps.now() - outOfLine > START_TIMEOUT_MS) {
      throw new Error("It did not come up on the other machine");
    }
    report(state === "queued");
    await deps.sleep(CONFIRM_POLL_MS);
  }
}

async function rollback(plan: MovePlan, deps: MoveDeps, failure: string): Promise<MoveOutcome> {
  let reason = failure;
  try {
    // A tab left open would take turns on the conversation in a removed folder.
    await deps.closeTarget?.();
    const undone = await deps.target<{ kept?: string } | undefined>("undo", { moveId: plan.moveId });
    if (undone?.kept) reason = `${reason}. ${undone.kept}`;
  } catch (error) {
    // The copy there may be running, so this one stays stopped: two copies must
    // never write at once. The journal stays too, and the next launch retries.
    return {
      kind: "failed",
      reason,
      targetMayRun: true,
      rollbackProblem: `Could not clean up the other machine (${text(error)}), so it stays stopped here until that works`,
    };
  }
  await deps.source("done", { moveId: plan.moveId }).catch(() => undefined);
  try {
    await deps.resumeSource();
  } catch (error) {
    return { kind: "failed", reason, rollbackProblem: `Could not resume it here: ${text(error)}`, resumeFailed: true };
  }
  try {
    deps.journal?.end();
  } catch {
    // Settled at the next launch.
  }
  return { kind: "failed", reason };
}

/**
 * The app closed mid-move. The journal is only written once the source stops,
 * so undo what the target has and resume the source. What the undo kept when
 * both worked; otherwise false, the journal stays and it tries again later.
 * `finished` is a move whose card was saved before the journal could be
 * cleared: it stays moved.
 */
export async function recoverMove(
  journal: MoveJournal,
  deps: Pick<MoveDeps, "source" | "target" | "resumeSource" | "closeTarget">,
  finished = false,
): Promise<false | { kept?: string }> {
  if (finished) {
    await deps.target("done", { moveId: journal.plan.moveId }).catch(() => undefined);
    await deps.source("done", { moveId: journal.plan.moveId }).catch(() => undefined);
    return {};
  }
  try {
    await deps.closeTarget?.();
    const undone = await deps.target<{ kept?: string } | undefined>("undo", { moveId: journal.plan.moveId });
    await deps.source("done", { moveId: journal.plan.moveId });
    await deps.resumeSource();
    return undone?.kept ? { kept: undone.kept } : {};
  } catch {
    return false;
  }
}
