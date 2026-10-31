import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENTS,
  BLACKJACK_STAKES,
  defaultSeats,
  type AgentId,
} from "./agents";
import {
  agentBet,
  applyBj,
  cardValue,
  createTable,
  deal,
  dealerStep,
  decideBj,
  handTotal,
  isBlackjack,
  legalBj,
  seatNet,
  type BjAction,
  type BjHand,
  type BjState,
} from "./blackjack";
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
import type { TableProps } from "./PokerTable";
import { DEALER } from "./sprites";
import { chipsInPlay, formatTokens, tokenStore } from "./tokens";

/** Fork: the blackjack table. Agents sit first and play first; you go last. */

const MAX_AGENTS = 3;
const AGENT_BANK = 200;
const DEALER_MS = 620;
const YOU = "you";

const seatSelector = (id: string) => `[data-seat="${id}"]`;

const OUTCOME_WORDS = {
  win: "win",
  lose: "lose",
  push: "push",
  blackjack: "blackjack",
  bust: "bust",
} as const;

function initialSeats(random: () => number) {
  const saved = knownAgents(recalledSeats().blackjack);
  return saved.length > 0 ? saved.slice(0, MAX_AGENTS) : defaultSeats(random, MAX_AGENTS);
}

function HandCards({ hand, scale, won }: { hand: BjHand; scale: number; won?: boolean }) {
  const overlap = scale === 3 ? -21 : -14;
  const { total, soft } = handTotal(hand.cards);
  const bust = total > 21;
  return (
    <div className="flex flex-col items-center gap-0.5" data-hand="">
      <div className="flex">
        {hand.cards.map((card, index) => (
          <span key={index} style={{ marginLeft: index === 0 ? 0 : overlap }}>
            <PixelCard card={card} scale={scale} />
          </span>
        ))}
      </div>
      <span
        data-hand-total={total}
        className={`font-mono text-[10px] tabular-nums ${
          won ? "text-[var(--table-win)]" : bust || hand.outcome === "lose" ? "text-[var(--table-red)]" : "text-content/70"
        }`}
      >
        {soft && total < 21 ? `${total - 10}/${total}` : total}
        {hand.outcome ? ` ${OUTCOME_WORDS[hand.outcome]}` : bust ? " bust" : ""}
        {hand.doubled ? " x2" : ""}
      </span>
    </div>
  );
}

export function BlackjackTable({ mode, runId, active, waiting, onExit, onInput }: TableProps) {
  const cardRandom = useRandom(41);
  const talkRandom = useRandom(53);
  const aiRandom = useRandom(67);
  const { bubbles, say } = useChatter(talkRandom);
  const bankroll = useBankroll();
  const stakes = BLACKJACK_STAKES[mode];

  const [picked, setPicked] = useState(() => initialSeats(talkRandom));
  const [ids, setIds] = useState<AgentId[]>([]);
  const [state, setState] = useState<BjState | null>(null);
  const [thinking, setThinking] = useState<AgentId | null>(null);
  const [bet, setBet] = useState(stakes.min);
  const [note, setNote] = useState("");

  const root = useRef<HTMLDivElement>(null);
  const shoe = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const stacks = useRef(new Map<AgentId, number>());

  useCoworkerLine(waiting, state ? ids : picked, say, talkRandom);

  // A new table minimum moves the bet with it.
  useEffect(() => {
    setBet(stakes.min);
  }, [stakes.min]);

  const you = (seat: number, count = idsRef.current.length) => seat === count;

  const commit = useCallback((next: BjState) => {
    const before = stateRef.current;
    const count = idsRef.current.length;
    if (before) {
      tokenStore.add(next.seats[count]!.stack - before.seats[count]!.stack);
    }
    next.seats.forEach((seat, index) => {
      if (index < count) {
        stacks.current.set(idsRef.current[index]!, seat.stack);
      }
    });
    stateRef.current = next;
    setState(next);
    if (next.phase === "settled" && before?.phase !== "settled") {
      settle(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = (done: BjState) => {
    chipsInPlay.release("blackjack");
    const count = idsRef.current.length;
    const mine = seatNet(done.seats[count]!);
    done.seats.forEach((seat, index) => {
      const id = index < count ? idsRef.current[index]! : YOU;
      if (seatNet(seat) > 0) {
        flyCoins(root.current, "[data-dealer]", seatSelector(id), 3);
      }
      if (index >= count) {
        return;
      }
      const agent = idsRef.current[index]!;
      const net = seatNet(seat);
      // You don't play the agents here, so this is how the two of you compare.
      tokenStore.addRival(agent, { net: mine - net });
      if (seat.hands.some(isBlackjack) && net > 0) {
        say(agent, "blackjack");
      } else if (seat.stack < BLACKJACK_STAKES[modeRef.current].min) {
        say(agent, "bust");
      } else if (net > 0) {
        say(agent, "win", 0.6);
      } else if (net < 0) {
        say(agent, "lose", 0.5);
      }
    });
    setNote(
      mine > 0
        ? `You win ${formatTokens(mine)}`
        : mine < 0
          ? `You lose ${formatTokens(-mine)}`
          : "Push. Your bet comes back.",
    );
  };

  const dealNext = useCallback(() => {
    const current = stateRef.current;
    if (current && current.phase !== "settled" && current.phase !== "betting") {
      return;
    }
    const { min } = BLACKJACK_STAKES[modeRef.current];
    const tokens = tokenStore.bankroll().tokens;
    const yourBet = Math.min(betRef.current, tokens);
    if (yourBet < min) {
      return;
    }
    if (!chipsInPlay.claim("blackjack")) {
      setNote("Leave the poker table first.");
      return;
    }
    const nextIds = pickedRef.current.slice(0, MAX_AGENTS);
    const bank = min * AGENT_BANK;
    const players = [
      ...nextIds.map((id) => {
        const stack = stacks.current.get(id) ?? 0;
        return { id, stack: stack >= min ? stack : bank };
      }),
      { id: YOU, stack: tokens },
    ];
    const table = createTable(players, cardRandom);
    // Same shoe from round to round; only the people change.
    const ready: BjState = current
      ? { ...table, shoe: current.shoe, shoeSize: current.shoeSize }
      : table;
    const bets = [
      ...nextIds.map((id, index) =>
        agentBet(AGENTS[id].blackjack, players[index]!.stack, min, aiRandom),
      ),
      yourBet,
    ];
    const next = deal(ready, bets, cardRandom);
    idsRef.current = nextIds;
    setIds(nextIds);
    setNote(next.reshuffled ? "Fresh shoe" : "");
    // The base state for the token sync is the table before the bet went down.
    stateRef.current = ready;
    flyCoins(root.current, seatSelector(YOU), "[data-dealer]");
    commit(next);
  }, [aiRandom, cardRandom, commit]);

  const betRef = useRef(bet);
  betRef.current = bet;

  const seenRun = useRef(runId);
  useEffect(() => {
    if (runId === seenRun.current) {
      return;
    }
    seenRun.current = runId;
    if (!active) {
      return;
    }
    chipsInPlay.release("blackjack");
    stateRef.current = null;
    setState(null);
    setIds([]);
    setNote("");
    stacks.current.clear();
  }, [runId, active]);

  // Agents and the dealer take one step per state, while the panel's showing.
  useEffect(() => {
    if (!active || !state) {
      return;
    }
    if (state.phase === "dealer") {
      const timer = setTimeout(() => commit(dealerStep(state)), DEALER_MS);
      return () => clearTimeout(timer);
    }
    if (state.phase !== "playing" || you(state.seat, ids.length)) {
      return;
    }
    const id = ids[state.seat];
    if (!id) {
      return;
    }
    setThinking(id);
    const delay = 400 + aiRandom() * 800;
    const timer = setTimeout(() => {
      const { mistakes } = BLACKJACK_STAKES[modeRef.current];
      const action = decideBj(state, AGENTS[id].blackjack, mistakes, aiRandom);
      say(id, action, action === "hit" || action === "stand" ? 0.55 : 1);
      setThinking(null);
      commit(applyBj(state, action));
    }, delay);
    return () => {
      clearTimeout(timer);
      setThinking(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, active, ids, commit, aiRandom, say]);

  const yourTurn = !!state && state.phase === "playing" && you(state.seat, ids.length);
  const legal = yourTurn && state ? legalBj(state) : null;
  const betting = !state || state.phase === "settled" || state.phase === "betting";
  const min = stakes.min;
  const broke = betting && bankroll.tokens < min;

  const act = (action: BjAction) => {
    const current = stateRef.current;
    if (current && legalBj(current)[action] && you(current.seat)) {
      if (action === "double" || action === "split") {
        flyCoins(root.current, seatSelector(YOU), "[data-dealer]");
      }
      commit(applyBj(current, action));
    }
  };

  const onKey = (key: string) => {
    if (key === " ") {
      dealNext();
    } else if (key === "h") {
      act("hit");
    } else if (key === "s") {
      act("stand");
    } else if (key === "d") {
      act("double");
    } else if (key === "p") {
      act("split");
    }
  };

  const seats = state ? ids : picked;
  const count = ids.length;
  const yourSeat = state?.seats[count];
  const hideHole = state?.phase === "playing";
  const dealerHand = state?.dealer ?? [];
  const dealerTotal = dealerHand.length > 0 && !hideHole ? handTotal(dealerHand).total : null;
  const dealerUp = hideHole && dealerHand[0] !== undefined ? cardValue(dealerHand[0]) : null;
  const yourBet = Math.min(bet, bankroll.tokens);

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Blackjack table">
      <ShoeContext.Provider value={shoe}>
        <div ref={root} data-table-phase={state?.phase ?? "idle"} className="relative flex h-full flex-col">
          <Felt className="inset-x-3 top-1 bottom-[136px]" />

          <div className="relative z-10 flex shrink-0 items-start justify-center gap-4 pt-3">
            <div data-dealer="" className="flex flex-col items-center gap-0.5 text-content/80">
              <Sprite
                rows={DEALER.rest}
                scale={3}
                colors={{ "#": "currentColor", r: "var(--table-red)" }}
                label="Dealer"
              />
              <span className="font-mono text-[10px] text-content/60">dealer</span>
            </div>
            <div className="flex min-w-[140px] flex-col items-start gap-0.5">
              <div className="flex" data-dealer-cards="">
                {dealerHand.length > 0 ? (
                  dealerHand.map((card, index) => (
                    <span key={index} style={{ marginLeft: index === 0 ? 0 : -21 }}>
                      <PixelCard card={index === 1 && hideHole ? null : card} scale={3} delay={index * 70} />
                    </span>
                  ))
                ) : (
                  <CardSlot scale={3} />
                )}
              </div>
              <span className="h-3.5 font-mono text-[10px] tabular-nums text-content/70">
                {dealerTotal !== null ? `${dealerTotal}${dealerTotal > 21 ? " bust" : ""}` : dealerUp !== null ? `shows ${dealerUp}` : ""}
              </span>
            </div>
            <div ref={shoe} data-shoe="" className="absolute top-3 right-16 opacity-70">
              <PixelCard card={null} scale={2} />
            </div>
          </div>

          <div className="relative z-10 flex min-h-0 flex-1 items-start justify-around px-4 pt-3">
            {seats.slice(0, MAX_AGENTS).map((id, index) => {
              const seat = state?.seats[index];
              const isThinking = thinking === id;
              return (
                <div key={id} data-seat={id} className="relative flex w-[150px] flex-col items-center gap-1">
                  <div className="flex items-center gap-1.5">
                    <Avatar id={id} lively={isThinking || !!bubbles[id]} />
                    <div className="flex flex-col font-mono text-[10px] leading-[13px]">
                      <span className="text-content/85">{AGENTS[id].name}</span>
                      <span className="tabular-nums text-content/55">
                        {seat ? formatTokens(seat.stack) : "–"}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {seat?.hands.map((hand, at) => (
                      <HandCards
                        key={at}
                        hand={hand}
                        scale={2}
                        won={hand.outcome === "win" || hand.outcome === "blackjack"}
                      />
                    ))}
                  </div>
                  {seat?.hands[0] ? (
                    <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-content/60">
                      <Coin />
                      {formatTokens(seat.hands.reduce((sum, hand) => sum + hand.bet, 0))}
                    </span>
                  ) : null}
                  {bubbles[id] ? (
                    <Bubble text={bubbles[id]!} className="absolute top-full z-30 mt-1" />
                  ) : null}
                </div>
              );
            })}
          </div>

          <div role="status" data-table-status="" className="relative z-10 flex h-5 shrink-0 items-center justify-center font-mono text-[11px] text-content/70">
            {thinking ? (
              <ThinkingLabel id={thinking} />
            ) : yourTurn ? (
              "your turn"
            ) : state?.phase === "dealer" ? (
              "dealer draws"
            ) : (
              note || `table minimum ${formatTokens(min)}`
            )}
          </div>

          <div className="relative z-10 flex h-[112px] shrink-0 items-end gap-3 px-3 pb-2.5">
            <div data-seat={YOU} className="flex shrink-0 flex-col gap-1">
              <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-content/80">
                <span>you</span>
                <span className="text-content/55">{formatTokens(bankroll.tokens)}</span>
                {yourSeat?.hands[0] ? (
                  <span className="flex items-center gap-1 text-content/70">
                    <Coin />
                    {formatTokens(yourSeat.hands.reduce((sum, hand) => sum + hand.bet, 0))}
                  </span>
                ) : null}
              </div>
              <div className="flex gap-3" data-you-cards="">
                {yourSeat?.hands.length ? (
                  yourSeat.hands.map((hand, at) => (
                    <div
                      key={at}
                      className={state?.phase === "playing" && yourTurn && state.hand !== at ? "opacity-50" : ""}
                    >
                      <HandCards
                        hand={hand}
                        scale={3}
                        won={hand.outcome === "win" || hand.outcome === "blackjack"}
                      />
                    </div>
                  ))
                ) : (
                  <CardSlot scale={3} />
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5 self-end">
              {legal ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ActionButton icon="hit" primary label="Hit" keyHint="H" data-action="hit" onClick={() => act("hit")} />
                  <ActionButton icon="stand" primary label="Stand" keyHint="S" data-action="stand" onClick={() => act("stand")} />
                  <ActionButton icon="double" label="Double" keyHint="D" data-action="double" disabled={!legal.double} onClick={() => act("double")} />
                  <ActionButton icon="split" label="Split" keyHint="P" data-action="split" disabled={!legal.split} onClick={() => act("split")} />
                </div>
              ) : betting ? (
                broke ? (
                  <QuotaBump needed={min} />
                ) : (
                  <>
                    <SeatPicker
                      picked={picked}
                      max={MAX_AGENTS}
                      onChange={(next) => {
                        setPicked(next);
                        rememberSeats({ blackjack: next });
                      }}
                    />
                    <div className="flex items-center gap-1.5">
                      <ActionButton
                        icon="minus"
                        label="Less"
                        data-action="bet-down"
                        disabled={bet <= min}
                        onClick={() => setBet((value) => Math.max(min, value - min))}
                      />
                      <span data-your-bet={yourBet} className="flex w-16 items-center justify-center gap-1 font-mono text-[11px] tabular-nums text-content/85">
                        <Coin />
                        {formatTokens(yourBet)}
                      </span>
                      <ActionButton
                        icon="plus"
                        label="More"
                        data-action="bet-up"
                        disabled={bet + min > bankroll.tokens}
                        onClick={() => setBet((value) => value + min)}
                      />
                      <ActionButton icon="deal" primary label="Deal" keyHint="Space" data-action="deal" onClick={dealNext} />
                    </div>
                  </>
                )
              ) : null}
            </div>
          </div>
        </div>
      </ShoeContext.Provider>
    </TableFrame>
  );
}
