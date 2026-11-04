import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { isMonoSession } from "../../features/monos/model/mono";
import {
  findModel,
  modelEffortSetting,
} from "../../features/sessions/model/models";
import type { Block, Session } from "../../features/sessions/model/session";
import { cappedAutoOption } from "./effortCap";

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
  const first = firstContentLine(text);
  const match = first ? EFFORT_LINE.exec(first) : null;
  return match
    ? { now: match[1].toLowerCase(), needed: match[2].toLowerCase() }
    : null;
}

/**
 * The first non-empty line, with emphasis markers removed. A streaming reply
 * is checked on every update, so the rest of a long message stays unread.
 */
function firstContentLine(text: string): string {
  let start = 0;
  const length = text.length;
  while (start < length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = length;
    const line = text.slice(start, end).replace(/[*`_]/g, "").trim();
    if (line) return line;
    start = end + 1;
  }
  return "";
}

/** Reads <needed> from a reply's first non-empty line, ignoring markdown. */
export function parseEffortNeeded(text: string): string | null {
  return parseEffortLine(text)?.needed ?? null;
}

const NO_QUEUED_BLOCKS: ReadonlySet<string> = new Set();

function queuedBlockIds(
  messages: Session["queuedMessages"] | undefined,
): ReadonlySet<string> {
  if (!messages?.length) return NO_QUEUED_BLOCKS;
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.blockId) ids.add(message.blockId);
  }
  return ids;
}

/** Index of the user block that started the current turn, or -1. */
function turnStartIndex(session: Pick<Session, "blocks" | "queuedMessages">) {
  const queued = queuedBlockIds(session.queuedMessages);
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (
      block.role === "user" &&
      !block.draft &&
      // Mid-turn follow-ups and queued messages do not start a turn.
      (block.sentAt == null || block.startedAt != null) &&
      !queued.has(block.id)
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
  return effortNeededFrom(blocks, 0, blocks.length);
}

function effortNeededFrom(
  blocks: readonly Pick<Block, "role" | "text">[],
  start: number,
  end: number,
): string | null {
  for (let i = end - 1; i >= start; i--) {
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

function onlyEffortLines(text: string): boolean {
  let start = 0;
  let first: { now: string; needed: string } | null = null;
  const length = text.length;
  while (start < length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = length;
    const line = text.slice(start, end).replace(/[*`_]/g, "").trim();
    start = end + 1;
    if (!line) continue;
    const parsed = parseEffortLine(line);
    if (!first) {
      first = parsed;
      if (!first || !BARE_LINE.test(line)) return false;
      continue;
    }
    if (
      !BARE_LINE.test(line) ||
      parsed?.now !== first.now ||
      parsed.needed !== first.needed
    ) {
      return false;
    }
  }
  return first != null;
}

/**
 * True when a non-empty line follows the effort line and the block is not
 * only that line repeated. Stops at the first such line.
 */
function continuedPastEffortLine(text: string): boolean {
  let start = 0;
  let first: { now: string; needed: string } | null = null;
  let bare = true;
  let extra = false;
  const length = text.length;
  while (start < length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = length;
    const line = text.slice(start, end).replace(/[*`_]/g, "").trim();
    start = end + 1;
    if (!line) continue;
    if (!first) {
      first = parseEffortLine(line);
      if (!first) return false;
      if (!BARE_LINE.test(line)) bare = false;
      continue;
    }
    extra = true;
    const parsed = parseEffortLine(line);
    if (
      !BARE_LINE.test(line) ||
      parsed?.now !== first.now ||
      parsed.needed !== first.needed
    ) {
      return true;
    }
  }
  return extra && !bare;
}

/** A plan-mode reply has been moved to a plan block by the time a turn ends. */
function isEffortLineBlock(block: Pick<Block, "role" | "text">): boolean {
  return (
    (block.role === "assistant" || block.role === "plan") &&
    parseEffortLine(block.text) != null
  );
}

function lastEffortLine(
  blocks: readonly Pick<Block, "role" | "text">[],
  start: number,
  end: number,
): number {
  for (let i = end - 1; i >= start; i--) {
    if (isEffortLineBlock(blocks[i])) return i;
  }
  return -1;
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
  return stoppedAtRange(blocks, 0, blocks.length);
}

function stoppedAtRange(
  blocks: readonly Pick<Block, "role" | "text">[],
  start: number,
  end: number,
): boolean {
  const line = lastEffortLine(blocks, start, end);
  if (line < 0) return false;
  for (let i = line + 1; i < end; i++) {
    if (blocks[i].role !== "reasoning") return false;
  }
  // Status notes may come first; work (tools, text) may not.
  const needed = parseEffortNeeded(blocks[line].text);
  for (let i = start; i < line; i++) {
    const block = blocks[i];
    if (
      block.role !== "reasoning" &&
      block.role !== "system" &&
      !(
        isEffortLineBlock(block) &&
        onlyEffortLines(block.text) &&
        parseEffortNeeded(block.text) === needed
      )
    ) {
      return false;
    }
  }
  return onlyEffortLines(blocks[line].text);
}

/**
 * True when the model went on after its line: more text below it, or any
 * work (text, tools) in a later block. The gate tells it to end on the line
 * when it asks for more, but it does not always listen.
 */
export function workedPastEffortLine(
  blocks: readonly Pick<Block, "role" | "text">[],
): boolean {
  return workedPastRange(blocks, 0, blocks.length);
}

function workedPastRange(
  blocks: readonly Pick<Block, "role" | "text">[],
  start: number,
  end: number,
): boolean {
  const line = lastEffortLine(blocks, start, end);
  if (line < 0) return false;
  if (continuedPastEffortLine(blocks[line].text)) return true;
  for (let i = line + 1; i < end; i++) {
    const role = blocks[i].role;
    if (role !== "reasoning" && role !== "system") return true;
  }
  return false;
}

/**
 * The raise a running turn asked for while it carried on working at the lower
 * level anyway. MonoCode stops that turn, raises, and sends it on, so the work
 * runs at the level the model said it needs.
 */
export function effortOverrunFor(session: Session): EffortChange | null {
  // Queued messages would be paused by the stop: let them run, the raise
  // still lands when the turn ends.
  if (!session.busy || session.queuedMessages?.length) {
    return null;
  }
  const start = turnStartIndex(session);
  const change = effortChangeFrom(session, start);
  if (change?.direction !== "raised") {
    return null;
  }
  return workedPastRange(session.blocks, start + 1, session.blocks.length)
    ? change
    : null;
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
  return (
    ranked.find((option) => option.rank >= want) ?? ranked[ranked.length - 1]!
  ).value;
}

/** The session's effort for a setting, falling back to the model's default. */
function currentEffort(
  session: Session,
  settingId: string,
): string | undefined {
  const model = findModel(session.model);
  const setting = model && modelEffortSetting(model);
  return (
    session.modelSettings[settingId] ??
    (setting?.id === settingId ? setting.value : undefined)
  );
}

function eligible(session: Session): boolean {
  return (
    !isMonoSession(session.id) && !session.ephemeral && !session.pendingSwitch
  );
}

/** What this session's finished turn asks to be switched to, if anything. */
export function effortChangeFor(session: Session): EffortChange | null {
  return effortChangeFrom(session, turnStartIndex(session));
}

function effortChangeFrom(session: Session, start: number): EffortChange | null {
  if (!eligible(session) || start < 0) {
    return null;
  }
  const needed = effortNeededFrom(
    session.blocks,
    start + 1,
    session.blocks.length,
  );
  const model = findModel(session.model);
  const setting = model && modelEffortSetting(model);
  if (!needed || !setting) {
    return null;
  }
  const current = session.modelSettings[setting.id] ?? setting.value;
  const chosen = optionFor(setting.options, needed);
  // Max stays a manual pick: the model's line switches to Extra High at most.
  const value = chosen && cappedAutoOption(setting.options, chosen, current);
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
  const blocks = session.blocks;
  const lineAt = lastEffortLine(blocks, start + 1, blocks.length);
  const line = lineAt >= 0 ? parseEffortLine(blocks[lineAt].text) : null;
  const model = findModel(session.model);
  const setting = model && modelEffortSetting(model);
  if (!line || !setting || !stoppedAtRange(blocks, start + 1, blocks.length)) {
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

const EFFORT_NOTE = /^Effort (raised|lowered) to [\w-]+ \(model asked\)$/;

/**
 * The send-on may land before the banner is decided: the last message is then
 * MonoCode's "Continue at <level> effort." with no reply to it yet.
 */
function justSentOn(session: Pick<Session, "blocks">): boolean {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.role === "user" && !block.draft) {
      return RESUME_TEXT.test(block.text.trim());
    }
    if (block.role !== "system" && block.role !== "reasoning") {
      return false;
    }
  }
  return false;
}

/**
 * True when a turn that just ended is only the model stopping on its effort
 * line for MonoCode to raise the effort and send the turn on. Nothing finished,
 * so it should not announce "Finished". Robust to the change note already being
 * in the transcript. False when nothing will be sent on: a send that was
 * itself a send-on and asked again without a change is a real stop.
 */
export function endedForEffortRaise(session: Session): boolean {
  const model = findModel(session.model);
  if (!eligible(session) || !model || !modelEffortSetting(model)) {
    return false;
  }
  if (justSentOn(session)) {
    return true;
  }
  // Queued messages hold the send-on back, so this is a real stop.
  if (session.queuedMessages?.length) {
    return false;
  }
  const start = turnStartIndex(session);
  if (start < 0) {
    return false;
  }
  const blocks = session.blocks;
  let end = blocks.length;
  while (
    end > start + 1 &&
    blocks[end - 1].role === "system" &&
    EFFORT_NOTE.test(blocks[end - 1].text)
  ) {
    end--;
  }
  const noted = end < blocks.length;
  const lineAt = lastEffortLine(blocks, start + 1, end);
  const line = lineAt >= 0 ? parseEffortLine(blocks[lineAt].text) : null;
  if (!line || !stoppedAtRange(blocks, start + 1, end)) {
    return false;
  }
  const now = EFFORT_RANK.indexOf(line.now);
  if (now < 0 || EFFORT_RANK.indexOf(line.needed) <= now) {
    return false;
  }
  return (
    noted ||
    effortChangeFrom(session, start) != null ||
    !RESUME_TEXT.test(blocks[start].text.trim())
  );
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

/** Turns MonoCode stopped because they ran past a raise, with that raise. */
const overrunStops = new Map<string, EffortChange>();

/** Called when MonoCode stops a turn that ran past its raise. */
export function noteEffortOverrunStop(sessionId: string, change: EffortChange) {
  overrunStops.set(sessionId, change);
}

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
    const overrun = idle.has(session.id)
      ? overrunStops.get(session.id)
      : undefined;
    if (overrun) {
      overrunStops.delete(session.id);
    }
    seen.set(session.id, turnId);
    if (!ended) {
      continue;
    }
    if (overrun && !stopped) {
      // MonoCode stopped this turn for its raise: raise (unless already
      // there) and send it on.
      const current = currentEffort(session, overrun.settingId);
      const queued = Boolean(session.queuedMessages?.length);
      if (current !== overrun.value) {
        changes.set(session.id, { ...overrun, resume: !queued });
      } else if (!queued) {
        stale?.set(session.id, overrun.value);
      }
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
  stop?: { current: (sessionId: string) => Promise<unknown> | null },
) {
  const wasBusy = useRef(new Set<string>());
  const seen = useRef(new Map<string, string>());
  const resumes = useRef(new Map<string, EffortChange>());
  /** The turn MonoCode last stopped per session, so it stops it only once. */
  const overrunTurns = useRef(new Map<string, string>());
  /** MonoCode's stops still cancelling the harness turn. */
  const stopping = useRef(new Map<string, Promise<unknown>>());
  const latest = useRef(sessions);
  latest.current = sessions;

  useEffect(() => {
    if (!FORK_EFFORT_ASK) {
      return;
    }
    /**
     * The session goes idle before its harness turn is cancelled, so a send
     * after MonoCode's own stop waits for that, or it could land in the turn
     * being torn down. A failed stop sends nothing.
     */
    const send = (session: Session, level: string) => {
      const pending = stopping.current.get(session.id);
      if (!pending) {
        sendOn(submit.current, session, level);
        return;
      }
      stopping.current.delete(session.id);
      const turnId = session.blocks[turnStartIndex(session)]?.id;
      void pending.then(
        () => {
          const now = latest.current.find((item) => item.id === session.id);
          // The user may have changed the effort or model meanwhile.
          const model = now && findModel(now.model);
          const setting = model && modelEffortSetting(model);
          const current =
            setting && (now.modelSettings[setting.id] ?? setting.value);
          if (
            now &&
            !now.busy &&
            !userStopped.delete(session.id) &&
            eligible(now) &&
            current === level &&
            // Not if the user started another turn meanwhile.
            now.blocks[turnStartIndex(now)]?.id === turnId
          ) {
            sendOn(submit.current, now, level);
          }
        },
        () => undefined,
      );
    };
    if (stop) {
      for (const session of sessions) {
        const change = effortOverrunFor(session);
        if (!change) {
          continue;
        }
        const turnId = session.blocks[turnStartIndex(session)]?.id ?? "";
        // A turn already read when it ended is not running again: busy also
        // flips for compaction, which must not be stopped.
        if (
          overrunTurns.current.get(session.id) === turnId ||
          seen.current.get(session.id) === turnId
        ) {
          continue;
        }
        overrunTurns.current.set(session.id, turnId);
        noteEffortOverrunStop(session.id, change);
        const stopped = stop.current(session.id);
        if (!stopped) {
          overrunStops.delete(session.id);
          continue;
        }
        stopping.current.set(session.id, stopped);
        // The app's Stop marks a user stop; this one is MonoCode's, so the
        // turn is still sent on. A later Stop by the user cancels that.
        userStopped.delete(session.id);
      }
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
      send(session, change.value);
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
        send(session, level);
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
  }, [sessions, setSessions, submit, stop]);
}
