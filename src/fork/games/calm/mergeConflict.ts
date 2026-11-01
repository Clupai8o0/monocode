import { seeded } from "../seeded";

/** Fork: merge conflict, a typing race. Pure model, no React. */

export type Mode = "low" | "mid" | "hard";
export type Rule = "ours" | "theirs" | "both";

export type Conflict = { ours: string; theirs: string; rule: Rule };

export type MergeState = {
  conflicts: readonly Conflict[];
  index: number;
  typed: string;
  /** Set by the first key, so thinking time before it is free. */
  startedAt: number | null;
  endedAt: number | null;
  /** Characters that landed on the right spot, kept across conflicts. */
  correctChars: number;
  strokes: number;
  correctStrokes: number;
};

export const ROUND_SIZE = 5;

export const RULE_LABEL: Record<Rule, string> = {
  ours: "keep ours",
  theirs: "keep theirs",
  both: "keep both",
};

/** Plausible variants of one line, ours first. */
const BANK: readonly (readonly [string, string])[] = [
  ["const timeout = 30_000;", "const timeout = config.timeout ?? 30_000;"],
  ["let retries = 3;", "let retries = opts.retries;"],
  ["return items.length;", "return items.filter(Boolean).length;"],
  ["if (!user) return;", "if (user == null) return null;"],
  ["export const MAX = 10;", "export const MAX = 25;"],
  ["console.log(value);", "logger.debug(value);"],
  ["await save(doc);", "await save(doc, { force: true });"],
  ["const id = uuid();", "const id = crypto.randomUUID();"],
  ["for (const x of xs) {", "for (const [i, x] of xs.entries()) {"],
  ["import fs from 'fs';", "import fs from 'node:fs';"],
  ["def load(path):", "def load(path: str) -> dict:"],
  ["retries = 3", "retries = settings.RETRIES"],
  ["print(result)", "logging.info(result)"],
  ["if x is None:", "if not x:"],
  ["return sorted(rows)", "return sorted(rows, key=len)"],
  ["let mut total = 0;", "let mut total: u64 = 0;"],
  ["fn run() -> i32 {", "fn run() -> Result<i32, Error> {"],
  ["let n = v.len();", "let n = v.iter().count();"],
  ["x.unwrap()", "x.expect(\"missing\")"],
  ["use std::fs;", "use std::{fs, io};"],
  ["func Run() error {", "func Run(ctx context.Context) error {"],
  ["port := 8080", "port := os.Getenv(\"PORT\")"],
  ["if err != nil {", "if err != nil && !done {"],
  ["return nil", "return fmt.Errorf(\"skip\")"],
  ["var wg sync.WaitGroup", "wg := &sync.WaitGroup{}"],
  ["const name = 'app';", "const name = \"monocode\";"],
  ["items.push(item);", "items.unshift(item);"],
  ["const ok = a === b;", "const ok = Object.is(a, b);"],
  ["setOpen(!open);", "setOpen((prev) => !prev);"],
  ["throw new Error('bad');", "throw new TypeError('bad input');"],
  ["const data = await res.json();", "const data = (await res.json()) as Reply;"],
  ["export default function App() {", "export function App({ title }: Props) {"],
  ["const [count, setCount] = useState(0);", "const [count, setCount] = useState<number>(init);"],
  ["const sum = nums.reduce((a, b) => a + b, 0);", "const sum = nums.reduce((acc, n) => acc + n, 0);"],
  ["with open(path) as f:", "with open(path, encoding=\"utf-8\") as f:"],
  ["let users: Vec<User> = Vec::new();", "let users = db.fetch_all::<User>().await?;"],
  ["res, err := http.Get(url)", "res, err := client.Do(req.WithContext(ctx))"],
  ["const result = items.map((item) => item.id);", "const result = items.flatMap((item) => item.children ?? []);"],
  ["if (process.env.NODE_ENV === 'production') {", "if (import.meta.env.MODE === \"production\" && !debug) {"],
  ["for i, row in enumerate(rows):", "for i, row in enumerate(rows, start=1):"],
  ["let handle = thread::spawn(move || work(n));", "let handle = tokio::spawn(async move { work(n).await });"],
];

const LIMIT: Record<Mode, number> = { low: 30, mid: 46, hard: 200 };

function rule(mode: Mode, random: () => number): Rule {
  if (mode === "low") {
    return random() < 0.5 ? "ours" : "theirs";
  }
  const both = mode === "mid" ? 0.34 : 0.55;
  if (random() < both) {
    return "both";
  }
  return random() < 0.5 ? "ours" : "theirs";
}

export function makeRound(seed: number, mode: Mode): Conflict[] {
  const random = seeded(seed);
  // Hard leans on the long lines, the others stay under their cap.
  const pool = BANK.filter(([a, b]) =>
    mode === "hard" ? Math.max(a.length, b.length) >= 24 : Math.max(a.length, b.length) <= LIMIT[mode],
  );
  const picks = [...pool];
  const round: Conflict[] = [];
  while (round.length < ROUND_SIZE && picks.length > 0) {
    const [ours, theirs] = picks.splice(Math.floor(random() * picks.length), 1)[0]!;
    round.push({ ours, theirs, rule: rule(mode, random) });
  }
  return round;
}

export function targetText(conflict: Conflict) {
  if (conflict.rule === "ours") {
    return conflict.ours;
  }
  if (conflict.rule === "theirs") {
    return conflict.theirs;
  }
  return `${conflict.ours}\n${conflict.theirs}`;
}

export function newState(conflicts: readonly Conflict[]): MergeState {
  return {
    conflicts,
    index: 0,
    typed: "",
    startedAt: null,
    endedAt: null,
    correctChars: 0,
    strokes: 0,
    correctStrokes: 0,
  };
}

export function isDone(state: MergeState) {
  return state.index >= state.conflicts.length;
}

export function currentTarget(state: MergeState) {
  const conflict = state.conflicts[state.index];
  return conflict ? targetText(conflict) : "";
}

/** One key: a character, "Enter" for a newline, or "Backspace". */
export function applyKey(state: MergeState, key: string, now: number): MergeState {
  if (isDone(state)) {
    return state;
  }
  const target = currentTarget(state);
  if (key === "Backspace") {
    // Deleting a right char takes it off the score so retyping isn't free.
    const last = state.typed.length - 1;
    if (last < 0) {
      return state;
    }
    const wasRight = state.typed[last] === target[last];
    return { ...state, typed: state.typed.slice(0, last), correctChars: state.correctChars - (wasRight ? 1 : 0) };
  }
  const char = key === "Enter" ? "\n" : key;
  if (char.length !== 1 || state.typed.length >= target.length + 6) {
    return state;
  }
  const right = char === target[state.typed.length];
  const typed = state.typed + char;
  const next: MergeState = {
    ...state,
    typed,
    startedAt: state.startedAt ?? now,
    strokes: state.strokes + 1,
    correctStrokes: state.correctStrokes + (right ? 1 : 0),
    correctChars: state.correctChars + (right ? 1 : 0),
  };
  if (typed !== target) {
    return next;
  }
  const index = state.index + 1;
  return { ...next, index, typed: "", endedAt: index >= state.conflicts.length ? now : null };
}

/** Correct characters per five per minute, with a floor on the clock so the first key can't spike it. */
export function wpm(state: MergeState, now: number) {
  if (state.startedAt === null) {
    return 0;
  }
  const end = state.endedAt ?? now;
  const minutes = Math.max(end - state.startedAt, 1000) / 60_000;
  return Math.round(Math.max(state.correctChars, 0) / 5 / minutes);
}

export function accuracy(state: MergeState) {
  return state.strokes === 0 ? 100 : Math.round((state.correctStrokes / state.strokes) * 100);
}

export function score(wpmValue: number, accuracyValue: number) {
  return Math.round((wpmValue * accuracyValue) / 100);
}
