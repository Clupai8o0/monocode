import type { Random } from "../kit";
import { freshDecks, shuffle, type Card } from "./cards";
import { evaluate } from "./pokerEval";

/**
 * Fork: no-limit Texas hold'em as a pure state machine. Every step returns a
 * new state; the table calls `applyAction` for a seat, then `advance` after a
 * beat whenever `toAct` is -1 and the hand isn't over, so it can pace the deal.
 * Personalities never reach this file: the cards and the chips stay honest.
 */

export type Street = "preflop" | "flop" | "turn" | "river" | "done";

export type PokerSeat = {
  id: string;
  stack: number;
  hole: Card[];
  /** In front of the seat on this street. */
  bet: number;
  /** Put in over the whole hand; side pots are cut from this. */
  total: number;
  folded: boolean;
  allIn: boolean;
  /** No chips when the hand began, so not dealt in. */
  out: boolean;
  acted: boolean;
  /** Spent once it acts, and given back only by a full raise. */
  mayRaise: boolean;
};

export type PotResult = {
  amount: number;
  /** Seats that could win it. One seat means nobody contested these chips. */
  eligible: number[];
  winners: number[];
  /** Chips per seat index. */
  payouts: Record<number, number>;
};

export type PokerResult = {
  pots: PotResult[];
  /** Seat -> hand score, only for hands shown at showdown. */
  shown: Record<number, number>;
  /** Net chips this hand, per seat index. */
  net: Record<number, number>;
};

export type PokerState = {
  seats: PokerSeat[];
  button: number;
  smallBlind: number;
  bigBlind: number;
  /** Seat that posted each blind, or -1. */
  sbSeat: number;
  bbSeat: number;
  deck: Card[];
  board: Card[];
  street: Street;
  /** Whose turn it is. -1 between streets and once the hand is over. */
  toAct: number;
  /** The amount to match on this street. */
  currentBet: number;
  /** The smallest legal raise on top of `currentBet`. */
  minRaise: number;
  result: PokerResult | null;
};

export type PokerAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  /** `to` is the seat's total bet on this street after raising. */
  | { type: "raise"; to: number };

export type Legal = {
  canCheck: boolean;
  /** Chips a call would actually put in. 0 when there's nothing to call. */
  callAmount: number;
  canRaise: boolean;
  /** Smallest raise-to allowed; below this only all-in is possible. */
  minRaiseTo: number;
  /** All in, as a raise-to. */
  maxRaiseTo: number;
};

export function nextLive(seats: readonly PokerSeat[], from: number) {
  for (let step = 1; step <= seats.length; step++) {
    const index = (from + step) % seats.length;
    if (!seats[index]!.out) {
      return index;
    }
  }
  return from;
}

function post(seat: PokerSeat, amount: number) {
  const paid = Math.min(amount, seat.stack);
  seat.stack -= paid;
  seat.bet += paid;
  seat.total += paid;
  if (seat.stack === 0) {
    seat.allIn = true;
  }
}

/** Deals a new hand. `button` is the last hand's button; it moves on one seat. */
export function startHand(
  players: readonly { id: string; stack: number }[],
  button: number,
  smallBlind: number,
  bigBlind: number,
  random: Random,
): PokerState {
  const seats: PokerSeat[] = players.map(({ id, stack }) => ({
    id,
    stack,
    hole: [],
    bet: 0,
    total: 0,
    folded: false,
    allIn: false,
    out: stack <= 0,
    acted: false,
    mayRaise: true,
  }));
  const live = seats.filter((seat) => !seat.out).length;
  if (live < 2) {
    throw new Error("A hand needs two players with chips");
  }
  const nextButton = nextLive(seats, button);
  // Heads-up the button posts the small blind and acts first before the flop.
  const sbSeat = live === 2 ? nextButton : nextLive(seats, nextButton);
  const bbSeat = nextLive(seats, sbSeat);
  post(seats[sbSeat]!, smallBlind);
  post(seats[bbSeat]!, bigBlind);

  const deck = shuffle(freshDecks(), random);
  // One at a time from the small blind round, as a real dealer does it.
  for (let round = 0; round < 2; round++) {
    let seat = sbSeat;
    for (let dealt = 0; dealt < live; dealt++) {
      seats[seat]!.hole.push(deck.pop()!);
      seat = nextLive(seats, seat);
    }
  }

  const state: PokerState = {
    seats,
    button: nextButton,
    smallBlind,
    bigBlind,
    sbSeat,
    bbSeat,
    deck,
    board: [],
    street: "preflop",
    toAct: -1,
    currentBet: bigBlind,
    minRaise: bigBlind,
    result: null,
  };
  state.toAct = firstToAct(state, bbSeat);
  return state;
}

function needsAction(state: PokerState, seat: PokerSeat) {
  return (
    !seat.out &&
    !seat.folded &&
    !seat.allIn &&
    (!seat.acted || seat.bet < state.currentBet)
  );
}

/** The next seat after `from` with something to do, or -1. */
function firstToAct(state: PokerState, from: number) {
  const { seats } = state;
  const inHand = seats.filter((seat) => !seat.out && !seat.folded);
  const canAct = inHand.filter((seat) => !seat.allIn);
  // Everyone else is all in and this seat has matched: no one left to bet with.
  if (
    canAct.length === 1 &&
    inHand.length > 1 &&
    canAct[0]!.bet >= state.currentBet
  ) {
    return -1;
  }
  for (let step = 1; step <= seats.length; step++) {
    const index = (from + step) % seats.length;
    if (needsAction(state, seats[index]!)) {
      return index;
    }
  }
  return -1;
}

export function legalActions(state: PokerState, index = state.toAct): Legal {
  const seat = state.seats[index]!;
  const owed = Math.max(0, state.currentBet - seat.bet);
  const maxRaiseTo = seat.bet + seat.stack;
  const minRaiseTo = state.currentBet + state.minRaise;
  const someoneToBet = state.seats.some(
    (other, at) => at !== index && !other.out && !other.folded && !other.allIn,
  );
  return {
    canCheck: owed === 0,
    callAmount: Math.min(owed, seat.stack),
    canRaise: seat.mayRaise && someoneToBet && maxRaiseTo > state.currentBet,
    minRaiseTo,
    maxRaiseTo,
  };
}

function cloneSeats(seats: readonly PokerSeat[]) {
  return seats.map((seat) => ({ ...seat, hole: seat.hole }));
}

export function potTotal(state: PokerState) {
  return state.seats.reduce((sum, seat) => sum + seat.total, 0);
}

/** A legal version of whatever was asked for; agents can't break the rules. */
export function legalize(state: PokerState, action: PokerAction): PokerAction {
  const legal = legalActions(state);
  if (action.type === "fold") {
    return legal.canCheck ? { type: "check" } : action;
  }
  if (action.type === "raise") {
    if (!legal.canRaise) {
      return legal.canCheck ? { type: "check" } : { type: "call" };
    }
    if (action.to >= legal.maxRaiseTo || legal.minRaiseTo >= legal.maxRaiseTo) {
      return { type: "raise", to: legal.maxRaiseTo };
    }
    return {
      type: "raise",
      to: Math.max(legal.minRaiseTo, Math.floor(action.to)),
    };
  }
  if (action.type === "check" && !legal.canCheck) {
    return { type: "call" };
  }
  if (action.type === "call" && legal.canCheck) {
    return { type: "check" };
  }
  return action;
}

/** Applies a legal action for the seat to act. Throws on an illegal one. */
export function applyAction(
  state: PokerState,
  action: PokerAction,
): PokerState {
  if (state.toAct < 0 || state.street === "done") {
    throw new Error("Nobody is to act");
  }
  const legal = legalActions(state);
  const seats = cloneSeats(state.seats);
  const seat = seats[state.toAct]!;
  const next: PokerState = { ...state, seats };

  if (action.type === "fold") {
    seat.folded = true;
  } else if (action.type === "check") {
    if (!legal.canCheck) {
      throw new Error("Can't check facing a bet");
    }
  } else if (action.type === "call") {
    if (legal.canCheck) {
      throw new Error("Nothing to call");
    }
    post(seat, legal.callAmount);
  } else {
    if (!legal.canRaise) {
      throw new Error("Can't raise here");
    }
    const to = action.to;
    const allIn = to === legal.maxRaiseTo;
    if (to > legal.maxRaiseTo || (to < legal.minRaiseTo && !allIn)) {
      throw new Error(`Illegal raise to ${to}`);
    }
    const raisedBy = to - state.currentBet;
    post(seat, to - seat.bet);
    next.currentBet = to;
    if (raisedBy >= state.minRaise) {
      // A full raise reopens the betting for everyone still in.
      next.minRaise = raisedBy;
      for (const other of seats) {
        other.mayRaise = true;
      }
    }
    // Short or not, everyone else has to answer it. A short one reopens nothing.
    for (const other of seats) {
      other.acted = false;
    }
  }
  seat.acted = true;
  seat.mayRaise = false;

  const inHand = seats.filter((other) => !other.out && !other.folded);
  if (inHand.length === 1) {
    return finish(next);
  }
  next.toAct = firstToAct(next, state.toAct);
  return next;
}

/** Between streets: deals the next one, or settles the hand after the river. */
export function advance(state: PokerState): PokerState {
  if (state.toAct >= 0 || state.street === "done") {
    return state;
  }
  if (state.street === "river") {
    return finish(state);
  }
  const deck = state.deck.slice();
  const count = state.street === "preflop" ? 3 : 1;
  const board = state.board.slice();
  deck.pop(); // The burn card.
  for (let i = 0; i < count; i++) {
    board.push(deck.pop()!);
  }
  const seats = cloneSeats(state.seats);
  for (const seat of seats) {
    seat.bet = 0;
    seat.acted = false;
    seat.mayRaise = true;
  }
  const next: PokerState = {
    ...state,
    seats,
    deck,
    board,
    street:
      state.street === "preflop"
        ? "flop"
        : state.street === "flop"
          ? "turn"
          : "river",
    currentBet: 0,
    minRaise: state.bigBlind,
    toAct: -1,
  };
  // Heads-up too, the first to act after the flop is left of the button.
  next.toAct = firstToAct(next, state.button);
  return next;
}

export type SidePot = { amount: number; eligible: number[] };

/** Cuts the chips into a main pot and side pots by what each seat put in. */
export function buildPots(seats: readonly PokerSeat[]): SidePot[] {
  const levels = [
    ...new Set(
      seats.filter((seat) => !seat.out && !seat.folded).map((seat) => seat.total),
    ),
  ].sort((a, b) => a - b);
  const pots: SidePot[] = [];
  let floor = 0;
  for (const level of levels) {
    let amount = 0;
    seats.forEach((seat) => {
      amount += Math.max(0, Math.min(seat.total, level) - floor);
    });
    const eligible = seats.flatMap((seat, index) =>
      !seat.out && !seat.folded && seat.total >= level ? [index] : [],
    );
    pots.push({ amount, eligible });
    floor = level;
  }
  // Chips a folded seat put in above every live seat's total.
  const leftover = seats.reduce(
    (sum, seat) => sum + Math.max(0, seat.total - floor),
    0,
  );
  if (leftover > 0 && pots.length > 0) {
    pots[pots.length - 1]!.amount += leftover;
  }
  return pots.filter((pot) => pot.amount > 0);
}

/** A pot split evenly, with odd chips going round from left of the button. */
function splitPot(
  amount: number,
  winners: readonly number[],
  button: number,
  seatCount: number,
) {
  const share = Math.floor(amount / winners.length);
  let odd = amount - share * winners.length;
  const payouts: Record<number, number> = {};
  for (const winner of winners) {
    payouts[winner] = share;
  }
  for (let step = 1; step <= seatCount && odd > 0; step++) {
    const index = (button + step) % seatCount;
    if (winners.includes(index)) {
      payouts[index]! += 1;
      odd -= 1;
    }
  }
  return payouts;
}

function finish(state: PokerState): PokerState {
  const seats = cloneSeats(state.seats);
  const inHand = seats.flatMap((seat, index) =>
    !seat.out && !seat.folded ? [index] : [],
  );
  const showdown = inHand.length > 1;
  const shown: Record<number, number> = {};
  if (showdown) {
    for (const index of inHand) {
      shown[index] = evaluate([...seats[index]!.hole, ...state.board]);
    }
  }
  const pots: PotResult[] = buildPots(seats).map(({ amount, eligible }) => {
    let winners = eligible;
    if (eligible.length > 1) {
      const top = Math.max(...eligible.map((index) => shown[index]!));
      winners = eligible.filter((index) => shown[index] === top);
    }
    const payouts = splitPot(amount, winners, state.button, seats.length);
    return { amount, eligible, winners, payouts };
  });
  const net: Record<number, number> = {};
  seats.forEach((seat, index) => {
    net[index] = 0 - seat.total;
  });
  for (const pot of pots) {
    for (const [index, chips] of Object.entries(pot.payouts)) {
      seats[Number(index)]!.stack += chips;
      net[Number(index)]! += chips;
    }
  }
  return {
    ...state,
    seats,
    street: "done",
    toAct: -1,
    result: { pots, shown, net },
  };
}
