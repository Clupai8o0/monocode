import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HostEngine } from "./engine";
import { discardAttachments, stageInlineAttachments } from "./attachments";
import { hostAccount, hostAccounts } from "./accounts";
import { dataDirOf, readLooks } from "./desktop-import";
import { createMobileMonos } from "./mobile-monos";
import { createMobileTerminals } from "./mobile-terminal";
import { createMobileUsage } from "./mobile-usage";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../src/features/providers/model/providerAccounts";
import { createMobileWorkspace, once, type Job } from "./mobile-workspace";
import {
  createHostWorktree,
  hostWorktrees,
  resolveHostWorktree,
} from "./git-worktrees";
import { mobileTranscript } from "../src/features/mobile/model/mobileTranscript";
import {
  turnsBefore,
  watchUpdate,
  watchWindow,
  type WatchBaseline,
} from "../src/features/mobile/model/mobileWatch";
import {
  DEFAULT_RUNTIME_MODE,
  HARNESS_TITLE,
  RUNTIME_MODES,
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  sessionDisplayTitle,
  type HarnessId,
  type RuntimeMode,
  type Session,
} from "../src/features/sessions/model/session";
import {
  mergeModelSettings,
  resolveModel,
} from "../src/features/sessions/model/models";
import { toolCallLabel } from "../src/features/sessions/model/transcriptActivity";
import {
  isRemoteProvider,
  type HostModelCatalog,
  type RemoteAttachment,
  type HostSession,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";

/**
 * The phone app's protocol, spoken by the host itself, so a phone on the
 * tailnet works with the host's sessions without a desktop in between. The
 * shapes match what the desktop sends the phone (src/features/mobile).
 */

/** Turns a watch opens on when the phone does not say; older ones page in. */
const DEFAULT_TAIL = 3;
const MAX_PAGE = 100;
/** The longest a `watch.next` holds the request open waiting for a change. */
const NEXT_MAX_MS = 15_000;
const POLL_MS = 150;
/** A watch the phone stopped asking about is dropped after this. */
const WATCH_IDLE_MS = 60_000;
/** Open watches kept at most; the least recently used goes first. */
const MAX_WATCHES = 64;
/** Starts and sends remembered by command id, so a retry joins the first one
 *  instead of creating a second session, worktree or copy of an attachment. */
const MAX_JOBS = 100;
const DESKTOP_APPROVAL = "Waiting for approval on desktop: ";
const COLORS = ["#e8a33d", "#5b9cf0", "#4fbf8a", "#d9677b", "#a37de8", "#3fb7c4"];

type Watch = {
  conversationId: string;
  baseline: WatchBaseline | null;
  revision: number | null;
  tail: number;
  incremental: boolean;
  from: string | null;
  used: number;
};

export type MobileRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export function createMobileHandler(
  engine: HostEngine,
  providers: RemoteProvider[],
  models: (projectId?: unknown) => Promise<HostModelCatalog>,
) {
  const machine = hostname();
  const workspace = createMobileWorkspace(engine);
  const usage = createMobileUsage();
  const terminals = createMobileTerminals();
  /** The desktop's default model for a provider, once imported. */
  const defaultModel = (harness: HarnessId) =>
    resolveModel(harness, readLooks(dataDirOf(engine.store)).defaultModels[harness]);
  const monos = createMobileMonos(engine, async () => {
    const harness = defaultHarness();
    let model = defaultModel(harness);
    // Codex has no built-in models; take the first one this machine found.
    if (!model.id) {
      const found = (await models()).models[harness]?.[0];
      if (!found)
        throw new Error(`No ${HARNESS_TITLE[harness]} models found on this machine`);
      model = resolveModel(harness, found.id);
    }
    return {
      harness,
      model: model.id,
      modelSettings: mergeModelSettings(model, undefined),
    };
  });
  engine.turnPrompt ??= monos.prompt;
  const starts = new Map<string, Job>();
  const sends = new Map<string, Job>();
  const watches = new Map<number, Watch>();
  let nextWatch = 1;
  const sweep = () => {
    const now = Date.now();
    for (const [watchId, watch] of watches)
      if (now - watch.used > WATCH_IDLE_MS) watches.delete(watchId);
  };
  // Also while no phone is asking, so abandoned watches don't pile up.
  setInterval(sweep, WATCH_IDLE_MS).unref();

  const defaultHarness = (): RemoteProvider => {
    const harness = providers.includes("claude") ? "claude" : providers[0];
    if (!harness) throw new Error("No agent is installed on this machine");
    return harness;
  };
  const transcript = (
    value: HostSession,
    range?: (turnIds: string[]) => [number, number],
  ) => {
    const turns = mobileTranscript(value.session, {
      busy: value.status === "running",
      pendingQuestion: !!value.session.pendingQuestion,
      backgroundTasks: value.session.backgroundTasks,
      range,
    });
    // The phone approves here, not on a desktop.
    return turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item) =>
        item.type === "notice" && item.text.startsWith(DESKTOP_APPROVAL)
          ? { ...item, text: `Waiting for approval: ${item.text.slice(DESKTOP_APPROVAL.length)}` }
          : item,
      ),
    }));
  };
  const pendingApproval = (session: Session) =>
    session.blocks.find((block) => block.approval && !block.approval.decided);

  const catalog = () => {
    const looks = readLooks(dataDirOf(engine.store));
    const rank = (cwd: string) => {
      const index = looks.order.indexOf(cwd);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    // A Mono's own folder is where its conversation runs, not a project. The
    // rest in the desktop rail's order, then by name.
    const projects = engine.store
      .projects()
      .filter((project) => !monos.isMonoFolder(project.cwd))
      .sort((a, b) => rank(a.cwd) - rank(b.cwd));
    const sessions = projects.flatMap((project) =>
      engine.store
        .summaries(project.id)
        .filter((summary) => !summary.archived)
        .map((summary) => {
          let waiting = {};
          if (summary.needsInput) {
            const session = engine.store.session(summary.id).session;
            const block = pendingApproval(session);
            waiting = block
              ? {
                  waiting: "approval" as const,
                  approval: {
                    requestId: block.approval!.requestId,
                    label: toolCallLabel(block, session.cwd),
                  },
                }
              : session.pendingQuestion
                ? { waiting: "question" as const }
                : {};
          }
          return {
            id: summary.id,
            projectId: project.id,
            title: sessionDisplayTitle(summary.title, summary.harness),
            harness: summary.harness,
            model: summary.model ?? "",
            modelName: resolveModel(summary.harness, summary.model).name,
            branch: "",
            ...(summary.cwd && summary.cwd !== project.cwd
              ? { worktreePath: summary.cwd }
              : {}),
            runtimeMode: summary.runtimeMode,
            updatedAt: summary.updatedAt,
            busy: summary.status === "running",
            ...waiting,
          };
        }),
    );
    const harness = providers.length ? defaultHarness() : undefined;
    const model = harness ? defaultModel(harness) : undefined;
    return {
      projects: projects.map((project, index) => ({
        id: project.id,
        path: project.cwd,
        name: looks.projects[project.cwd]?.name ?? project.name,
        machine,
        branch: "",
        color: looks.projects[project.cwd]?.color ?? COLORS[index % COLORS.length],
        ...(looks.projects[project.cwd]?.mascot
          ? { mascot: looks.projects[project.cwd]!.mascot }
          : {}),
        additions: 0,
        deletions: 0,
        busy: sessions.some(
          (session) => session.projectId === project.id && session.busy,
        ),
        defaultHarness: harness,
        defaultModel: model?.id,
        defaultModelName: model?.name,
        defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
      })),
      monos: monos.list(projects),
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  };

  const modelCatalog = async (params: Record<string, unknown>) => {
    const conversationId =
      typeof params.conversationId === "string" ? params.conversationId : "";
    const current = conversationId
      ? engine.store.session(await monos.resolve(conversationId))
      : undefined;
    const projectId = current?.projectId ?? String(params.projectId ?? "");
    engine.store.project(projectId);
    const available = await models(projectId);
    const harnesses = providers.filter(
      (provider) => available.models[provider]?.length,
    );
    const harness = current?.session.harness ?? defaultHarness();
    const model = current
      ? resolveModel(harness, current.session.model)
      : defaultModel(harness);
    return {
      harnesses: harnesses.map((id) => ({ id, label: HARNESS_TITLE[id] })),
      models: harnesses.flatMap((harness) =>
        available.models[harness]!.map((entry) => ({
          id: entry.id,
          harness,
          name: entry.name,
          provider: entry.provider?.name,
          settings: entry.settings ?? [],
        })),
      ),
      runtimeModes: RUNTIME_MODES.map((id) => ({
        id,
        label: RUNTIME_MODE_LABEL[id],
        hint: RUNTIME_MODE_HINT[id],
      })),
      // The sign-ins a session can run with; the phone shows each one's usage.
      accounts: hostAccounts()
        .filter(
          (account) =>
            harnesses.includes(account.provider) &&
            // A copy only for the conversation already using it.
            (!account.duplicate ||
              (current?.session.harness === account.provider &&
                current.session.providerAccountId === account.id)),
        )
        .map(({ id, provider, label, isDefault }) => ({
          id,
          provider,
          label,
          isDefault,
        })),
      current: {
        harness,
        model: model.id,
        modelSettings: mergeModelSettings(model, current?.session.modelSettings),
        runtimeMode: current?.session.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        ...(harness === "claude" || harness === "codex"
          ? {
              providerAccountId:
                current?.session.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID,
            }
          : {}),
      },
    };
  };

  const frame = (watch: Watch) => {
    const value = engine.store.session(watch.conversationId);
    if (watch.baseline && value.revision === watch.revision) return null;
    let older = false;
    const turns = transcript(value, (turnIds) => {
      const window = watchWindow(turnIds, watch.from, watch.tail);
      watch.from = window.from;
      older = window.older;
      return [window.start, turnIds.length];
    });
    watch.revision = value.revision;
    return watchUpdate(
      watch.baseline,
      { busy: value.status === "running", older, turns },
      watch.incremental,
    );
  };

  const next = async (watchId: number, timeoutMs: number) => {
    const deadline =
      Date.now() + Math.min(Math.max(0, timeoutMs || 0), NEXT_MAX_MS);
    for (;;) {
      const watch = watches.get(watchId);
      if (!watch) throw new Error("Watch ended");
      watch.used = Date.now();
      let result;
      try {
        result = frame(watch);
      } catch (error) {
        watches.delete(watchId);
        return {
          updates: [
            { error: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
      if (result) {
        watch.baseline = result.baseline;
        return { updates: [result.update] };
      }
      if (Date.now() >= deadline) return { updates: [] };
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };

  const text = (params: Record<string, unknown>, attached = false) => {
    const value = typeof params.text === "string" ? params.text.trim() : "";
    // Attachments on their own are a message; the desktop sends those too.
    if ((!value && !attached) || value.length > 100_000)
      throw new Error("Enter a message under 100,000 characters");
    return value;
  };
  /** The session a conversation id names; `mono:<id>` is that Mono's own. */
  const conversation = async (params: Record<string, unknown>) =>
    engine.store.session(
      await monos.resolve(String(params.conversationId ?? "")),
    );

  /**
   * Sends one message, with any attachments already staged for it. The caller
   * removes those again if the turn is refused, so nothing is left behind.
   */
  const deliver = (
    commandId: string,
    sessionId: string,
    message: string,
    attachments: RemoteAttachment[],
  ) =>
    engine.command({
      type: "send",
      commandId,
      sessionId,
      text: message,
      ...(attachments.length ? { attachments } : {}),
    });

  /** The named account a new session runs with; none means the default. */
  const startAccount = (harness: RemoteProvider, id: unknown) => {
    if (id === undefined || id === DEFAULT_PROVIDER_ACCOUNT_ID) return undefined;
    if (harness !== "claude" && harness !== "codex")
      throw new Error("This provider does not support account switching");
    if (!hostAccount(harness, id))
      throw new Error(
        "Account is no longer available. Choose another account in the model picker.",
      );
    return id as string;
  };

  /** Everything `session.start` does, so one command id runs it only once. */
  const start = async (id: string, params: Record<string, unknown>) => {
    const attached = Array.isArray(params.attachments)
      ? params.attachments.length > 0
      : false;
    const message = text(params, attached);
    const project = engine.store.project(String(params.projectId ?? ""));
    // Staged before a worktree or a session exists, so malformed attachments
    // fail with nothing created; and removed again if anything after them does.
    const { attachments, created } = stage("session.start", id, params);
    try {
      const harness =
        isRemoteProvider(params.harness) && providers.includes(params.harness)
          ? params.harness
          : defaultHarness();
      let model =
        typeof params.model === "string"
          ? resolveModel(harness, params.model)
          : defaultModel(harness);
      // Codex has no built-in models; take the first one this machine found.
      if (!model.id) {
        const found = (await models(project.id)).models[harness]?.[0];
        if (!found)
          throw new Error(`No ${HARNESS_TITLE[harness]} models found on this machine`);
        model = resolveModel(harness, found.id);
      }
      const providerAccountId = startAccount(harness, params.providerAccountId);
      const runtimeMode = RUNTIME_MODES.includes(
        params.runtimeMode as RuntimeMode,
      )
        ? (params.runtimeMode as RuntimeMode)
        : DEFAULT_RUNTIME_MODE;
      // A named worktree runs the session there; "worktree" mode makes a
      // fresh one on a temporary branch, as the desktop's picker does.
      let worktreeCwd: string | undefined;
      let autoWorktreeBranch: string | undefined;
      if (params.workspaceMode === "worktree") {
        // Named after the command id, not at random, so a phone retrying a
        // start whose reply it lost — even after a host restart, which empties
        // the in-memory record of it — reuses that worktree instead of
        // stranding it and making another.
        autoWorktreeBranch = `mc/${createHash("sha256")
          .update(id)
          .digest("hex")
          .slice(0, 8)}`;
        const listed = await hostWorktrees(project.cwd);
        // By branch, and by the path that branch name gets, because the engine
        // renames a temporary branch once the session has a title.
        const expected = join(listed.defaultRoot, `wt-${autoWorktreeBranch.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
        const existing = listed.worktrees.find(
          (tree) =>
            !tree.missing &&
            (tree.branch === autoWorktreeBranch || tree.path === expected),
        );
        worktreeCwd =
          existing?.path ??
          (await createHostWorktree(
            project.cwd,
            autoWorktreeBranch,
            "HEAD",
            false,
          )).path;
      } else if (typeof params.worktreePath === "string" && params.worktreePath) {
        worktreeCwd = resolveHostWorktree(project.cwd, params.worktreePath);
      }
      const created = engine.command({
        type: "create",
        commandId: `${id}:create`,
        projectId: project.id,
        ...(worktreeCwd ? { worktreeCwd } : {}),
        ...(autoWorktreeBranch ? { autoWorktreeBranch } : {}),
        harness,
        model: model.id,
        modelSettings: mergeModelSettings(
          model,
          stringRecord(params.modelSettings),
        ),
        runtimeMode,
        ...(providerAccountId ? { providerAccountId } : {}),
      });
      // A message of attachments alone has no first line to name the session by;
      // it keeps the default title until the harness renames it.
      const title = message.split("\n")[0].slice(0, 80);
      if (title && engine.store.session(created.sessionId).session.title !== title)
        engine.updateSession(created.sessionId, { title });
      deliver(`${id}:send`, created.sessionId, message, attachments);
      return { sessionId: created.sessionId };
    } catch (error) {
      discardAttachments(engine.store, created);
      throw error;
    }
  };

  /**
   * Attachment ids are namespaced by the method as well as the command id, so
   * a start and a send that happen to share an id never land on each other's
   * files, however the phone allocates them.
   */
  const stage = (
    method: string,
    id: string,
    params: Record<string, unknown>,
  ) =>
    stageInlineAttachments(
      engine.store,
      params.attachments,
      `${method}\u0000${id}`,
    );

  return async (input: MobileRequest, token: string): Promise<unknown> => {
    const { id, method, params } = input;
    const now = Date.now();
    sweep();
    switch (method) {
      case "workspace.list":
        return catalog();
      case "device.leave":
        return { revoked: engine.store.revokeToken(token) };
      case "models.list":
        return modelCatalog(params);
      case "conversation.read": {
        const value = await conversation(params);
        return {
          id: value.session.id,
          messages: messages(value.session),
          turns: transcript(value),
          busy: value.status === "running",
        };
      }
      case "conversation.older": {
        const value = await conversation(params);
        let older = false;
        const turns = transcript(value, (turnIds) => {
          const page = turnsBefore(
            turnIds,
            String(params.before ?? ""),
            Math.min(MAX_PAGE, Math.max(1, Number(params.limit) || DEFAULT_TAIL)),
          );
          older = page.older;
          return [page.start, page.end];
        });
        return { turns, older };
      }
      case "conversation.watch": {
        const watched = (await conversation(params)).session.id;
        if (watches.size >= MAX_WATCHES) {
          const [stalest] = [...watches].sort((a, b) => a[1].used - b[1].used)[0];
          watches.delete(stalest);
        }
        const watchId = nextWatch++;
        watches.set(watchId, {
          conversationId: watched,
          baseline: null,
          revision: null,
          tail: Math.min(
            MAX_PAGE,
            Math.max(1, Number(params.tail) || DEFAULT_TAIL),
          ),
          incremental: params.incremental === true,
          from: typeof params.from === "string" ? params.from : null,
          used: now,
        });
        return { watchId };
      }
      case "watch.next":
        return next(Number(params.watchId), Number(params.timeoutMs));
      case "watch.close":
        watches.delete(Number(params.watchId));
        return {};
      case "accounts.usage":
        return usage(params);
      case "terminal.open": {
        const cwd = await workspace.root(params);
        return terminals.open(cwd, params);
      }
      case "terminal.read":
        return terminals.read(params);
      case "terminal.write":
        return terminals.write(params);
      case "terminal.close":
        return terminals.close(params);
      case "project.files":
        return workspace.files(params);
      case "project.file":
        return workspace.file(params);
      case "project.search":
        return workspace.search(params);
      case "project.changes":
        return workspace.changes(params);
      case "project.git":
        return workspace.git(params);
      case "project.gitAction":
        return workspace.gitAction(id, params);
      case "project.worktrees":
        return workspace.worktrees(params);
      case "session.start":
        return once(starts, id, params, MAX_JOBS, () => start(id, params));
      case "conversation.send":
        // Deduplicated, like a start, so a retry joins the first attempt
        // rather than racing it.
        return once(sends, id, params, MAX_JOBS, async () => {
          const value = await conversation(params);
          const attached = Array.isArray(params.attachments)
            ? params.attachments.length > 0
            : false;
          const message = text(params, attached);
          const { attachments, created } = stage("conversation.send", id, params);
          try {
            deliver(id, value.session.id, message, attachments);
          } catch (error) {
            discardAttachments(engine.store, created);
            throw error;
          }
          return { sessionId: value.session.id };
        });
      case "session.cancel": {
        const value = await conversation(params);
        if (value.status === "running" && value.runId)
          engine.command({
            type: "cancel",
            commandId: id,
            sessionId: value.session.id,
            runId: value.runId,
          });
        return { sessionId: value.session.id };
      }
      case "session.approve": {
        const value = await conversation(params);
        if (!value.runId) throw new Error("This turn already ended");
        engine.command({
          type: "approve",
          commandId: id,
          sessionId: value.session.id,
          runId: value.runId,
          requestId: Number(params.requestId),
          decision: params.decision === "allow" ? "allow" : "deny",
        });
        return { sessionId: value.session.id };
      }
      case "session.configure": {
        const value = await conversation(params);
        if (
          isRemoteProvider(params.harness) &&
          params.harness !== value.session.harness
        )
          throw new Error("Start a new session to switch provider");
        const model = resolveModel(
          value.session.harness,
          typeof params.model === "string" ? params.model : value.session.model,
        );
        engine.command({
          type: "configure",
          commandId: id,
          sessionId: value.session.id,
          model: model.id,
          modelSettings: mergeModelSettings(
            model,
            stringRecord(params.modelSettings) ?? value.session.modelSettings,
          ),
          runtimeMode: RUNTIME_MODES.includes(params.runtimeMode as RuntimeMode)
            ? (params.runtimeMode as RuntimeMode)
            : value.session.runtimeMode,
        });
        return { sessionId: value.session.id };
      }
      case "session.rename": {
        const value = await conversation(params);
        const title = typeof params.title === "string" ? params.title.trim() : "";
        if (!title || title.length > 200)
          throw new Error("Enter a title under 200 characters");
        engine.updateSession(value.session.id, { title });
        return { sessionId: value.session.id };
      }
      case "session.archive": {
        const value = await conversation(params);
        engine.updateSession(value.session.id, { archived: true });
        return { sessionId: value.session.id };
      }
      case "session.delete": {
        const value = await conversation(params);
        if (value.status === "running")
          throw new Error("Stop the session before deleting it");
        engine.store.deleteSession(value.session.id);
        return { sessionId: value.session.id };
      }
      default:
        throw new Error("Not available on this machine yet");
    }
  };
}

function messages(session: Session) {
  return session.blocks
    .filter(
      (block) =>
        (block.role === "user" || block.role === "assistant") &&
        !block.internal &&
        !block.draft,
    )
    .slice(-200)
    .map((block) => ({ id: block.id, role: block.role, text: block.text }));
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
