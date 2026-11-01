import { seeded } from "../seeded";
import { AGENT_IDS, type AgentId } from "../table/agents";

/** Fork: type race. Type a run of words against three agents. Pure model, no React. */

export type Mode = "low" | "mid" | "hard";

export type Rival = {
  id: AgentId;
  /** Words per minute the agent holds on average. */
  wpm: number;
  /** Where its speed wobble starts, so the three don't move in step. */
  phase: number;
};

export type RaceState = {
  words: readonly string[];
  rivals: readonly Rival[];
  /** The word being typed. */
  index: number;
  typed: string;
  /** What was typed for each word already passed. */
  done: readonly string[];
  /** Set by the first key, so the agents wait for you at the line. */
  startedAt: number | null;
  endedAt: number | null;
  pausedMs: number;
  pausedAt: number | null;
  strokes: number;
  correctStrokes: number;
};

export const WORD_COUNT: Record<Mode, number> = { low: 20, mid: 30, hard: 40 };

/** Each mode's three agent speeds, handed out at random. */
const PACE: Record<Mode, readonly [number, number, number]> = {
  low: [28, 36, 44],
  mid: [48, 60, 72],
  hard: [72, 88, 104],
};

const SHORT = [
  "the", "and", "for", "you", "run", "fix", "log", "map", "set", "get", "add", "key", "row", "bug", "try",
  "new", "old", "use", "end", "out", "app", "box", "tab", "dev", "api", "git", "cat", "pin", "tag", "net",
  "code", "test", "file", "line", "loop", "push", "pull", "diff", "main", "node", "data", "type", "list",
  "path", "port", "task", "plan", "ship", "note", "read", "save", "send", "open", "load", "wait", "turn",
  "word", "fast", "slow", "time", "kind", "work", "help", "next", "last", "done", "back", "make", "keep",
];

const LONG = [
  "branch", "commit", "review", "merge", "build", "deploy", "agent", "token", "prompt", "model", "patch",
  "server", "client", "cache", "query", "index", "worker", "thread", "stream", "buffer", "module", "import",
  "export", "return", "result", "string", "number", "object", "method", "signal", "socket", "schema",
  "router", "layout", "render", "screen", "window", "folder", "editor", "cursor", "syntax", "rebase",
  "release", "version", "refactor", "function", "variable", "terminal", "workflow", "pipeline", "settings",
  "keyboard", "compiler", "debugger", "snapshot", "migration", "checklist", "handover", "question", "practice",
];

const MARKS = [",", ".", ";", ":", "?", "!"];

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)]!;
}

function makeWords(mode: Mode, random: () => number): string[] {
  const words: string[] = [];
  while (words.length < WORD_COUNT[mode]) {
    const long = mode === "low" ? random() < 0.15 : random() < (mode === "mid" ? 0.45 : 0.6);
    let word = pick(long ? LONG : SHORT, random);
    if (words[words.length - 1] === word) {
      continue;
    }
    if (mode === "hard") {
      const roll = random();
      if (roll < 0.12) {
        word = String(Math.floor(random() * 990) + 10);
      } else if (roll < 0.28) {
        word = word[0]!.toUpperCase() + word.slice(1);
      } else if (roll < 0.46) {
        word += pick(MARKS, random);
      }
    }
    words.push(word);
  }
  return words;
}

function makeRivals(mode: Mode, random: () => number): Rival[] {
  const ids = [...AGENT_IDS];
  const speeds = [...PACE[mode]];
  const rivals: Rival[] = [];
  while (rivals.length < 3) {
    const id = ids.splice(Math.floor(random() * ids.length), 1)[0]!;
    const speed = speeds.splice(Math.floor(random() * speeds.length), 1)[0]!;
    rivals.push({ id, wpm: speed + Math.round(random() * 6 - 3), phase: random() * Math.PI * 2 });
  }
  return rivals;
}

export function newRace(seed: number, mode: Mode): RaceState {
  const random = seeded(seed);
  return {
    words: makeWords(mode, random),
    rivals: makeRivals(mode, random),
    index: 0,
    typed: "",
    done: [],
    startedAt: null,
    endedAt: null,
    pausedMs: 0,
    pausedAt: null,
    strokes: 0,
    correctStrokes: 0,
  };
}

/** Characters in the whole run, a space between words included. */
export function totalChars(state: Pick<RaceState, "words">) {
  return state.words.join(" ").length;
}

export function isDone(state: RaceState) {
  return state.endedAt !== null;
}

/** Racing time so far, leaving out pauses. */
export function elapsed(state: RaceState, now: number) {
  if (state.startedAt === null) {
    return 0;
  }
  const end = state.endedAt ?? now;
  const paused = state.pausedMs + (state.pausedAt === null ? 0 : Math.max(0, end - state.pausedAt));
  return Math.max(0, end - state.startedAt - paused);
}

/** Stops or restarts the clock; only a started, unfinished race has one. */
export function setPaused(state: RaceState, paused: boolean, now: number): RaceState {
  if (state.startedAt === null || isDone(state)) {
    return state;
  }
  if (paused) {
    return state.pausedAt === null ? { ...state, pausedAt: now } : state;
  }
  if (state.pausedAt === null) {
    return state;
  }
  return { ...state, pausedMs: state.pausedMs + Math.max(0, now - state.pausedAt), pausedAt: null };
}

function finish(state: RaceState, now: number): RaceState {
  return { ...state, endedAt: now };
}

/** One key: a character, " " to move on, or "Backspace". */
export function applyKey(input: RaceState, key: string, now: number): RaceState {
  if (isDone(input)) {
    return input;
  }
  // A key means play is back on, whatever the pause said.
  const state = setPaused(input, false, now);
  const word = state.words[state.index] ?? "";
  if (key === "Backspace") {
    if (state.typed.length > 0) {
      return { ...state, typed: state.typed.slice(0, -1) };
    }
    // Back into the word before, but only to fix it: a right word stays put.
    const before = state.done[state.index - 1];
    if (before === undefined || before === state.words[state.index - 1]) {
      return state;
    }
    return { ...state, index: state.index - 1, typed: before, done: state.done.slice(0, -1) };
  }
  if (key === " ") {
    if (state.typed.length === 0) {
      return state;
    }
    const right = state.typed === word;
    const next: RaceState = {
      ...state,
      index: state.index + 1,
      typed: "",
      done: [...state.done, state.typed],
      strokes: state.strokes + 1,
      correctStrokes: state.correctStrokes + (right ? 1 : 0),
    };
    return next.index >= state.words.length ? finish(next, now) : next;
  }
  if (key.length !== 1 || state.typed.length >= word.length + 8) {
    return state;
  }
  const typed = state.typed + key;
  const right = key === word[state.typed.length];
  const next: RaceState = {
    ...state,
    typed,
    startedAt: state.startedAt ?? now,
    strokes: state.strokes + 1,
    correctStrokes: state.correctStrokes + (right ? 1 : 0),
  };
  // The last word ends the race as soon as it's right, no space needed.
  if (state.index === state.words.length - 1 && typed === word) {
    return finish({ ...next, index: state.index + 1, typed: "", done: [...state.done, typed] }, now);
  }
  return next;
}

/** Characters you've got right so far: right words, the spaces after them, and a right start on this one. */
export function correctChars(state: RaceState) {
  let count = 0;
  state.done.forEach((typed, at) => {
    if (typed === state.words[at]) {
      count += typed.length + (at < state.words.length - 1 ? 1 : 0);
    }
  });
  const word = state.words[state.index] ?? "";
  if (word.startsWith(state.typed)) {
    count += state.typed.length;
  }
  return count;
}

/** Your place on the track, 0 to 1. Wrong words still move you on, since they're passed. */
export function progress(state: RaceState) {
  if (isDone(state)) {
    return 1;
  }
  const passed = state.words.slice(0, state.index).join(" ").length + (state.index > 0 ? 1 : 0);
  const word = state.words[state.index] ?? "";
  const along = word.startsWith(state.typed) ? state.typed.length : 0;
  return Math.min(1, (passed + along) / totalChars(state));
}

/** The clock never reads under a second, so the first key can't spike a speed. */
function minutes(ms: number) {
  return Math.max(ms, 1000) / 60_000;
}

export function wpm(state: RaceState, now: number) {
  if (state.startedAt === null) {
    return 0;
  }
  return Math.round(correctChars(state) / 5 / minutes(elapsed(state, now)));
}

/** Every key, right or wrong, as words per minute. */
export function rawWpm(state: RaceState, now: number) {
  if (state.startedAt === null) {
    return 0;
  }
  return Math.round(state.strokes / 5 / minutes(elapsed(state, now)));
}

export function accuracy(state: RaceState) {
  return state.strokes === 0 ? 100 : Math.round((state.correctStrokes / state.strokes) * 100);
}

/**
 * How far an agent has typed after `ms` of racing. Its pace wobbles a little,
 * but never backwards: the wobble's slope stays under the base speed.
 */
export function rivalChars(rival: Rival, ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  const perSecond = (rival.wpm * 5) / 60;
  const wobble = 1.2 * (Math.sin(seconds / 2 + rival.phase) - Math.sin(rival.phase));
  return Math.max(0, perSecond * (seconds + wobble));
}

export function rivalProgress(rival: Rival, state: RaceState, ms: number) {
  return Math.min(1, rivalChars(rival, ms) / totalChars(state));
}

/** When an agent crosses the line, in racing ms. */
export function rivalFinishMs(rival: Rival, state: RaceState) {
  const total = totalChars(state);
  let low = 0;
  let high = 1000;
  while (rivalChars(rival, high) < total) {
    high *= 2;
  }
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (rivalChars(rival, mid) < total) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high;
}

export type Placing = { id: AgentId | "you"; ms: number };

/** Finishing order once you're over the line. Agents still out there finish later, so they rank by when they will. */
export function standings(state: RaceState, now: number): Placing[] {
  const you: Placing = { id: "you", ms: elapsed(state, now) };
  const rivals = state.rivals.map((rival) => ({ id: rival.id, ms: rivalFinishMs(rival, state) }));
  // A tie goes to you.
  return [you, ...rivals].sort((a, b) => a.ms - b.ms || (a.id === "you" ? -1 : b.id === "you" ? 1 : 0));
}

export function place(state: RaceState, now: number) {
  return standings(state, now).findIndex((entry) => entry.id === "you") + 1;
}

export function ordinal(n: number) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}
