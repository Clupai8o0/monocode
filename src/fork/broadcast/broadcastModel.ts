/**
 * Fork: "Send to all". Who a message to every session reaches, who it leaves
 * out and why, and what became of each send. No React and no app state: the
 * button passes in what it read.
 */

export const BROADCAST_EVENT = "monocode:fork-broadcast";

/** The project on screen, every project, or one picked by its folder. */
export type BroadcastScope = "project" | "all" | { path: string };

/** The parts of a session this decides on. */
export type BroadcastSession = {
  id: string;
  cwd: string;
  busy?: boolean;
  archived?: boolean;
  sidebarHidden?: boolean;
  inboxAsk?: unknown;
  worktreeRemoved?: boolean;
  orchestrationLeadId?: string;
  blocks: readonly { role: string; draft?: boolean }[];
};

export type BroadcastFacts = {
  scope: BroadcastScope;
  /** The project on screen. */
  project: string | undefined;
  sameProject: (a: string, b: string) => boolean;
  /** A Mono's chat, the Sweep Mono's among them. */
  isMono: (id: string) => boolean;
  isOrchestrationLead: (session: BroadcastSession) => boolean;
  needsInput: (session: BroadcastSession) => boolean;
  /** Text typed in its composer and not sent. */
  composerDraft: (id: string) => string | undefined;
  isRemote: (cwd: string) => boolean;
  /** A remote session can only be reached while the app holds its connection. */
  remoteReachable: (id: string) => boolean;
};

export type LeftOutReason =
  | "mono"
  | "orchestration"
  | "needs input"
  | "draft"
  | "not started";

/** Would take it now, or after its turn, or is shown unticked with why not. */
export type BroadcastTarget = {
  id: string;
  when: "now" | "after this turn";
  blocked?: string;
};

export type BroadcastPlan = {
  targets: BroadcastTarget[];
  leftOut: Partial<Record<LeftOutReason, number>>;
};

function leftOutReason(
  session: BroadcastSession,
  facts: BroadcastFacts,
): LeftOutReason | undefined {
  if (facts.isMono(session.id)) {
    return "mono";
  }
  if (session.orchestrationLeadId || facts.isOrchestrationLead(session)) {
    return "orchestration";
  }
  if (facts.needsInput(session)) {
    return "needs input";
  }
  if (
    session.blocks.some((block) => block.role === "user" && block.draft) ||
    facts.composerDraft(session.id)?.trim()
  ) {
    return "draft";
  }
  // A blank tab has no conversation to join; this would start one.
  if (!session.blocks.some((block) => block.role === "user")) {
    return "not started";
  }
  return undefined;
}

/** Not really open: gone from the sidebar, and never counted as left out. */
function hidden(session: BroadcastSession): boolean {
  return !!(
    session.archived ||
    session.sidebarHidden ||
    session.inboxAsk ||
    session.worktreeRemoved
  );
}

function inScope(session: BroadcastSession, facts: BroadcastFacts): boolean {
  if (facts.scope === "all") {
    return true;
  }
  const path = facts.scope === "project" ? facts.project : facts.scope.path;
  return !!path && facts.sameProject(session.cwd, path);
}

/** The folders that can be picked as one project, each once, in session order. */
export function broadcastProjects(
  sessions: readonly BroadcastSession[],
  facts: Pick<BroadcastFacts, "sameProject" | "isMono">,
): string[] {
  const paths: string[] = [];
  for (const session of sessions) {
    if (
      !hidden(session) &&
      !facts.isMono(session.id) &&
      !paths.some((path) => facts.sameProject(path, session.cwd))
    ) {
      paths.push(session.cwd);
    }
  }
  return paths;
}

export function planBroadcast(
  sessions: readonly BroadcastSession[],
  facts: BroadcastFacts,
): BroadcastPlan {
  const plan: BroadcastPlan = { targets: [], leftOut: {} };
  for (const session of sessions) {
    if (hidden(session) || !inScope(session, facts)) {
      continue;
    }
    const reason = leftOutReason(session, facts);
    if (reason) {
      plan.leftOut[reason] = (plan.leftOut[reason] ?? 0) + 1;
      continue;
    }
    const target: BroadcastTarget = {
      id: session.id,
      when: session.busy ? "after this turn" : "now",
    };
    if (facts.isRemote(session.cwd)) {
      if (session.busy) {
        target.blocked = "Busy on another machine, and it can't queue from here";
      } else if (!facts.remoteReachable(session.id)) {
        target.blocked = "Open it once to connect to its machine";
      }
    }
    plan.targets.push(target);
  }
  return plan;
}

const LEFT_OUT_WORDS: Record<LeftOutReason, [string, string]> = {
  mono: ["1 Mono", "Monos"],
  orchestration: ["1 orchestration session", "orchestration sessions"],
  "needs input": ["1 needs your input", "need your input"],
  draft: ["1 holds a draft", "hold a draft"],
  "not started": ["1 not started", "not started"],
};

/** "Left out: 2 need your input, 1 holds a draft"; empty with none. */
export function leftOutLine(leftOut: BroadcastPlan["leftOut"]): string {
  const parts = (Object.keys(LEFT_OUT_WORDS) as LeftOutReason[]).flatMap((reason) => {
    const count = leftOut[reason];
    if (!count) {
      return [];
    }
    const [one, many] = LEFT_OUT_WORDS[reason];
    return [count === 1 ? one : `${count} ${many}`];
  });
  return parts.length ? `Left out: ${parts.join(", ")}` : "";
}

/** "Send to 7 sessions". */
export function sendLabel(count: number): string {
  return `Send to ${count} ${count === 1 ? "session" : "sessions"}`;
}

/** A session may first sync its project, so the answer can come later. */
export type BroadcastSubmit = (id: string, text: string) => boolean | Promise<boolean>;

export type BroadcastResult = {
  id: string;
  outcome: "sent" | "queued" | "failed";
  why?: string;
};

/**
 * Sends to each target that is still fit to take it, by the composer's path.
 * The plan on screen may be seconds old, so `fresh` is planned just before.
 */
export function sendBroadcast(
  chosen: ReadonlySet<string>,
  fresh: BroadcastPlan,
  text: string,
  submit: BroadcastSubmit,
): Promise<BroadcastResult[]> {
  const byId = new Map(fresh.targets.map((target) => [target.id, target]));
  return Promise.all(
    [...chosen].map(async (id): Promise<BroadcastResult> => {
      const target = byId.get(id);
      if (!target) {
        return { id, outcome: "failed", why: "It can't take this now" };
      }
      if (target.blocked) {
        return { id, outcome: "failed", why: target.blocked };
      }
      try {
        return (await submit(id, text))
          ? { id, outcome: target.when === "now" ? "sent" : "queued" }
          : { id, outcome: "failed", why: "It did not accept the message" };
      } catch (error) {
        return { id, outcome: "failed", why: String(error) };
      }
    }),
  );
}

/** What App lends the bar, by answering BROADCAST_EVENT. */
export type BroadcastApp<S extends BroadcastSession = BroadcastSession> = {
  sessions: () => readonly S[];
  project: () => string | undefined;
  /** The same path as typing in that session's composer. */
  submit: BroadcastSubmit;
};

export function connectBroadcast<S extends BroadcastSession>(): BroadcastApp<S> | null {
  let app: BroadcastApp<S> | null = null;
  window.dispatchEvent(
    new CustomEvent<(answer: BroadcastApp<S>) => void>(BROADCAST_EVENT, {
      detail: (answer) => {
        app = answer;
      },
    }),
  );
  return app;
}
