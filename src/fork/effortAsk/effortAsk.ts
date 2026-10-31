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

const EFFORT_LINE = /^effort\s*:\s*([\w-]+)\s+now\s*,\s*([\w-]+)\s+needed\b/i;

/** Reads <now> and <needed> from a reply's first non-empty line, ignoring markdown. */
export function parseEffortLine(
  text: string,
): { now: string; needed: string } | null {
  const first = text
    .split("\n")
    .map((line) => line.replace(/[*`_]/g, "").trim())
    .find(Boolean);
  const match = first ? EFFORT_LINE.exec(first) : null;
  return match
    ? { now: match[1].toLowerCase(), needed: match[2].toLowerCase() }
    : null;
}

/** Reads <needed> from a reply's first non-empty line, ignoring markdown. */
export function parseEffortNeeded(text: string): string | null {
  return parseEffortLine(text)?.needed ?? null;
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
  /** The model stopped on its line to wait for this: send the turn on. */
  resume?: boolean;
};


/** The line and nothing else, not even an answer on the same line. */
const BARE_LINE =
  /^effort\s*:\s*[\w-]+\s+now\s*,\s*[\w-]+\s+needed\s*(\([^)\n]*\))?\s*\.?$/i;

/** A plan-mode reply has been moved to a plan block by the time a turn ends. */
function isEffortLineBlock(block: Pick<Block, "role" | "text">): boolean {
  return (
    (block.role === "assistant" || block.role === "plan") &&
    parseEffortLine(block.text) != null
  );
}

/**
 * On a raise the effort gate tells the model to end its reply on the line, so
 * MonoCode can raise the effort and send the turn on at once. True only when
 * it did: no work before the line's block, nothing after it but reasoning (an
 * interrupt note counts as something), and no text after the line itself: a
 * short finished answer ("No findings.") must not be run again.
 */
export function stoppedAtEffortLine(
  blocks: readonly Pick<Block, "role" | "text">[],
): boolean {
  let line = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isEffortLineBlock(blocks[i])) {
      line = i;
      break;
    }
  }
  if (line < 0) {
    return false;
  }
  if (blocks.slice(line + 1).some((block) => block.role !== "reasoning")) {
    return false;
  }
  // Status notes may come first; work (tools, text) may not.
  if (
    blocks
      .slice(0, line)
      .some((block) => block.role !== "reasoning" && block.role !== "system")
  ) {
    return false;
  }
  return BARE_LINE.test(blocks[line].text.replace(/[*`_]/g, "").trim());
}

/** What MonoCode sends to carry on a turn the model stopped for a raise. */
export function resumeText(value: string): string {
  return `Continue at ${value} effort.`;
}

const RESUME_TEXT = /^Continue at [\w-]+ effort\.$/;

/**
 * The model's option for a level: that level, else the nearest one above it
 * (never under what was asked), else the model's highest.
 */
function optionFor(
  options: readonly { value: string }[],
  needed: string,
): string | null {
  const want = EFFORT_RANK.indexOf(needed);
  const ranked = options
    .map((option) => ({
      value: option.value,
      rank: EFFORT_RANK.indexOf(option.value.toLowerCase()),
    }))
    .filter((option) => option.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (want < 0 || ranked.length === 0) {
    return null;
  }
  return (ranked.find((option) => option.rank >= want) ?? ranked[ranked.length - 1]!).value;
}

function eligible(session: Session): boolean {
  return !isMonoSession(session.id) && !session.ephemeral && !session.pendingSwitch;
}

/** What this session's finished turn asks to be switched to, if anything. */
export function effortChangeFor(session: Session): EffortChange | null {
  if (!eligible(session)) {
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
  const value = optionFor(setting.options, needed);
  const current = session.modelSettings[setting.id] ?? setting.value;
  const from = EFFORT_RANK.indexOf(current.toLowerCase());
  const to = value ? EFFORT_RANK.indexOf(value.toLowerCase()) : -1;
  if (!value || from < 0 || to < 0 || to === from) {
    return null;
  }
  return {
    settingId: setting.id,
    value,
    direction: to > from ? "raised" : "lowered",
  };
}

/**
 * The level to send a turn on at, when the model stopped on a line asking for
 * more than it was told it had. Judged by the line, not by the session: the
 * level the gate told the model can be stale, so the session may already be
 * there or even above. Without a change it never answers its own send, so a
 * stale level costs one turn and never loops.
 */
export function resumeLevelFor(
  session: Session,
  change: EffortChange | null,
): string | null {
  if (!eligible(session) || session.queuedMessages?.length) {
    return null;
  }
  const start = turnStartIndex(session);
  if (start < 0) {
    return null;
  }
  const turn = session.blocks.slice(start + 1);
  const lineBlock = [...turn].reverse().find(isEffortLineBlock);
  const line = lineBlock && parseEffortLine(lineBlock.text);
  const model = findModel(session.model);
  const setting = model && modelEffortSetting(model);
  if (!line || !setting || !stoppedAtEffortLine(turn)) {
    return null;
  }
  const now = EFFORT_RANK.indexOf(line.now);
  if (now < 0 || EFFORT_RANK.indexOf(line.needed) <= now) {
    return null;
  }
  if (!change && RESUME_TEXT.test(session.blocks[start].text.trim())) {
    return null;
  }
  return change?.value ?? session.modelSettings[setting.id] ?? setting.value;
}

/** Plan and Orchestrator turns carry on in their mode. */
export function resumeIntentFor(
  session: Session,
): "plan" | "orchestrate" | undefined {
  const start = turnStartIndex(session);
  return start < 0 ? undefined : session.blocks[start].intent;
}

/** Sessions the user stopped; their turn is not sent on. */
const userStopped = new Set<string>();

/** Called by the app's Stop, before the session goes idle. */
export function noteEffortStop(sessionId: string) {
  userStopped.add(sessionId);
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
  stale?: Map<string, string>,
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
    // A Stop is for the turn that just went idle, whether it asked or not.
    const stopped = idle.has(session.id) && userStopped.delete(session.id);
    seen.set(session.id, turnId);
    if (!ended) {
      continue;
    }
    const change = effortChangeFor(session);
    const resume = stopped ? null : resumeLevelFor(session, change);
    if (change) {
      changes.set(session.id, { ...change, resume: resume != null });
    } else if (resume && stale) {
      stale.set(session.id, resume);
    }
  }
  return changes;
}

type Submit = (
  sessionId: string,
  text: string,
  attachments: never[],
  options: { intent?: "plan" | "orchestrate" },
) => boolean | Promise<unknown>;

function sendOn(submit: Submit, session: Session, level: string) {
  const sent = submit(session.id, resumeText(level), [], {
    intent: resumeIntentFor(session),
  });
  if (typeof sent !== "boolean") {
    void Promise.resolve(sent).catch(() => undefined);
  }
}

/**
 * Sets the session directly rather than through the picker's handler, which
 * also saves the choice as the default for new sessions. One session's task
 * should not decide the effort every later session starts on.
 *
 * A raise the model stopped for is sent on once the new effort is in the
 * session, so the turn after it already runs at the new level. If the user
 * gets there first (the session is busy again), theirs is the turn.
 */
export function useEffortAsks(
  sessions: Session[],
  setSessions: Dispatch<SetStateAction<Session[]>>,
  submit: { current: Submit },
) {
  const wasBusy = useRef(new Set<string>());
  const seen = useRef(new Map<string, string>());
  const resumes = useRef(new Map<string, EffortChange>());

  useEffect(() => {
    if (!FORK_EFFORT_ASK) {
      return;
    }
    for (const [sessionId, change] of resumes.current) {
      const session = sessions.find((item) => item.id === sessionId);
      // Stop after the raise but before the send cancels the send.
      if (!session || session.busy || userStopped.delete(sessionId)) {
        resumes.current.delete(sessionId);
        continue;
      }
      if (
        session.pendingSwitch ||
        session.modelSettings[change.settingId] !== change.value
      ) {
        continue;
      }
      resumes.current.delete(sessionId);
      sendOn(submit.current, session, change.value);
    }
    const stale = new Map<string, string>();
    const changes = effortChangesOfEndedTurns(
      sessions,
      wasBusy.current,
      seen.current,
      stale,
    );
    for (const [sessionId, level] of stale) {
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        sendOn(submit.current, session, level);
      }
    }
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
      if (change.resume) {
        resumes.current.set(sessionId, change);
      }
      for (const listener of changeListeners) {
        listener(sessionId, change);
      }
    }
  }, [sessions, setSessions, submit]);
}
