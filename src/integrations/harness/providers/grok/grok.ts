import { nativeModelId } from "../../../../features/sessions/model/models";
import { AcpSubagents } from "../../core/acpSubagents";
import type { RuntimeMode } from "../../../../features/sessions/model/session";
import { AcpClient, type AcpHandlers } from "../../core/acp";
import {
  killChild,
  resolveGrokBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  AUTH_HELP,
  askQuestionResponse,
  askQuestionsFromAcp,
  asRecord,
  contextFromPromptResult,
  contextWindowFromSetup,
  currentModelId,
  eventsFromAcpUpdate,
  grokAuthError,
  grokAuthMethodId,
  grokEffort,
  grokInterjectText,
  grokPromptBlocks,
  grokSessionNewParams,
  grokSpawnArgs,
  permissionOptionId,
  permissionRequestFromAcp,
  pickAutoOption,
  planFromExitPlan,
  sessionIdFromResult,
} from "./grokProtocol";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types";
import { TurnNotReadyError } from "../../core/types";
import {
  questionPromptTitle,
  type UserQuestionReply,
} from "../../../../features/sessions/model/userQuestion";

type Live = {
  subagents: AcpSubagents;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelId: string;
  contextWindow?: number;
  muteUpdates: boolean;
  cancelled: boolean;
  /** A session/prompt is in flight, so an interjection lands in this turn. */
  prompting: boolean;
  /** When this turn last interjected; Grok may answer it in a turn of its own. */
  interjectedAt?: number;
  /** Interjections sent but not yet acknowledged. */
  interjecting: number;
  /** The latest context size came from an auto-compaction. */
  compactedLast: boolean;
  /** Counts context sizes shown, to spot one newer than the prompt result. */
  contextSeq: number;
  /** The Grok process exited. */
  exited: boolean;
  /** Grok's running prompt id, from `_x.ai/queue/changed`. */
  queueRunning?: string;
  queueWaiters: Set<() => void>;
  fullAccess: boolean;
  planning: boolean;
  runtimeMode: RuntimeMode;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, (decision: ApprovalDecision) => void>;
  questions: Map<number, (reply: UserQuestionReply) => void>;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

const INIT_TIMEOUT_MS = 12_000;
const AUTH_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;
/** How long to look for Grok's own turn for an interjection that missed ours. */
const FALLBACK_GRACE_MS = 750;
const FALLBACK_PREFIX = "interject-fallback-";
/** How long a follow-up waits for a starting turn to reach Grok. */
const STEER_WAIT_MS = 60_000;
/** Threads with a sendGrokTurn call still running, by count. */
const startingTurns = new Map<string, number>();
/** Counts stops and cancels per thread, so a waiting steer can see one. */
const steerStops = new Map<string, number>();

function noteSteerStop(sessionId: string): void {
  steerStops.set(sessionId, (steerStops.get(sessionId) ?? 0) + 1);
}

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

/**
 * Live Grok Build adapter. Spawns `grok agent stdio` and talks ACP.
 * Grok accepts ACP image blocks despite advertising image: false.
 */
export async function sendGrokTurn(input: SendTurnInput): Promise<void> {
  const id = input.sessionId;
  startingTurns.set(id, (startingTurns.get(id) ?? 0) + 1);
  try {
    await runGrokTurn(input);
  } finally {
    const left = (startingTurns.get(id) ?? 1) - 1;
    if (left > 0) startingTurns.set(id, left);
    else startingTurns.delete(id);
  }
}

async function runGrokTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
        if (live.cancelled) return;
        await prompt(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    if (liveByThread.get(input.sessionId) === live) {
      await stopGrokSession(input.sessionId);
    }
    throw error;
  }
}

export async function compactGrokContext(
  input: CompactContextInput,
): Promise<void> {
  let live = liveByThread.get(input.sessionId);
  if (!live || live.cwd !== input.cwd) {
    live = await ensureLive(input);
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await live.acp.request(
          "_x.ai/compact_conversation",
          { sessionId: live.acpSessionId },
          PROMPT_TIMEOUT_MS,
        );
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

/**
 * Mid-turn follow-up through Grok's own interjection, the TUI's Ctrl+Enter.
 * Grok reads it before its next model call, or answers it in a turn of its
 * own if it came too late (see waitForFallbackTurns). It takes text only, so
 * files go as paths; a pasted image with no file waits for the next turn.
 */
export async function steerGrokTurn(input: SteerTurnInput): Promise<void> {
  const text = grokInterjectText(input.text, input.attachments)?.trim();
  if (text == null) {
    throw new TurnNotReadyError(
      "Grok Build can't take a pasted image mid-turn. Send it again after this turn.",
    );
  }
  if (!text) return;
  // MonoCode marks the turn busy before Grok has started or resumed. Wait for
  // the prompt to be in flight so the interjection lands in this turn.
  const live = await promptingLive(input.sessionId);
  if (!live) throw new TurnNotReadyError("No Grok Build turn is running");
  // Mark before sending: the turn may end while the request is in flight,
  // and Grok then answers it in a turn of its own that we must wait for.
  live.interjectedAt = Date.now();
  live.interjecting += 1;
  try {
    await live.acp.request(
      "_x.ai/interject",
      { sessionId: live.acpSessionId, text },
      CONTROL_TIMEOUT_MS,
    );
  } finally {
    live.interjecting -= 1;
    live.interjectedAt = Date.now();
    wakeQueueWaiters(live);
  }
}

async function promptingLive(sessionId: string): Promise<Live | undefined> {
  const deadline = Date.now() + STEER_WAIT_MS;
  const stops = steerStops.get(sessionId) ?? 0;
  for (;;) {
    // Stop or cancel since the follow-up came in: don't hold it any longer.
    if ((steerStops.get(sessionId) ?? 0) !== stops) return undefined;
    const live = liveByThread.get(sessionId);
    if (live?.prompting && !live.cancelled) return live;
    // Only wait for a turn that is on its way (starting Grok, resuming,
    // setting the model); with none running the follow-up is a new turn.
    if (!startingTurns.has(sessionId)) return undefined;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function respondGrokApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
) {
  liveByThread.get(sessionId)?.approvals.get(requestId)?.(decision);
}

export function respondGrokQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
) {
  liveByThread.get(sessionId)?.questions.get(requestId)?.(reply);
}

export async function cancelGrokTurn(sessionId: string): Promise<void> {
  noteSteerStop(sessionId);
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  wakeQueueWaiters(live);
  for (const [, resolve] of live.approvals) resolve("deny");
  live.approvals.clear();
  for (const [, resolve] of live.questions) resolve({ kind: "skipped" });
  live.questions.clear();
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopGrokSession(sessionId: string): Promise<void> {
  noteSteerStop(sessionId);
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    live.queueRunning = undefined;
    wakeQueueWaiters(live);
    for (const [, resolve] of live.approvals) resolve("deny");
    live.approvals.clear();
    for (const [, resolve] of live.questions) resolve({ kind: "skipped" });
    live.questions.clear();
  }
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetGrokSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopGrokSession(sessionId);
}

export function bindGrokSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const wantPlanning = input.intent === "plan";
  const wantFullAccess = input.runtimeMode === "full-access" && !wantPlanning;
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.fullAccess === wantFullAccess &&
    existing.planning === wantPlanning
  ) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    await stopGrokSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveGrokBinary();
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  const liveRef: { current: Live | null } = { current: null };
  const muteGate = { current: false };

  handlers.onNotification = (method, params) => {
    const live = liveRef.current;
    if (live && trackQueue(live, method, params)) return;
    if (muteGate.current) return;
    if (!live || live.muteUpdates) return;
    handleNotification(live, method, params);
  };
  handlers.onRequest = (id, method, params) => {
    const live = liveRef.current;
    if (!live) {
      void acp
        .respondError(id, {
          code: -32601,
          message: `Method not found: ${method}`,
        })
        .catch(() => undefined);
      return;
    }
    void handleRequest(live, id, method, params);
  };

  const emit = (event: HarnessEvent) => {
    (liveRef.current?.onEvent ?? input.onEvent)(event);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      if (liveRef.current) {
        liveRef.current.muteUpdates = true;
        liveRef.current.exited = true;
        liveRef.current.queueRunning = undefined;
        wakeQueueWaiters(liveRef.current);
      }
      acp.close(new Error("Grok Build exited"));
      liveByThread.delete(input.sessionId);
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] grok stderr", line);
      if (/not authenticated|Authentication required|XAI_API_KEY/i.test(line)) {
        emit({
          type: "session.error",
          message: `${line.trim()}\n\n${AUTH_HELP}`,
        });
      }
    },
  );

  await spawnChild(
    input.sessionId,
    path,
    grokSpawnArgs({
      model: input.model,
      effort: grokEffort(input.modelSettings),
      fullAccess: wantFullAccess,
      plan: wantPlanning,
    }),
    input.cwd,
    undefined,
    "grok",
  );

  try {
    let init: unknown;
    try {
      init = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw grokAuthError(error);
    }

    const methodId = grokAuthMethodId(init);
    if (methodId) {
      await acp
        .request(
          "authenticate",
          { methodId, _meta: { headless: true } },
          AUTH_TIMEOUT_MS,
        )
        .catch((error: unknown) => {
          console.debug("[monocode] grok authenticate", error);
        });
    }

    let setup: unknown;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && resume) {
      try {
        setup = await acp.request(
          "session/resume",
          {
            sessionId: resume.acpSessionId,
            cwd: input.cwd,
            mcpServers: [],
          },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
        didLoad = true;
      } catch {
        muteGate.current = true;
        try {
          setup = await acp.request(
            "session/load",
            {
              sessionId: resume.acpSessionId,
              cwd: input.cwd,
              mcpServers: [],
            },
            SESSION_TIMEOUT_MS,
          );
          acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
          didLoad = true;
        } catch {
          setup = undefined;
          acpSessionId = undefined;
          didLoad = false;
        } finally {
          muteGate.current = false;
        }
      }
    }

    if (!acpSessionId) {
      try {
        setup = await acp.request(
          "session/new",
          grokSessionNewParams(input.cwd, input.runtimeMode),
          SESSION_TIMEOUT_MS,
        );
      } catch (error) {
        throw grokAuthError(error);
      }
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId)
      throw new Error("Grok Build did not return a session id");

    const live: Live = {
      subagents: new AcpSubagents(),
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelId: currentModelId(setup) ?? nativeModelId(input.model),
      contextWindow:
        contextWindowFromSetup(setup) ?? contextWindowFromSetup(init),
      muteUpdates: didLoad,
      cancelled: false,
      prompting: false,
      queueWaiters: new Set(),
      interjecting: 0,
      compactedLast: false,
      contextSeq: 0,
      exited: false,
      fullAccess: wantFullAccess,
      planning: wantPlanning,
      runtimeMode: input.runtimeMode,
      onEvent: input.onEvent,
      approvals: new Map(),
      questions: new Map(),
      turns: Promise.resolve(),
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      acpSessionId,
      cwd: input.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: acpSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopGrokSession(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: HarnessSessionInput,
): Promise<void> {
  const base = nativeModelId(input.model);
  if (base && base !== live.modelId) {
    await live.acp
      .request(
        "session/set_model",
        { sessionId: live.acpSessionId, modelId: base },
        CONTROL_TIMEOUT_MS,
      )
      .then(() => {
        live.modelId = base;
      })
      .catch((error: unknown) => {
        ignoreUnsupportedControl("set_model", error);
      });
  }

  const effort = grokEffort(input.modelSettings);
  if (!effort) return;
  // Grok's session modes are permission modes; reasoning is a config option.
  await live.acp
    .request(
      "session/set_config_option",
      {
        sessionId: live.acpSessionId,
        configId: "reasoning_effort",
        value: effort,
      },
      CONTROL_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      ignoreUnsupportedControl("set_config_option", error);
    });
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = grokPromptBlocks(input.text, input.attachments);
    if (blocks.length === 0) return;
    let result: unknown;
    let useResultSize = false;
    let seqAtResult = 0;
    live.prompting = true;
    live.interjectedAt = undefined;
    live.compactedLast = false;
    try {
      const pending = live.acp.request(
        "session/prompt",
        {
          sessionId: live.acpSessionId,
          prompt: blocks,
        },
        PROMPT_TIMEOUT_MS,
      );
      // Marks the turn ready, which is what lets a queued follow-up steer it.
      input.onAccepted?.();
      result = await pending;
      // The result's size is only a backstop: not over a compaction, and not
      // over a size a fallback turn reports while we wait.
      useResultSize = !live.compactedLast;
      seqAtResult = live.contextSeq;
      await waitForFallbackTurns(live);
    } finally {
      live.prompting = false;
    }
    if (live.exited && !live.cancelled) {
      throw new Error("Grok Build exited before the turn finished");
    }
    // Stopped or cancelled while waiting: the session is gone.
    if (live.cancelled || live.muteUpdates) return;
    if (useResultSize && live.contextSeq === seqAtResult) {
      for (const event of contextFromPromptResult(result)) {
        live.onEvent(withWindow(live, event));
      }
    }
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: /auth|login|credential|api key|XAI_API_KEY/i.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[monocode] grok ${method} failed`, error);
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
}

function handleNotification(live: Live, method: string, params: unknown) {
  const updateParams =
    method === "session/update"
      ? params
      : method === "_x.ai/session_notification" ||
          method === "x.ai/session_notification"
        ? unwrapSessionNotification(params)
        : null;
  if (!updateParams) return;
  const rec = asRecord(updateParams);
  const update = asRecord(rec?.update) ?? rec;
  const updateKind =
    update?.sessionUpdate ?? update?.session_update ?? update?.type;
  for (const event of live.subagents.route(
    updateParams,
    eventsFromAcpUpdate(updateParams),
  )) {
    if (event.type === "context") {
      live.compactedLast = updateKind === "auto_compact_completed";
      live.contextSeq += 1;
    }
    live.onEvent(withWindow(live, event));
  }
}

/** Returns true when the notification was Grok's queue state. */
function trackQueue(live: Live, method: string, params: unknown): boolean {
  if (method !== "_x.ai/queue/changed" && method !== "x.ai/queue/changed") {
    return false;
  }
  const running = asRecord(params)?.runningPromptId;
  live.queueRunning =
    typeof running === "string" && running ? running : undefined;
  wakeQueueWaiters(live);
  return true;
}

function wakeQueueWaiters(live: Live): void {
  for (const wake of [...live.queueWaiters]) wake();
}

/**
 * An interjection sent during the turn's last model call is not read in that
 * turn. Grok answers it in a turn of its own ("interject-fallback-…") with no
 * session/prompt behind it. Keep MonoCode's turn open, and its events flowing,
 * until that turn is done so the follow-up is neither lost nor orphaned.
 */
async function waitForFallbackTurns(live: Live): Promise<void> {
  if (live.interjectedAt == null) return;
  const deadline = Date.now() + PROMPT_TIMEOUT_MS;
  let graceUntil = Date.now() + FALLBACK_GRACE_MS;
  let wasRunning = false;
  while (!live.cancelled && !live.muteUpdates) {
    const running =
      live.interjecting > 0 ||
      live.queueRunning?.startsWith(FALLBACK_PREFIX) === true;
    const now = Date.now();
    // A follow-up steered in while we wait gets its own grace, and so does
    // the moment a fallback turn ends, in case another one is queued.
    graceUntil = Math.max(
      graceUntil,
      (live.interjectedAt ?? 0) + FALLBACK_GRACE_MS,
      wasRunning && !running ? now + FALLBACK_GRACE_MS : 0,
    );
    wasRunning = running;
    if (!running && now >= graceUntil) return;
    if (now >= deadline) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        live.queueWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, (running ? deadline : graceUntil) - now);
      live.queueWaiters.add(wake);
    });
  }
}

function withWindow(live: Live, event: HarnessEvent): HarnessEvent {
  return event.type === "context" && event.window == null && live.contextWindow
    ? { ...event, window: live.contextWindow }
    : event;
}

function unwrapSessionNotification(params: unknown): unknown {
  const rec = asRecord(params);
  if (!rec) return params;
  if (rec.update != null || rec.sessionUpdate != null) return rec;
  const nested = asRecord(rec.notification) ?? asRecord(rec.payload);
  return nested ?? rec;
}

async function handleRequest(
  live: Live,
  id: number,
  method: string,
  params: unknown,
) {
  if (method === "session/request_permission") {
    await handlePermission(live, id, params);
    return;
  }
  if (
    method === "_x.ai/ask_user_question" ||
    method === "x.ai/ask_user_question"
  ) {
    await handleAskQuestion(live, id, params);
    return;
  }
  if (method === "_x.ai/exit_plan_mode" || method === "x.ai/exit_plan_mode") {
    const plan = planFromExitPlan(params);
    if (plan) live.onEvent({ type: "plan", text: plan });
    await live.acp
      // End the provider-owned plan turn without approving implementation.
      // MonoCode's separate Build turn is the only approval boundary.
      .respond(id, { outcome: "abandoned" })
      .catch(() => undefined);
    return;
  }
  await live.acp
    .respondError(id, {
      code: -32601,
      message: `Method not found: ${method}`,
    })
    .catch(() => undefined);
}

async function handlePermission(live: Live, id: number, params: unknown) {
  const request = permissionRequestFromAcp(params);
  if (request.callId) {
    live.onEvent({
      type: "tool.updated",
      callId: request.callId,
      title: request.title,
      kind: request.kind,
      preview: request.preview,
    });
  }

  if (live.planning) {
    const readOnly = request.kind === "read" || request.kind === "search";
    const optionId = permissionOptionId(
      readOnly ? "allow" : "deny",
      request.optionIds,
    );
    await live.acp.respond(id, {
      outcome: { outcome: "selected", optionId },
    });
    return;
  }

  const auto = pickAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
  );
  if (auto) {
    await live.acp.respond(id, {
      outcome: { outcome: "selected", optionId: auto },
    });
    return;
  }

  live.onEvent({
    type: "approval.requested",
    requestId: id,
    title: request.title,
    kind: request.kind,
    callId: request.callId,
    preview: request.preview,
  });

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(id, resolve);
  });
  live.approvals.delete(id);
  live.onEvent({ type: "approval.resolved", requestId: id, decision });

  await live.acp.respond(id, {
    outcome: {
      outcome: "selected",
      optionId: permissionOptionId(decision, request.optionIds),
    },
  });
}

async function handleAskQuestion(live: Live, id: number, params: unknown) {
  const questions = askQuestionsFromAcp(params);
  live.onEvent({
    type: "question.asked",
    requestId: id,
    title: questionPromptTitle(questions),
    questions,
  });

  const reply = await new Promise<UserQuestionReply>((resolve) => {
    live.questions.set(id, resolve);
  });
  live.questions.delete(id);
  live.onEvent({
    type: "question.resolved",
    requestId: id,
    decision: reply.kind,
  });

  await live.acp
    .respond(id, askQuestionResponse(reply, questions))
    .catch(() => undefined);
}
