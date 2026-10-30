import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { isMonoSession } from "../../features/monos/model/mono";
import {
  findModel,
  modelEffortSetting,
} from "../../features/sessions/model/models";
import type { Block, Session } from "../../features/sessions/model/session";

/**
 * Fork feature: sessions on this Mac start a reply with
 * "Effort: <now> now, <needed> needed (<reason>)". When a turn ends asking for
 * a different effort than the session is set to, this switches the session's
 * own effort, up or down, so it applies from the next turn.
 */

/** Off under the test runner, so upstream App tests see no extra updates. */
const FORK_EFFORT_ASK = import.meta.env.MODE !== "test";

/**
 * Told to the CLI through MONOCODE_EFFORT_AUTO, so the vault's effort gate only
 * promises a switch on sessions this feature really switches.
 */
export function effortAutoFor(sessionId: string, ephemeral?: boolean): boolean {
  return FORK_EFFORT_ASK && !ephemeral && !isMonoSession(sessionId);
}

/** Providers list their options in either order, so rank by name. */
const EFFORT_RANK = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_LINE = /^effort\s*:\s*[\w-]+\s+now\s*,\s*([\w-]+)\s+needed\b/i;

/** Reads <needed> from a reply's first non-empty line, ignoring markdown. */
export function parseEffortNeeded(text: string): string | null {
  const first = text
    .split("\n")
    .map((line) => line.replace(/[*`_]/g, "").trim())
    .find(Boolean);
  const match = first ? EFFORT_LINE.exec(first) : null;
  return match ? match[1].toLowerCase() : null;
}

/** Index of the user block that started the current turn, or -1. */
function turnStartIndex(session: Pick<Session, "blocks" | "queuedMessages">) {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (
      block.role === "user" &&
      !block.draft &&
      // Mid-turn follow-ups and queued messages do not start a turn.
      (block.sentAt == null || block.startedAt != null) &&
      !session.queuedMessages?.some((message) => message.blockId === block.id)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * The latest <needed> of a turn. The line comes before any tool call, so with
 * tools in the turn it is on an earlier assistant block, not the last one. A
 * plan-mode reply has already been moved to a plan block by the time a turn ends.
 */
export function effortNeededOfBlocks(
  blocks: readonly Pick<Block, "role" | "text">[],
): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role !== "assistant" && block.role !== "plan") {
      continue;
    }
    const needed = parseEffortNeeded(block.text);
    if (needed) {
      return needed;
    }
  }
  return null;
}

export type EffortChange = {
  settingId: string;
  value: string;
  direction: "raised" | "lowered";
};

/** What this session's finished turn asks to be switched to, if anything. */
export function effortChangeFor(session: Session): EffortChange | null {
  if (isMonoSession(session.id) || session.ephemeral || session.pendingSwitch) {
    return null;
  }
  const start = turnStartIndex(session);
  if (start < 0) {
    return null;
  }
  const needed = effortNeededOfBlocks(session.blocks.slice(start + 1));
  const model = findModel(session.model);
  const setting = model && modelEffortSetting(model);
  if (!needed || !setting) {
    return null;
  }
  const option = setting.options.find(
    (choice) => choice.value.toLowerCase() === needed,
  );
  const current = session.modelSettings[setting.id] ?? setting.value;
  const from = EFFORT_RANK.indexOf(current.toLowerCase());
  const to = EFFORT_RANK.indexOf(needed);
  if (!option || from < 0 || to < 0 || to === from) {
    return null;
  }
  return {
    settingId: setting.id,
    value: option.value,
    direction: to > from ? "raised" : "lowered",
  };
}

/** The ids that went busy -> idle. Updates `wasBusy` to the current state. */
export function sessionsGoneIdle(
  sessions: readonly Pick<Session, "id" | "busy">[],
  wasBusy: Set<string>,
): Set<string> {
  const idle = new Set<string>();
  const live = new Set<string>();
  for (const { id, busy } of sessions) {
    if (busy) {
      live.add(id);
    } else if (wasBusy.has(id)) {
      idle.add(id);
    }
  }
  wasBusy.clear();
  for (const id of live) {
    wasBusy.add(id);
  }
  return idle;
}

/** The session with the change applied and a note left in its transcript. */
export function withEffortChange(
  session: Session,
  change: EffortChange,
): Session {
  return {
    ...session,
    modelSettings: {
      ...session.modelSettings,
      [change.settingId]: change.value,
    },
    blocks: [
      ...session.blocks,
      {
        id: crypto.randomUUID(),
        role: "system",
        text: `Effort ${change.direction} to ${change.value} (model asked)`,
      },
    ],
  };
}

const changeListeners = new Set<
  (sessionId: string, change: EffortChange) => void
>();

/** Tells the meter a change came from the model, not from the picker. */
export function subscribeEffortChanges(
  listener: (sessionId: string, change: EffortChange) => void,
): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * The changes turns that just ended ask for. `seen` holds the last turn read
 * per session, whether it asked for anything or not: busy also flips without a
 * new turn (compaction), and that must not replay an old line over a manual
 * choice. A session first seen idle only records its turn, for the same reason.
 */
export function effortChangesOfEndedTurns(
  sessions: readonly Session[],
  wasBusy: Set<string>,
  seen: Map<string, string>,
): Map<string, EffortChange> {
  const idle = sessionsGoneIdle(sessions, wasBusy);
  const changes = new Map<string, EffortChange>();
  for (const session of sessions) {
    if (session.busy) {
      continue;
    }
    const known = seen.has(session.id);
    if (known && !idle.has(session.id)) {
      continue;
    }
    const start = turnStartIndex(session);
    const turnId = start < 0 ? "" : session.blocks[start].id;
    const ended = idle.has(session.id) && seen.get(session.id) !== turnId;
    seen.set(session.id, turnId);
    const change = ended ? effortChangeFor(session) : null;
    if (change) {
      changes.set(session.id, change);
    }
  }
  return changes;
}

/**
 * Sets the session directly rather than through the picker's handler, which
 * also saves the choice as the default for new sessions. One session's task
 * should not decide the effort every later session starts on.
 */
export function useEffortAsks(
  sessions: Session[],
  setSessions: Dispatch<SetStateAction<Session[]>>,
) {
  const wasBusy = useRef(new Set<string>());
  const seen = useRef(new Map<string, string>());

  useEffect(() => {
    if (!FORK_EFFORT_ASK) {
      return;
    }
    const changes = effortChangesOfEndedTurns(
      sessions,
      wasBusy.current,
      seen.current,
    );
    if (changes.size === 0) {
      return;
    }
    setSessions((prev) =>
      prev.map((session) => {
        const change = changes.get(session.id);
        return change ? withEffortChange(session, change) : session;
      }),
    );
    for (const [sessionId, change] of changes) {
      for (const listener of changeListeners) {
        listener(sessionId, change);
      }
    }
  }, [sessions, setSessions]);
}
