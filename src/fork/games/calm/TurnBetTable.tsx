import { useEffect, useState } from "react";
import type { TableProps } from "../table/PokerTable";
import { ActionButton, Felt, TableFrame } from "../table/kit";
import {
  MAX_POINTS,
  TOLERANCE,
  firstGuess,
  formatDuration,
  minGuess,
  placeBet,
  stepGuess,
  useTurnBet,
  type Bet,
  type LiveTurn,
} from "./turnBet";

/** Fork: Turn Bet. Your running agent turns, and what you think each will take. */

export function TurnBetTable({ mode, active, onExit, onInput }: TableProps) {
  const { live, bets, record } = useTurnBet();
  const [now, setNow] = useState(() => Date.now());
  const [guesses, setGuesses] = useState<Record<string, number>>({});

  // A second hand for the running clocks, only while there is one to watch.
  useEffect(() => {
    if (!active || live.length === 0) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, live.length]);

  const betOn = (turn: LiveTurn) => bets.find((bet) => bet.sessionId === turn.sessionId);
  const guessFor = (turn: LiveTurn) => {
    const elapsed = now - turn.startedAt;
    return Math.max(minGuess(elapsed), guesses[turn.sessionId] ?? firstGuess(elapsed));
  };
  const nudge = (turn: LiveTurn, dir: 1 | -1) => {
    setGuesses((all) => ({
      ...all,
      [turn.sessionId]: stepGuess(guessFor(turn), dir, now - turn.startedAt),
    }));
  };
  const bet = (turn: LiveTurn) => {
    placeBet(turn.sessionId, guessFor(turn), mode, Date.now());
  };

  // Keys act on the first turn still open for a bet.
  const open = live.find((turn) => turn.knownStart && !betOn(turn));
  const onKey = (key: string) => {
    if (!open) {
      return;
    }
    if (key === "-" || key === "[") {
      nudge(open, -1);
    } else if (key === "=" || key === "+" || key === "]") {
      nudge(open, 1);
    } else if (key === "b" || key === " ") {
      bet(open);
    }
  };

  const average = record.bets ? Math.round(record.points / record.bets) : 0;

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Turn bet">
      <div className="relative flex h-full flex-col">
        <Felt className="inset-x-3 top-1 bottom-2" />

        <div className="relative z-10 flex shrink-0 items-baseline justify-center gap-3 pt-4 font-mono text-[11px] text-content/60">
          <span className="text-content/85">Turn bet</span>
          <span>within {TOLERANCE[mode]}x pays</span>
          <span>bet early, it pays more</span>
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 py-5">
          {live.length === 0 ? (
            <p data-turnbet-empty="" className="py-6 text-center font-mono text-[12px] leading-relaxed text-content/55">
              No agent is working right now.
              <br />
              Send a turn, then bet on how long it takes.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {live.map((turn) => (
                <TurnRow
                  key={turn.sessionId}
                  turn={turn}
                  bet={betOn(turn)}
                  elapsed={now - turn.startedAt}
                  guess={guessFor(turn)}
                  onNudge={(dir) => nudge(turn, dir)}
                  onBet={() => bet(turn)}
                />
              ))}
            </ul>
          )}

          {record.recent.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-content/40">Settled</h3>
              <ul className="flex flex-col gap-1">
                {record.recent.map((result) => (
                  <li
                    key={result.settledAt + result.title}
                    data-turnbet-result={result.points}
                    className="flex items-baseline gap-3 font-mono text-[11px] text-content/65"
                  >
                    <span className="min-w-0 flex-1 truncate">{result.title}</span>
                    <span className="text-content/40">
                      said {formatDuration(result.guessMs)} · took {formatDuration(result.actualMs)}
                    </span>
                    <span className={`w-14 text-right tabular-nums ${points(result.points)}`}>
                      {result.points >= MAX_POINTS * 0.9 ? "bullseye" : `+${result.points}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="relative z-10 flex h-[44px] shrink-0 items-center justify-center gap-4 font-mono text-[11px] text-content/55">
          <span>{record.bets} {record.bets === 1 ? "bet" : "bets"}</span>
          <span>avg {average}</span>
          <span>best {record.best}</span>
        </div>
      </div>
    </TableFrame>
  );
}

function points(value: number) {
  if (value >= MAX_POINTS * 0.9) {
    return "text-[#e69f00]";
  }
  return value > 0 ? "text-content/85" : "text-content/35";
}

function TurnRow({
  turn,
  bet,
  elapsed,
  guess,
  onNudge,
  onBet,
}: {
  turn: LiveTurn;
  bet: Bet | undefined;
  elapsed: number;
  guess: number;
  onNudge: (dir: 1 | -1) => void;
  onBet: () => void;
}) {
  // How the running clock stands against the guess, for the bar under a bet.
  const share = bet ? Math.min(1, elapsed / bet.guessMs) : 0;
  return (
    <li
      data-turnbet-turn={turn.sessionId}
      data-turnbet-bet={bet ? bet.guessMs : undefined}
      className="flex flex-col gap-2 rounded-md bg-content/[0.06] px-3 py-2.5"
    >
      <div className="flex items-baseline gap-3 font-mono text-[12px]">
        <span className="min-w-0 flex-1 truncate text-content/85">{turn.title}</span>
        <span className="tabular-nums text-content/60">{formatDuration(elapsed)}</span>
      </div>
      {!turn.knownStart ? (
        <span className="font-mono text-[11px] text-content/40">started before MonoCode saw it · next turn</span>
      ) : bet ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] text-content/60">
            you said {formatDuration(bet.guessMs)}
            {elapsed > bet.guessMs ? ` · over by ${formatDuration(elapsed - bet.guessMs)}` : ""}
          </span>
          <div className="h-1 overflow-hidden rounded-full bg-content/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${share * 100}%`,
                background: elapsed > bet.guessMs ? "#d55e00" : "#56b4e9",
                transition: "width 900ms linear",
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <ActionButton label="−" keyHint="-" data-action="less" onClick={() => onNudge(-1)} />
          <span data-turnbet-guess={guess} className="w-20 text-center font-mono text-[13px] tabular-nums text-content">
            {formatDuration(guess)}
          </span>
          <ActionButton label="+" keyHint="=" data-action="more" onClick={() => onNudge(1)} />
          <ActionButton primary label="Bet" keyHint="B" data-action="bet" onClick={onBet} />
        </div>
      )}
    </li>
  );
}
