import { useEffect, useReducer, useRef, useState } from "react";
import type { TableProps } from "../table/PokerTable";
import { ActionButton, Felt, TableFrame, reducedMotion } from "../table/kit";
import {
  RULE_LABEL,
  ROUND_SIZE,
  accuracy,
  applyKey,
  currentTarget,
  isDone,
  makeRound,
  newState,
  score,
  setPaused,
  wpm,
  type MergeState,
} from "./mergeConflict";

/** Fork: merge conflict, a typing race. Resolve five conflicts by typing the result. */

const BEST_KEY = "monocode.fork.games.merge.best";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

type Best = Partial<Record<TableProps["mode"], number>>;

function readBest(): Best {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Best;
  } catch {
    return {};
  }
}

/** A round remembers its own mode, so its score is filed under it even after the chip changes. */
type Round = MergeState & { mode: TableProps["mode"] };

function fresh(mode: TableProps["mode"], runId: number): Round {
  return { ...newState(makeRound(runId * 7919 + (Date.now() % 1_000_003), mode)), mode };
}

type Action =
  | { type: "key"; key: string; now: number }
  | { type: "pause"; paused: boolean; now: number }
  | { type: "reset"; state: Round };

function reduce(state: Round, action: Action): Round {
  if (action.type === "reset") {
    return action.state;
  }
  if (action.type === "pause") {
    return { ...setPaused(state, action.paused, action.now), mode: state.mode };
  }
  return { ...applyKey(state, action.key, action.now), mode: state.mode };
}

/** The target faintly, with what was typed laid over it. */
function Typing({ target, typed }: { target: string; typed: string }) {
  const lines = target.split("\n");
  let offset = 0;
  return (
    <div className="whitespace-pre font-mono text-[12px] leading-5">
      {lines.map((line, row) => {
        const start = offset;
        offset += line.length + 1;
        const cells = [...line].map((char, col) => {
          const at = start + col;
          const got = typed[at];
          const cls = got === undefined ? "text-content/30" : got === char ? "text-content" : "text-red-400";
          return (
            <span key={col} className={cls}>
              {char}
              {at === typed.length ? <span className="merge-caret -ml-[1ch] inline-block w-0 border-l border-content/80" /> : null}
            </span>
          );
        });
        // The caret can also sit at a line end, which has no character of its own.
        const end = start + line.length;
        const atEnd = typed.length === end;
        const over = row === lines.length - 1 ? typed.slice(target.length) : "";
        return (
          <div key={row} className="min-h-5">
            {cells}
            {atEnd ? <span className="merge-caret inline-block w-0 border-l border-content/80" /> : null}
            {over ? <span className="text-red-400">{over}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function MergeTable({ mode, runId, active, onExit, onInput }: TableProps) {
  const [state, dispatch] = useReducer(reduce, undefined, () => fresh(mode, runId));
  const [now, setNow] = useState(() => Date.now());
  const [best, setBest] = useState(() => readBest()[mode] ?? 0);
  const saved = useRef(false);
  const slide = useRef<HTMLDivElement>(null);

  const done = isDone(state);
  const running = state.startedAt !== null && !done;

  const restart = () => {
    saved.current = false;
    dispatch({ type: "reset", state: fresh(mode, runId) });
    setBest(readBest()[mode] ?? 0);
  };

  // A new run or mode starts a new round.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, runId]);

  // Tick for the live WPM only while the clock is running.
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, [running]);

  // Hidden, paused or switched away: the clock stops with the input.
  useEffect(() => {
    const at = Date.now();
    dispatch({ type: "pause", paused: !active, now: at });
    setNow(at);
  }, [active]);

  const finalWpm = wpm(state, now);
  const acc = accuracy(state);
  const total = score(finalWpm, acc);

  useEffect(() => {
    if (!done || saved.current) {
      return;
    }
    saved.current = true;
    const previous = readBest()[state.mode] ?? 0;
    if (total > previous) {
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify({ ...readBest(), [state.mode]: total }));
      } catch {
        // A full or blocked store only forgets the best.
      }
      if (state.mode === mode) {
        setBest(total);
      }
    }
  }, [done, mode, state.mode, total]);

  // Each new conflict slides in.
  useEffect(() => {
    const el = slide.current;
    if (!el || reducedMotion() || done) {
      return;
    }
    const motion = el.animate(
      [{ transform: "translateX(18px)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 240, easing: EASE_OUT },
    );
    return () => motion.cancel();
  }, [state.index, done]);

  const onKey = (key: string) => {
    if (done) {
      if (key === "Enter" || key === " ") {
        restart();
      }
      return;
    }
    const at = Date.now();
    setNow(at);
    dispatch({ type: "key", key, now: at });
  };

  const conflict = state.conflicts[state.index];
  const target = currentTarget(state);
  const shownBest = Math.max(best, done ? total : 0);

  return (
    <TableFrame typing active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Merge conflict">
      <div
        data-merge-conflict={Math.min(state.index, ROUND_SIZE)}
        data-merge-done={done ? "" : undefined}
        data-merge-wpm={finalWpm}
        className="relative flex h-full flex-col"
      >
        <Felt className="inset-x-3 top-1 bottom-[52px]" />
        <style>{"@keyframes merge-blink{50%{opacity:0}}.merge-caret{animation:merge-blink 1s steps(1) infinite}"}</style>

        <div className="relative z-10 flex shrink-0 items-baseline justify-center gap-4 pt-4 font-mono text-[11px] text-content/60">
          <span className="text-content/85">{finalWpm} wpm</span>
          <span>{acc}%</span>
          <span>conflict {Math.min(state.index + 1, ROUND_SIZE)}/{state.conflicts.length}</span>
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6">
          {done ? (
            <div className="flex flex-col items-center gap-2 font-mono">
              <div className="text-[28px] leading-none text-content">{total}</div>
              <div className="text-[11px] text-content/60">score</div>
              <div className="mt-2 flex gap-5 text-[12px] text-content/80">
                <span>{finalWpm} wpm</span>
                <span>{acc}% accurate</span>
              </div>
              <div className="text-[11px] text-content/45">best {shownBest}</div>
            </div>
          ) : conflict ? (
            <div ref={slide} className="flex w-full max-w-[460px] flex-col gap-4">
              <div className="rounded-sm bg-content/[0.07] px-3 py-2 font-mono text-[12px] leading-5">
                <div className="text-amber-600">{"<<<<<<< ours"}</div>
                <div className="whitespace-pre text-content/85">{conflict.ours}</div>
                <div className="text-content/40">{"======="}</div>
                <div className="whitespace-pre text-content/85">{conflict.theirs}</div>
                <div className="text-sky-600">{">>>>>>> theirs"}</div>
              </div>
              <div className="flex flex-col gap-2 px-1">
                <span className="w-fit rounded-sm bg-content/15 px-2 py-0.5 font-mono text-[11px] text-content/90">
                  {RULE_LABEL[conflict.rule]}
                </span>
                <Typing target={target} typed={state.typed} />
              </div>
            </div>
          ) : null}
        </div>

        <div className="relative z-10 flex h-[52px] shrink-0 items-center justify-center gap-2">
          {done ? (
            <ActionButton primary label="Again" keyHint="Enter" data-action="again" onClick={restart} />
          ) : (
            <span className="font-mono text-[11px] text-content/40">type the resolution · backspace fixes</span>
          )}
        </div>
      </div>
    </TableFrame>
  );
}
