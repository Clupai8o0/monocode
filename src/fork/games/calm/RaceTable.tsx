import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { TableProps } from "../table/PokerTable";
import { AGENTS } from "../table/agents";
import { ActionButton, Avatar, Felt, TableFrame, reducedMotion } from "../table/kit";
import {
  accuracy,
  applyKey,
  elapsed,
  isDone,
  newRace,
  ordinal,
  place,
  progress,
  rawWpm,
  rivalProgress,
  setPaused,
  standings,
  wpm,
  type RaceState,
} from "./typeRace";

/** Fork: type race. Type the words before three agents type them too. */

const BEST_KEY = "monocode.fork.games.race.best";
const LINE = 28;

type Best = Partial<Record<TableProps["mode"], number>>;

function readBest(): Best {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Best;
  } catch {
    return {};
  }
}

/** A race remembers its own mode, so its speed is filed under it even after the chip changes. */
type Race = RaceState & { mode: TableProps["mode"] };

function fresh(mode: TableProps["mode"], runId: number): Race {
  return { ...newRace(runId * 7919 + (Date.now() % 1_000_003), mode), mode };
}

type Action =
  | { type: "key"; key: string; now: number }
  | { type: "pause"; paused: boolean; now: number }
  | { type: "reset"; state: Race };

function reduce(state: Race, action: Action): Race {
  if (action.type === "reset") {
    return action.state;
  }
  if (action.type === "pause") {
    return { ...setPaused(state, action.paused, action.now), mode: state.mode };
  }
  return { ...applyKey(state, action.key, action.now), mode: state.mode };
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One lane: a name, a faint track and a runner on it. */
function Lane({ label, at, color, children }: { label: string; at: number; color?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 truncate text-right font-mono text-[11px] text-content/60" style={{ color }}>
        {label}
      </span>
      <div className="relative h-6 flex-1 rounded-sm bg-content/[0.06]">
        <div
          className="race-runner absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
          style={{ left: `calc(10px + (100% - 20px) * ${at})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Each letter of a word, coloured by what was typed over it. */
function Word({ word, typed, current, passed }: { word: string; typed: string | undefined; current: boolean; passed: boolean }) {
  const wrong = passed && typed !== word;
  const extra = typed && typed.length > word.length ? typed.slice(word.length) : "";
  return (
    <span
      data-race-w=""
      data-race-word={current ? "current" : undefined}
      className={`relative mr-[1ch] inline-block ${wrong ? "underline decoration-red-400/70 underline-offset-4" : ""}`}
    >
      {[...word].map((char, at) => {
        const got = typed?.[at];
        const cls = got === undefined ? "text-content/30" : got === char ? "text-content" : "text-red-400";
        return (
          <span key={at} className={`relative ${cls}`}>
            {current && at === (typed?.length ?? 0) ? <Caret /> : null}
            {char}
          </span>
        );
      })}
      {extra ? <span className="text-red-400/70">{extra}</span> : null}
      {current && (typed?.length ?? 0) >= word.length ? (
        <span className="relative">
          <Caret />
        </span>
      ) : null}
    </span>
  );
}

function Caret() {
  return <span className="race-caret absolute -left-px top-[3px] bottom-[3px] w-[2px] rounded-full bg-amber-300" />;
}

export function RaceTable({ mode, runId, active, onExit, onInput }: TableProps) {
  const [state, dispatch] = useReducer(reduce, undefined, () => fresh(mode, runId));
  const [now, setNow] = useState(() => Date.now());
  const [best, setBest] = useState(() => readBest()[mode] ?? 0);
  const [scroll, setScroll] = useState(0);
  const saved = useRef(false);
  const text = useRef<HTMLDivElement>(null);

  const done = isDone(state);
  const running = state.startedAt !== null && !done && state.pausedAt === null;

  const restart = () => {
    saved.current = false;
    dispatch({ type: "reset", state: fresh(mode, runId) });
    setBest(readBest()[mode] ?? 0);
  };

  // A new run or mode starts a new race.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, runId]);

  // The agents move on a short tick while the race runs.
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  // Hidden, paused or switched away: the clock stops, and the agents with it.
  useEffect(() => {
    const at = Date.now();
    dispatch({ type: "pause", paused: !active, now: at });
    setNow(at);
  }, [active]);

  const raced = elapsed(state, now);
  const speed = wpm(state, now);
  const acc = accuracy(state);

  useEffect(() => {
    if (!done || saved.current) {
      return;
    }
    saved.current = true;
    const previous = readBest()[state.mode] ?? 0;
    if (speed > previous) {
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify({ ...readBest(), [state.mode]: speed }));
      } catch {
        // A full or blocked store only forgets the best.
      }
    }
  }, [done, speed, state.mode]);

  // Keep the current word on the second line once it's past the first.
  useLayoutEffect(() => {
    const word = text.current?.querySelector<HTMLElement>("[data-race-word='current']");
    if (!word) {
      return;
    }
    setScroll(Math.max(0, word.offsetTop - LINE));
  }, [state.index, state.words]);

  const onKey = (key: string) => {
    if (done) {
      if (key === "Enter" || key === " ") {
        restart();
      }
      return;
    }
    if (key === "Enter") {
      return;
    }
    const at = Date.now();
    setNow(at);
    dispatch({ type: "key", key, now: at });
  };

  const order = done ? standings(state, now) : [];
  const yourPlace = done ? place(state, now) : 0;
  const shownBest = Math.max(best, done ? speed : 0);
  const motion = !reducedMotion();

  return (
    <TableFrame typing active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Type race">
      <div
        data-race-word-index={state.index}
        data-race-done={done ? "" : undefined}
        data-race-wpm={speed}
        data-race-place={done ? yourPlace : undefined}
        className="relative flex h-full flex-col"
      >
        <Felt className="inset-x-3 top-1 bottom-[52px]" />
        <style>
          {"@keyframes race-blink{50%{opacity:0}}.race-caret{animation:race-blink 1s steps(1) infinite}" +
            (motion ? ".race-runner{transition:left 110ms linear}" : "")}
        </style>

        <div className="relative z-10 flex shrink-0 items-baseline justify-center gap-4 pt-4 font-mono text-[11px] text-content/60">
          <span className="text-content/85">{speed} wpm</span>
          <span>{acc}%</span>
          <span>{seconds(raced)}</span>
          <span>
            {Math.min(state.index, state.words.length)}/{state.words.length}
          </span>
        </div>

        <div className="relative z-10 flex flex-col gap-1.5 px-8 pt-4">
          <Lane label="you" at={progress(state)}>
            <span className="h-3.5 w-3.5 rounded-[3px] bg-amber-300" />
          </Lane>
          {state.rivals.map((rival) => (
            <Lane key={rival.id} label={AGENTS[rival.id].name} color={AGENTS[rival.id].color} at={rivalProgress(rival, state, raced)}>
              <Avatar id={rival.id} scale={2} lively={running} />
            </Lane>
          ))}
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-8">
          {done ? (
            <div data-race-result="" className="flex flex-col items-center gap-2 font-mono">
              <div className="text-[28px] leading-none text-content">{ordinal(yourPlace)}</div>
              <div className="mt-1 flex gap-5 text-[12px] text-content/80">
                <span>{speed} wpm</span>
                <span>{rawWpm(state, now)} raw</span>
                <span>{acc}% accurate</span>
                <span>{seconds(raced)}</span>
              </div>
              <div className="mt-1 flex gap-4 text-[11px] text-content/50">
                {order.map((entry, at) => (
                  <span key={entry.id} style={entry.id === "you" ? undefined : { color: AGENTS[entry.id].color }}>
                    {at + 1}. {entry.id === "you" ? "you" : AGENTS[entry.id].name}
                  </span>
                ))}
              </div>
              <div className="text-[11px] text-content/45">best {shownBest} wpm</div>
            </div>
          ) : (
            <div className="w-full max-w-[560px] overflow-hidden" style={{ height: LINE * 3 }}>
              <div
                ref={text}
                className="relative font-mono text-[18px]"
                style={{
                  lineHeight: `${LINE}px`,
                  transform: `translateY(${-scroll}px)`,
                  transition: motion ? "transform 160ms cubic-bezier(0.23, 1, 0.32, 1)" : undefined,
                }}
              >
                {state.words.map((word, at) => (
                  <Word
                    key={at}
                    word={word}
                    current={at === state.index}
                    passed={at < state.index}
                    typed={at < state.index ? state.done[at] : at === state.index ? state.typed : undefined}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="relative z-10 flex h-[52px] shrink-0 items-center justify-center gap-2">
          {done ? (
            <ActionButton primary label="Race again" keyHint="Enter" data-action="again" onClick={restart} />
          ) : state.startedAt === null ? (
            <span className="font-mono text-[11px] text-content/40">start typing · the agents go when you do</span>
          ) : (
            <ActionButton label="Restart" data-action="restart" onClick={restart} />
          )}
        </div>
      </div>
    </TableFrame>
  );
}
