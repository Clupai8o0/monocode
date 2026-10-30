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
import { BUTTON_MARK } from "./sprites";
import { chipsInPlay, formatTokens, rivalShares, tokenStore } from "./tokens";

/** Fork: the poker table. The engine holds the rules; this paces and draws them. */

const YOU = "you";
const MAX_AGENTS = 5;
const MIN_AGENTS = 2;
const EQUITY_RUNS = 300;
const STACK_BIGS = 100;
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
  const [ids, setIds] = useState<AgentId[]>([]);
  const [thinking, setThinking] = useState<AgentId | null>(null);
  const [raiseTo, setRaiseTo] = useState(0);
  const [lastWords, setLastWords] = useState("");

  const root = useRef<HTMLDivElement>(null);
  const shoe = useRef<HTMLDivElement>(null);
  const handRef = useRef(hand);
  handRef.current = hand;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const stacks = useRef(new Map<AgentId, number>());
  const tilt = useRef(new Map<AgentId, number>());
  const bluffs = useRef(new Set<AgentId>());
  const button = useRef(-1);

  const stakes = POKER_STAKES[mode];
  const seated = hand ? ids : picked;
  useCoworkerLine(waiting, seated, say, talkRandom);

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
      next.seats.forEach((seat, index) => {
        if (index > 0) {
          stacks.current.set(seatIds[index] as AgentId, seat.stack);
        }
      });
      if (next.street === "done" && next.result && before?.street !== "done") {
        settle(next, seatIds);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const settle = (done: PokerState, seatIds: string[]) => {
    const { result } = done;
    if (!result) {
      return;
    }
    chipsInPlay.release("poker");
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
    setLastWords(describeResult(done, seatIds));
  };

  const dealNext = useCallback(() => {
    const current = handRef.current;
    if (current && current.street !== "done") {
      return;
    }
    const tokens = tokenStore.bankroll().tokens;
    const { small, big } = POKER_STAKES[modeRef.current];
    if (tokens < big) {
      return;
    }
    if (!chipsInPlay.claim("poker")) {
      setLastWords("Finish your blackjack round first.");
      return;
    }
    const nextIds = fillSeats(pickedRef.current, MIN_AGENTS).slice(0, MAX_AGENTS);
    const cap = big * STACK_BIGS;
    const players = [
      { id: YOU, stack: Math.min(tokens, cap) },
      ...nextIds.map((id) => {
        const stack = stacks.current.get(id) ?? 0;
        // A busted agent, or one seated at a bigger table, buys back in.
        return { id, stack: stack >= big ? stack : cap };
      }),
    ];
    const start = startHand(players, button.current, small, big, dealRandom);
    button.current = start.button;
    bluffs.current.clear();
    setLastWords("");
    idsRef.current = nextIds;
    setIds(nextIds);
    tokenStore.add(start.seats[0]!.stack - players[0]!.stack);
    handRef.current = start;
    setHand(start);
    const seatIds = [YOU, ...nextIds];
    for (const blind of [start.sbSeat, start.bbSeat]) {
      flyCoins(root.current, seatSelector(seatIds[blind]!), "[data-pot]", 2);
    }
    start.seats.forEach((seat, index) => {
      if (index > 0) {
        stacks.current.set(nextIds[index - 1]!, seat.stack);
      }
    });
  }, [dealRandom]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

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
    stacks.current.clear();
    tilt.current.clear();
    button.current = -1;
  }, [runId, active]);

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

    const act = (equity: number) => {
      if (cancelled) {
        return;
      }
      const decision = decidePoker(
        hand,
        agent.poker,
        { noise: POKER_STAKES[modeRef.current].noise },
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
      commit(applyAction(hand, action));
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
      timer = setTimeout(() => act(step.value), left);
    };
    timer = setTimeout(pump, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setThinking(null);
    };
  }, [hand, active, ids, commit, aiRandom, say]);

  const yourTurn = !!hand && hand.street !== "done" && hand.toAct === 0;
  const legal = yourTurn && hand ? legalActions(hand, 0) : null;
  const pot = hand ? potTotal(hand) : 0;
  const owed = legal?.callAmount ?? 0;
  const raiseLow = legal ? Math.min(legal.minRaiseTo, legal.maxRaiseTo) : 0;
  const raiseHigh = legal?.maxRaiseTo ?? 0;

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
    commit(applyAction(current, legalize(current, action)));
  };
  const fold = () => {
    const current = handRef.current;
    if (current?.toAct === 0 && current.street !== "done") {
      commit(applyAction(current, { type: "fold" }));
    }
  };
  const raiseNow = (to: number) => {
    if (legal?.canRaise) {
      play({ type: "raise", to: clampRaise(to, raiseLow, raiseHigh) });
    }
  };

  const broke = !hand || hand.street === "done" ? bankroll.tokens < stakes.big : false;

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
  const yourScore = shown[0];

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
              const isThinking = thinking === id;
              const reveal = seat && shown[seatIndex] !== undefined;
              return (
                <div
                  key={id}
                  data-seat={id}
                  className={`relative flex w-[126px] flex-col items-center gap-0.5 ${
                    seat?.folded || seat?.out ? "opacity-45" : ""
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
                    {inHand && !seat.folded
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
                    {reveal ? (
                      <span className={winners.has(seatIndex) ? "text-[var(--table-win)]" : ""}>
                        {handName(shown[seatIndex]!)}
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
              ) : hand?.street === "done" ? (
                lastWords
              ) : yourTurn ? (
                "your turn"
              ) : !hand ? (
                lastWords || `blinds ${stakes.small}/${stakes.big}`
              ) : (
                ""
              )}
            </div>
          </div>

          <div className="relative z-10 flex h-[122px] shrink-0 items-end gap-3 px-3 pb-2.5">
            <div data-seat={YOU} className="flex shrink-0 flex-col gap-1">
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
                broke ? (
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
                      label={hand ? "Next hand" : "Deal"}
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
