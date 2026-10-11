import { nativeModelId } from "../../../../features/sessions/model/models";
import type { RuntimeMode } from "../../../../features/sessions/model/session";
import { AcpClient, type AcpHandlers } from "../../core/acp";
import { AcpSubagents } from "../../core/acpSubagents";
import {
  killChild,
  resolveDeepSeekBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  DEEPSEEK_ACP_ARGS,
  DEEPSEEK_AUTH_HELP,
  deepseekConfigOptions,
  deepseekModelValue,
  deepseekPromptBlocks,
  deepseekSessionId,
  deepseekStartupError,
  withDeepSeekToolKind,
  type DeepSeekConfigOption,
} from "./deepseekProtocol";
import {
  eventsFromAcpUpdate,
  permissionOptionId,
  permissionRequestFromAcp,
  pickAutoOption,
} from "../grok/grokProtocol";
import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types";

type Live = {
  subagents: AcpSubagents;
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  configOptions: DeepSeekConfigOption[];
  cancelled: boolean;
  runtimeMode: RuntimeMode;
  planning: boolean;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, (decision: ApprovalDecision) => void>;
  turns: Promise<void>;
};

type Resume = { acpSessionId: string; cwd: string };

const INIT_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 20_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

/** Live DeepSeek Harness adapter. Spawns `dsh --profile acp` over standard ACP. */
export async function sendDeepSeekTurn(input: SendTurnInput): Promise<void> {
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
  live.planning = input.intent === "plan";
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
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
      await stopDeepSeekSession(input.sessionId);
    }
    throw error;
  }
}

/** dsh runs one prompt at a time per session and rejects a second one. */
export async function steerDeepSeekTurn(_input: SteerTurnInput): Promise<void> {
  throw new Error("DeepSeek Harness does not support steering an in-flight turn");
}

export function respondDeepSeekApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  liveByThread.get(sessionId)?.approvals.get(requestId)?.(decision);
}

export async function cancelDeepSeekTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  resolveApprovals(live);
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopDeepSeekSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.cancelled = true;
    resolveApprovals(live);
  }
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetDeepSeekSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopDeepSeekSession(sessionId);
}

export function bindDeepSeekSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    existing.planning = input.intent === "plan";
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopDeepSeekSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd)
    resumeByThread.delete(input.sessionId);

  const { path } = await resolveDeepSeekBinary();
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  const liveRef: { current: Live | null } = { current: null };

  handlers.onNotification = (method, params) => {
    const live = liveRef.current;
    if (!live || live.cancelled) return;
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
      const live = liveRef.current;
      if (live) live.cancelled = true;
      acp.close(new Error("DeepSeek Harness exited"));
      liveByThread.delete(input.sessionId);
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] deepseek stderr", line);
    },
  );

  await spawnChild(
    input.sessionId,
    path,
    DEEPSEEK_ACP_ARGS,
    input.cwd,
    undefined,
    "deepseek",
  );

  try {
    try {
      await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw deepseekStartupError(error);
    }

    let setup: unknown;
    let acpSessionId: string | undefined;
    if (canResume && resume) {
      // Resume restores dsh's own log without replaying old updates.
      try {
        setup = await acp.request(
          "session/resume",
          { sessionId: resume.acpSessionId, cwd: input.cwd, mcpServers: [] },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = deepseekSessionId(setup) ?? resume.acpSessionId;
      } catch {
        setup = undefined;
        acpSessionId = undefined;
      }
    }

    if (!acpSessionId) {
      try {
        setup = await acp.request(
          "session/new",
          { cwd: input.cwd, mcpServers: [] },
          SESSION_TIMEOUT_MS,
        );
      } catch (error) {
        throw deepseekStartupError(error);
      }
      acpSessionId = deepseekSessionId(setup);
    }
    if (!acpSessionId)
      throw new Error("DeepSeek Harness did not return a session id");

    const live: Live = {
      subagents: new AcpSubagents(),
      acp,
      acpSessionId,
      cwd: input.cwd,
      configOptions: deepseekConfigOptions(setup),
      cancelled: false,
      runtimeMode: input.runtimeMode,
      planning: input.intent === "plan",
      onEvent: input.onEvent,
      approvals: new Map(),
      turns: Promise.resolve(),
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, { acpSessionId, cwd: input.cwd });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: acpSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopDeepSeekSession(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: HarnessSessionInput,
): Promise<void> {
  const nativeId = nativeModelId(input.model).trim();
  if (nativeId && nativeId !== "default") {
    const model = live.configOptions.find((option) => option.id === "model");
    const value = model ? deepseekModelValue(nativeId, model.choices) : undefined;
    if (value) await setConfigOption(live, "model", value);
  }
  // Effort choices depend on the model, so set it after the model.
  const effort = input.modelSettings?.effort?.trim();
  if (effort) {
    const option = live.configOptions.find(
      (entry) => entry.id === "reasoning_effort",
    );
    if (option?.choices.some((choice) => choice.value === effort)) {
      await setConfigOption(live, "reasoning_effort", effort);
    }
  }
}

async function setConfigOption(
  live: Live,
  configId: string,
  value: string,
): Promise<void> {
  const current = live.configOptions.find((option) => option.id === configId);
  if (!current || current.currentValue === value) return;
  const result = await live.acp.request(
    "session/set_config_option",
    { sessionId: live.acpSessionId, configId, value },
    CONTROL_TIMEOUT_MS,
  );
  const next = deepseekConfigOptions(result);
  if (next.length > 0) live.configOptions = next;
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = deepseekPromptBlocks(input.text, input.attachments);
    if (blocks.length === 0) return;
    const pending = live.acp.request(
      "session/prompt",
      { sessionId: live.acpSessionId, prompt: blocks },
      PROMPT_TIMEOUT_MS,
    );
    input.onAccepted?.();
    await pending;
    if (live.cancelled) return;
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: /auth|credential|api key|unauthori[sz]ed|401/i.test(detail)
        ? `${detail.trim()}\n\n${DEEPSEEK_AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function handleNotification(live: Live, method: string, params: unknown): void {
  if (method !== "session/update") return;
  const update = withDeepSeekToolKind(params);
  const options = deepseekConfigOptions(
    (update as { update?: unknown } | null)?.update,
  );
  if (options.length > 0) live.configOptions = options;
  const events = eventsFromAcpUpdate(update);
  for (const event of live.subagents.route(update, events)) {
    live.onEvent(event);
  }
}

async function handleRequest(
  live: Live,
  id: number,
  method: string,
  params: unknown,
): Promise<void> {
  if (method === "session/request_permission") {
    await handlePermission(live, id, params);
    return;
  }
  await live.acp
    .respondError(id, { code: -32601, message: `Method not found: ${method}` })
    .catch(() => undefined);
}

async function handlePermission(
  live: Live,
  id: number,
  params: unknown,
): Promise<void> {
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
    await respondPermission(
      live,
      id,
      permissionOptionId(readOnly ? "allow" : "deny", request.optionIds),
    );
    return;
  }

  const automatic = pickAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
  );
  if (automatic) {
    await respondPermission(live, id, automatic);
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
  await respondPermission(
    live,
    id,
    permissionOptionId(decision, request.optionIds),
  );
}

async function respondPermission(
  live: Live,
  id: number,
  optionId: string,
): Promise<void> {
  await live.acp.respond(id, {
    outcome: { outcome: "selected", optionId },
  });
}

function resolveApprovals(live: Live): void {
  for (const resolve of live.approvals.values()) resolve("deny");
  live.approvals.clear();
}
