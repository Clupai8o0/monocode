import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENTS,
  POKER_STAKES,
  defaultSeats,
  fillSeats,
  type AgentId,
  type TableMode,
} from "./agents";
import {
  ActionButton,
  Avatar,
  Bubble,
  CardSlot,
  Coin,
  Felt,
  PixelCard,
  QuotaBump,
  SeatPicker,
  ShoeContext,
  Sprite,
  TableFrame,
  ThinkingLabel,
  flyCoins,
  knownAgents,
  recalledSeats,
  rememberSeats,
  useBankroll,
  useChatter,
  useCoworkerLine,
  useRandom,
} from "./kit";
import {
  advance,
  applyAction,
  legalActions,
  legalize,
  potTotal,
  startHand,
  type PokerAction,
  type PokerState,
} from "./poker";
import { decidePoker, equityRuns } from "./pokerAi";
import { handName } from "./pokerEval";
import {
  blindsForHand,
  finishedStacks,
  gameOver,
  nextHandPlayers,
  resultLine,
  startGame,
  type PokerGame,
} from "./pokerGame";
import { handScores, logAction, logBlinds, recapHand, type LoggedAction } from "./pokerRecap";
import { BUTTON_MARK } from "./sprites";
import { chipsInPlay, formatTokens, rivalShares, tokenStore } from "./tokens";

/** Fork: the poker table. The engine holds the rules; this paces and draws them. */

const YOU = "you";
const MAX_AGENTS = 5;
const MIN_AGENTS = 2;
const EQUITY_RUNS = 300;
const STREET_MS = 700;

const seatSelector = (id: string) => `[data-seat="${id}"]`;

export type TableProps = {
  mode: TableMode;
  runId: number;
  active: boolean;
  waiting: number;
  onExit: () => void;
  onInput: () => void;
};

function initialSeats(random: () => number) {
  const saved = knownAgents(recalledSeats().poker);
  return saved.length > 0 ? saved : defaultSeats(random);
}

function clampRaise(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, Math.floor(value)));
}

export function PokerTable({ mode, runId, active, waiting, onExit, onInput }: TableProps) {
  const dealRandom = useRandom(11);
  const talkRandom = useRandom(23);
  const aiRandom = useRandom(37);
  const { bubbles, say } = useChatter(talkRandom);
  const bankroll = useBankroll();

  const [picked, setPicked] = useState(() => initialSeats(talkRandom));
  const [hand, setHand] = useState<PokerState | null>(null);
  const [game, setGame] = useState<PokerGame | null>(null);
  const [ids, setIds] = useState<AgentId[]>([]);
  const [thinking, setThinking] = useState<AgentId | null>(null);
  const [raiseTo, setRaiseTo] = useState(0);
  const [lastWords, setLastWords] = useState("");
  const [log, setLog] = useState<LoggedAction[]>([]);

  const root = useRef<HTMLDivElement>(null);
  const shoe = useRef<HTMLDivElement>(null);
  const handRef = useRef(hand);
  handRef.current = hand;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const gameRef = useRef<PokerGame | null>(null);
  const tilt = useRef(new Map<AgentId, number>());
  const bluffs = useRef(new Set<AgentId>());
  const button = useRef(-1);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const logRef = useRef<LoggedAction[]>([]);

  const stakes = POKER_STAKES[mode];
  const seated = hand ? ids : picked;
  useCoworkerLine(waiting, seated, say, talkRandom);

  const putGame = useCallback((next: PokerGame | null) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  /** Every state change goes through here: the tokens follow your stack. */
  const commit = useCallback(
    (next: PokerState) => {
      const before = handRef.current;
      const seatIds = [YOU, ...idsRef.current];
      if (before) {
        next.seats.forEach((seat, index) => {
          if (seat.total > before.seats[index]!.total) {
            flyCoins(root.current, seatSelector(seatIds[index]!), "[data-pot]");
          }
        });
        tokenStore.add(next.seats[0]!.stack - before.seats[0]!.stack);
      }
      handRef.current = next;
      setHand(next);
      if (next.street === "done" && next.result && before?.street !== "done") {
        settle(next, seatIds);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** A seat's action: written into the hand's log, then played. */
  const act = useCallback(
    (current: PokerState, action: PokerAction) => {
      const entry = logAction(current, action);
      if (entry) {
        logRef.current = [...logRef.current, entry];
        setLog(logRef.current);
      }
      commit(applyAction(current, action));
    },
    [commit],
  );

  const settle = (done: PokerState, seatIds: string[]) => {
    const { result } = done;
    if (!result) {
      return;
    }
    for (const pot of result.pots) {
      for (const winner of pot.winners) {
        flyCoins(root.current, "[data-pot]", seatSelector(seatIds[winner]!), 4);
      }
    }
    // Your result, split across the agents who paid for it or took it.
    const others: Record<string, number> = {};
    seatIds.forEach((id, index) => {
      if (index > 0) {
        others[id] = result.net[index]!;
      }
    });
    const shares = rivalShares(result.net[0]!, others);
    for (const [id, net] of Object.entries(shares)) {
      tokenStore.addRival(id, { net });
    }

    const big = done.bigBlind;
    const shown = Object.keys(result.shown).length > 0;
    seatIds.forEach((id, index) => {
      if (index === 0) {
        return;
      }
      const agent = id as AgentId;
      const net = result.net[index]!;
      const was = tilt.current.get(agent) ?? 0;
      tilt.current.set(agent, net < -20 * big ? Math.min(1, was + 0.4) : was * 0.8);
      const seat = done.seats[index]!;
      if (seat.out) {
        return;
      }
      // Claude owns up either way. The rest only when they're shown down.
      if (bluffs.current.has(agent) && (agent === "claude" || (shown && !seat.folded))) {
        say(agent, "bluffCaught");
      } else if (seat.stack === 0) {
        say(agent, "bust");
      } else if (net > 0) {
        say(agent, "win", 0.8);
      } else if (net < -5 * big) {
        say(agent, "lose", 0.7);
      }
    });

    const run = gameRef.current;
    const stacks = finishedStacks(done.seats);
    if (run) {
      const end = gameOver(stacks);
      if (end.over) {
        const finished: PokerGame = {
          ...run,
          stacks,
          result: end.winner === "you" ? "won" : "lost",
        };
        putGame(finished);
        chipsInPlay.release("poker");
        setLastWords(resultLine(finished));
      } else {
        putGame({ ...run, stacks });
        setLastWords(describeResult(done, seatIds));
      }
    } else {
      setLastWords(describeResult(done, seatIds));
    }
  };

  const dealNext = useCallback(() => {
    const current = handRef.current;
    if (current && current.street !== "done") {
      return;
    }
    let run = gameRef.current;
    if (!run || run.result !== "playing") {
      const base = POKER_STAKES[modeRef.current];
      const tokens = tokenStore.bankroll().tokens;
      // A new game needs the big blind, not a full stack.
      if (tokens < base.big) {
        return;
      }
      if (!chipsInPlay.claim("poker")) {
        setLastWords("Leave the blackjack table first.");
        return;
      }
      const nextIds = fillSeats(pickedRef.current, MIN_AGENTS).slice(0, MAX_AGENTS);
      run = startGame(tokens, nextIds.length, base);
      idsRef.current = nextIds;
      setIds(nextIds);
      button.current = -1;
      tilt.current.clear();
    }
    const handNumber = run.hands + 1;
    const blinds = blindsForHand(handNumber, run.stakes);
    const players = nextHandPlayers(YOU, idsRef.current, run.stacks);
    const start = startHand(
      players,
      button.current,
      blinds.small,
      blinds.big,
      dealRandom,
    );
    button.current = start.button;
    bluffs.current.clear();
    setLastWords("");
    logRef.current = logBlinds(start);
    setLog(logRef.current);
    putGame({
      ...run,
      hands: handNumber,
      stacks: finishedStacks(start.seats),
    });
    tokenStore.add(start.seats[0]!.stack - players[0]!.stack);
    handRef.current = start;
    setHand(start);
    const seatIds = [YOU, ...idsRef.current];
    for (const blind of [start.sbSeat, start.bbSeat]) {
      flyCoins(root.current, seatSelector(seatIds[blind]!), "[data-pot]", 2);
    }
  }, [dealRandom, putGame]);

  // New game: chips already in the pot stay lost, as if you'd folded.
  const seenRun = useRef(runId);
  useEffect(() => {
    if (runId === seenRun.current) {
      return;
    }
    seenRun.current = runId;
    if (!active) {
      return;
    }
    chipsInPlay.release("poker");
    handRef.current = null;
    setHand(null);
    setIds([]);
    setLastWords("");
    logRef.current = [];
    setLog([]);
    putGame(null);
    tilt.current.clear();
    bluffs.current.clear();
    button.current = -1;
    setThinking(null);
  }, [runId, active, putGame]);

  // The dealer and the agents act here, one step per state, while it's showing.
  useEffect(() => {
    if (!active || !hand || hand.street === "done") {
      return;
    }
    if (hand.toAct < 0) {
      const timer = setTimeout(() => commit(advance(hand)), STREET_MS);
      return () => clearTimeout(timer);
    }
    if (hand.toAct === 0) {
      return;
    }
    const id = ids[hand.toAct - 1];
    if (!id) {
      return;
    }
    const seat = hand.seats[hand.toAct]!;
    const agent = AGENTS[id];
    const opponents = hand.seats.filter(
      (other, index) => index !== hand.toAct && !other.out && !other.folded,
    ).length;
    const youreOut = hand.seats[0]!.folded;
    const delay = (400 + aiRandom() * 1000) * (youreOut ? 0.4 : 1);
    const started = performance.now();
    const walk = equityRuns(seat.hole, hand.board, opponents, EQUITY_RUNS, aiRandom);
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    setThinking(id);
    if (!youreOut) {
      say(id, "thinking", 0.15);
    }

    const decide = (equity: number) => {
      if (cancelled) {
        return;
      }
      const decision = decidePoker(
        hand,
        agent.poker,
        { noise: gameRef.current?.stakes.noise ?? POKER_STAKES[modeRef.current].noise },
        equity,
        tilt.current.get(id) ?? 0,
        aiRandom,
      );
      const action = legalize(hand, decision.action);
      if (decision.bluffing) {
        bluffs.current.add(id);
      }
      setThinking(null);
      speak(id, action, hand, say);
      act(hand, action);
    };

    const pump = () => {
      if (cancelled) {
        return;
      }
      const step = walk.next();
      if (!step.done) {
        timer = setTimeout(pump, 0);
        return;
      }
      const left = Math.max(0, delay - (performance.now() - started));
      timer = setTimeout(() => decide(step.value), left);
    };
    timer = setTimeout(pump, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setThinking(null);
    };
  }, [hand, active, ids, commit, act, aiRandom, say]);

  const running = game?.result === "playing";
  const ended = !!game && game.result !== "playing";

  const yourTurn = !!hand && hand.street !== "done" && hand.toAct === 0;
  const legal = yourTurn && hand ? legalActions(hand, 0) : null;
  const pot = hand ? potTotal(hand) : 0;
  const owed = legal?.callAmount ?? 0;
  const raiseLow = legal ? Math.min(legal.minRaiseTo, legal.maxRaiseTo) : 0;
  const raiseHigh = legal?.maxRaiseTo ?? 0;
  const nextHand = game ? game.hands + 1 : 1;
  const nextBlinds = game ? blindsForHand(nextHand, game.stakes) : stakes;
  const blindsLine = `blinds ${formatTokens(nextBlinds.small)}/${formatTokens(nextBlinds.big)} · hand ${nextHand}`;

  // A fresh turn starts the slider at the smallest raise.
  const turnKey = yourTurn && hand ? `${hand.street}:${hand.currentBet}` : "";
  useEffect(() => {
    if (turnKey) {
      setRaiseTo(raiseLow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey]);

  const play = (action: PokerAction) => {
    const current = handRef.current;
    if (!current || current.toAct !== 0 || current.street === "done") {
      return;
    }
    act(current, legalize(current, action));
  };
  const fold = () => {
    const current = handRef.current;
    if (current?.toAct === 0 && current.street !== "done") {
      act(current, { type: "fold" });
    }
  };
  const raiseNow = (to: number) => {
    if (legal?.canRaise) {
      play({ type: "raise", to: clampRaise(to, raiseLow, raiseHigh) });
    }
  };

  const broke = !running && bankroll.tokens < stakes.big;

  const leave = () => {
    const current = handRef.current;
    const run = gameRef.current;
    if (!run || run.result !== "playing" || !current || current.street !== "done") {
      return;
    }
    const finished: PokerGame = {
      ...run,
      stacks: finishedStacks(current.seats),
      result: "left",
    };
    putGame(finished);
    chipsInPlay.release("poker");
    setLastWords(resultLine(finished));
  };

  // Test-only: the browser spec sets the carried stacks so a game can end at
  // once. Nothing in the app calls this.
  const testSeam = useRef<(stacks: number[], hands?: number) => void>(() => {});
  testSeam.current = (stacks, hands) => {
    const current = handRef.current;
    const run = gameRef.current;
    if (!run || run.result !== "playing" || !current || current.street !== "done") {
      return;
    }
    const next: PokerGame = {
      ...run,
      hands: hands ?? run.hands,
      stacks: stacks.map((stack) => Math.max(0, stack)),
    };
    const end = gameOver(next.stacks);
    if (end.over) {
      next.result = end.winner === "you" ? "won" : "lost";
      chipsInPlay.release("poker");
      setLastWords(resultLine(next));
    }
    putGame(next);
  };
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const testWindow = window as unknown as {
      __setPokerStacks?: (stacks: number[], hands?: number) => void;
    };
    testWindow.__setPokerStacks = (stacks, hands) => testSeam.current(stacks, hands);
    return () => {
      delete testWindow.__setPokerStacks;
    };
  }, []);

  const onKey = (key: string) => {
    if (key === " ") {
      if (!hand || hand.street === "done") {
        dealNext();
      }
    } else if (!legal) {
      return;
    } else if (key === "f") {
      fold();
    } else if (key === "c") {
      play(legal.canCheck ? { type: "check" } : { type: "call" });
    } else if (key === "r") {
      raiseNow(raiseTo);
    } else if (key === "a") {
      if (legal.canRaise) {
        raiseNow(raiseHigh);
      } else if (!legal.canCheck) {
        play({ type: "call" });
      }
    }
  };

  const you = hand?.seats[0];
  const shown = hand?.result?.shown ?? {};
  const winners = new Set(hand?.result?.pots.flatMap((item) => item.winners) ?? []);
  const done = hand?.street === "done";
  // Once a hand is over every seat's cards turn up, folded ones too.
  const scores = done && hand ? handScores(hand) : shown;
  const yourScore = scores[0];
  const recap =
    done && hand ? recapHand(hand, log, [YOU, ...ids.map((id) => AGENTS[id].name)]) : null;

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Poker table">
      <ShoeContext.Provider value={shoe}>
        <div ref={root} data-table-phase={hand?.street ?? "idle"} className="relative flex h-full flex-col">
          <Felt className="inset-x-3 top-[86px] bottom-[126px]" />

          <div className="relative z-10 flex shrink-0 items-start justify-around px-2 pt-1">
            {seated.slice(0, MAX_AGENTS).map((id, offset) => {
              const seatIndex = offset + 1;
              const seat = hand?.seats[seatIndex];
              const inHand = seat && !seat.out;
              const isOut = !!seat && (seat.out || (hand?.street === "done" && seat.stack <= 0));
              const isThinking = thinking === id;
              const reveal = !!seat && (done || shown[seatIndex] !== undefined);
              const label =
                done && seat?.folded ? "folded" : scores[seatIndex] !== undefined ? handName(scores[seatIndex]!) : null;
              return (
                <div
                  key={id}
                  data-seat={id}
                  data-out={isOut ? "" : undefined}
                  className={`relative flex w-[126px] flex-col items-center gap-0.5 ${
                    seat?.folded || isOut ? "opacity-45" : ""
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Avatar id={id} lively={isThinking || !!bubbles[id] || (!!hand && winners.has(seatIndex))} />
                    <div className="flex flex-col font-mono text-[10px] leading-[13px]">
                      <span className="text-content/85">{AGENTS[id].name}</span>
                      <span className="tabular-nums text-content/55">
                        {seat ? formatTokens(seat.stack) : "–"}
                      </span>
                    </div>
                    {hand && hand.button === seatIndex ? (
                      <Sprite rows={BUTTON_MARK} scale={1} colors={{ "#": "var(--color-content)" }} label="Dealer button" />
                    ) : null}
                  </div>
                  <div className="flex h-[42px] gap-0.5">
                    {inHand && (!seat.folded || done)
                      ? seat.hole.map((card, index) => (
                          <PixelCard
                            key={index}
                            card={reveal ? card : null}
                            scale={2}
                            delay={index * 70}
                          />
                        ))
                      : null}
                  </div>
                  <div className="flex h-3.5 items-center gap-1 font-mono text-[10px] tabular-nums text-content/70">
                    {reveal && label ? (
                      <span className={winners.has(seatIndex) ? "text-[var(--table-win)]" : ""}>
                        {label}
                      </span>
                    ) : seat && seat.bet > 0 ? (
                      <>
                        <Coin />
                        {formatTokens(seat.bet)}
                      </>
                    ) : null}
                  </div>
                  {bubbles[id] ? (
                    <Bubble text={bubbles[id]!} className="absolute top-full z-30 mt-1 !max-w-[124px]" />
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="relative z-0 flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
            <div ref={shoe} data-shoe="" className="absolute top-3 right-16 opacity-70">
              <PixelCard card={null} scale={2} />
            </div>
            <div data-pot="" className="flex h-4 items-center gap-1 font-mono text-[11px] tabular-nums text-content/80">
              {hand ? (
                <>
                  <Coin />
                  pot {formatTokens(pot)}
                </>
              ) : null}
            </div>
            <div className="flex gap-1.5" data-board="">
              {[0, 1, 2, 3, 4].map((index) => {
                const card = hand?.board[index];
                return card !== undefined ? (
                  <PixelCard key={index} card={card} scale={4} delay={index < 3 ? index * 70 : 0} />
                ) : (
                  <CardSlot key={index} scale={4} />
                );
              })}
            </div>
            <div role="status" data-table-status="" className="h-4 truncate font-mono text-[11px] text-content/70">
              {thinking ? (
                <ThinkingLabel id={thinking} />
              ) : ended ? (
                lastWords
              ) : hand?.street === "done" ? (
                lastWords ? `${blindsLine} · ${lastWords}` : blindsLine
              ) : yourTurn ? (
                "your turn"
              ) : !hand ? (
                lastWords || `blinds ${stakes.small}/${stakes.big}`
              ) : (
                ""
              )}
            </div>
            {recap ? (
              <ol
                data-hand-recap=""
                aria-label="What happened this hand"
                className="min-h-0 w-full max-w-[460px] shrink overflow-y-auto px-4 font-mono text-[10px] leading-[14px] text-content/60"
              >
                {recap.streets.map((line, index) => (
                  <li key={`street-${index}`}>{line}</li>
                ))}
                {recap.results.map((line, index) => (
                  <li key={`result-${index}`} className="text-content/85">
                    {line}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          <div className="relative z-10 flex h-[122px] shrink-0 items-end gap-3 px-3 pb-2.5">
            <div
              data-seat={YOU}
              data-you-stack={you?.stack}
              data-you-bet={you?.bet}
              className="flex shrink-0 flex-col gap-1"
            >
              <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-content/80">
                <span>you</span>
                <span className="text-content/55">
                  {you ? formatTokens(you.stack) : formatTokens(bankroll.tokens)}
                </span>
                {hand?.button === 0 ? (
                  <Sprite rows={BUTTON_MARK} scale={1} colors={{ "#": "var(--color-content)" }} label="Dealer button" />
                ) : null}
                {you && you.bet > 0 ? (
                  <span className="flex items-center gap-1 text-content/70">
                    <Coin />
                    {formatTokens(you.bet)}
                  </span>
                ) : null}
              </div>
              <div className={`flex gap-1 ${you?.folded ? "opacity-45" : ""}`} data-you-cards="">
                {you && !you.out ? (
                  you.hole.map((card, index) => (
                    <PixelCard key={index} card={card} scale={3} delay={index * 70} />
                  ))
                ) : (
                  <>
                    <CardSlot scale={3} />
                    <CardSlot scale={3} />
                  </>
                )}
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5 self-end">
              {yourScore !== undefined ? (
                <span className={`font-mono text-[11px] ${winners.has(0) ? "text-[var(--table-win)]" : "text-content/70"}`}>
                  {handName(yourScore)}
                </span>
              ) : null}
              {legal ? (
                <>
                  {legal.canRaise ? (
                    <div className="flex w-full max-w-[420px] items-center justify-end gap-1.5">
                      <input
                        type="range"
                        aria-label="Raise to"
                        className="table-slider min-w-0 flex-1"
                        min={raiseLow}
                        max={raiseHigh}
                        step={1}
                        value={clampRaise(raiseTo, raiseLow, raiseHigh)}
                        onChange={(event) => setRaiseTo(Number(event.target.value))}
                      />
                      <ActionButton
                        label="1/2 pot"
                        data-action="half-pot"
                        onClick={() => setRaiseTo(clampRaise((hand?.currentBet ?? 0) + (pot + owed) / 2, raiseLow, raiseHigh))}
                      />
                      <ActionButton
                        label="pot"
                        data-action="pot"
                        onClick={() => setRaiseTo(clampRaise((hand?.currentBet ?? 0) + pot + owed, raiseLow, raiseHigh))}
                      />
                      <ActionButton
                        label="all in"
                        data-action="max"
                        onClick={() => setRaiseTo(raiseHigh)}
                      />
                    </div>
                  ) : null}
                  <div className="flex items-center justify-end gap-1.5">
                    <ActionButton icon="fold" label="Fold" keyHint="F" data-action="fold" onClick={fold} />
                    <ActionButton
                      icon="check"
                      primary
                      label={legal.canCheck ? "Check" : `Call ${formatTokens(owed)}`}
                      keyHint="C"
                      data-action="call"
                      onClick={() => play(legal.canCheck ? { type: "check" } : { type: "call" })}
                    />
                    {legal.canRaise ? (
                      <ActionButton
                        icon={raiseTo >= raiseHigh ? "allIn" : "raise"}
                        label={
                          raiseTo >= raiseHigh
                            ? `All in ${formatTokens(raiseHigh)}`
                            : `Raise to ${formatTokens(raiseTo)}`
                        }
                        keyHint="R"
                        data-action="raise"
                        onClick={() => raiseNow(raiseTo)}
                      />
                    ) : null}
                  </div>
                </>
              ) : !hand || hand.street === "done" ? (
                running ? (
                  <div className="flex items-center gap-3">
                    <ActionButton
                      icon="deal"
                      primary
                      label="Next hand"
                      keyHint="Space"
                      data-action="deal"
                      onClick={dealNext}
                    />
                    <ActionButton
                      label="Leave table"
                      data-action="leave"
                      onClick={leave}
                    />
                  </div>
                ) : broke ? (
                  <QuotaBump needed={stakes.big} />
                ) : (
                  <div className="flex items-center gap-3">
                    <SeatPicker
                      picked={picked}
                      max={MAX_AGENTS}
                      onChange={(next) => {
                        setPicked(next);
                        rememberSeats({ poker: next });
                      }}
                    />
                    <ActionButton
                      icon="deal"
                      primary
                      label={game ? "New game" : "Deal"}
                      keyHint="Space"
                      data-action="deal"
                      onClick={dealNext}
                    />
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      </ShoeContext.Provider>
    </TableFrame>
  );
}

function speak(
  id: AgentId,
  action: PokerAction,
  hand: PokerState,
  say: (id: AgentId, event: "fold" | "check" | "call" | "raise" | "allIn", chance?: number) => void,
) {
  if (action.type === "raise") {
    const legal = legalActions(hand);
    if (action.to >= legal.maxRaiseTo) {
      say(id, "allIn");
    } else {
      say(id, "raise", 0.8);
    }
  } else {
    say(id, action.type, action.type === "check" ? 0.3 : 0.6);
  }
}

function describeResult(done: PokerState, seatIds: readonly string[]) {
  const { result } = done;
  if (!result) {
    return "";
  }
  const nameOf = (index: number) =>
    index === 0 ? "You" : AGENTS[seatIds[index] as AgentId].name;
  const contested = result.pots.filter((pot) => pot.eligible.length > 1);
  const main = contested[0];
  const shownDown = Object.keys(result.shown).length > 0;
  if (!main || !shownDown) {
    const gainer = done.seats.findIndex((_, index) => result.net[index]! > 0);
    return gainer < 0
      ? "Everyone folded"
      : `${nameOf(gainer)} ${gainer === 0 ? "take" : "takes"} it, ${formatTokens(result.net[gainer]!)} up. No cards shown.`;
  }
  const best = main.winners[0]!;
  const hand = handName(result.shown[best]!);
  if (main.winners.length > 1) {
    return `Split pot, ${hand}`;
  }
  const net = result.net[best]!;
  return `${nameOf(best)} ${best === 0 ? "win" : "wins"} ${formatTokens(Math.max(net, 0))} with ${hand}`;
}
