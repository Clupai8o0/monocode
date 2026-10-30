import type { Random } from "../kit";
import { freshDecks, rankOf, shuffle, type Card } from "./cards";

/**
 * Fork: six-deck blackjack. The dealer stands on soft 17 and peeks for
 * blackjack, naturals pay 3:2, doubling is on the first two cards, one split
 * per seat, split aces get one card each. Bets come off the stack when placed
 * and winnings go back at settling, so the stack is always the true amount.
 */

export const DECKS = 6;
export const RESHUFFLE_AT = 0.75;

export type BjOutcome = "win" | "lose" | "push" | "blackjack" | "bust";

export type BjHand = {
  cards: Card[];
  bet: number;
  fromSplit: boolean;
  doubled: boolean;
  done: boolean;
  outcome: BjOutcome | null;
  /** Chips returned at settling, stake included. */
  paid: number;
};

export type BjSeat = {
  id: string;
  stack: number;
  hands: BjHand[];
};

export type BjPhase = "betting" | "playing" | "dealer" | "settled";

export type BjState = {
  shoe: Card[];
  shoeSize: number;
  seats: BjSeat[];
  dealer: Card[];
  phase: BjPhase;
  /** Seat and hand to act, while playing. */
  seat: number;
  hand: number;
  /** Set when this round's deal came off a fresh shoe. */
  reshuffled: boolean;
};

export type BjAction = "hit" | "stand" | "double" | "split";

export function newShoe(random: Random) {
  return shuffle(freshDecks(DECKS), random);
}

export function cardValue(card: Card) {
  const rank = rankOf(card);
  return rank === 14 ? 11 : Math.min(rank, 10);
}

/** The best total, and whether an ace still counts as 11. */
export function handTotal(cards: readonly Card[]) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardValue(card);
    if (rankOf(card) === 14) {
      aces += 1;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export function isBlackjack(hand: Pick<BjHand, "cards" | "fromSplit">) {
  return (
    !hand.fromSplit && hand.cards.length === 2 && handTotal(hand.cards).total === 21
  );
}

export function createTable(
  players: readonly { id: string; stack: number }[],
  random: Random,
): BjState {
  const shoe = newShoe(random);
  return {
    shoe,
    shoeSize: shoe.length,
    seats: players.map(({ id, stack }) => ({ id, stack, hands: [] })),
    dealer: [],
    phase: "betting",
    seat: -1,
    hand: 0,
    reshuffled: false,
  };
}

function freshHand(cards: Card[], bet: number, fromSplit = false): BjHand {
  return { cards, bet, fromSplit, doubled: false, done: false, outcome: null, paid: 0 };
}

function cloneSeats(seats: readonly BjSeat[]) {
  return seats.map((seat) => ({
    ...seat,
    hands: seat.hands.map((hand) => ({ ...hand, cards: hand.cards.slice() })),
  }));
}

/** Everyone's bet by seat index; 0 sits a round out. */
export function deal(
  state: BjState,
  bets: readonly number[],
  random: Random,
): BjState {
  let shoe = state.shoe.slice();
  let reshuffled = false;
  if (shoe.length <= state.shoeSize * (1 - RESHUFFLE_AT)) {
    shoe = newShoe(random);
    reshuffled = true;
  }
  const seats = cloneSeats(state.seats).map((seat, index) => {
    const bet = bets[index] ?? 0;
    if (bet > seat.stack) {
      throw new Error("Bet is more than the stack");
    }
    seat.stack -= bet;
    seat.hands = bet > 0 ? [freshHand([], bet)] : [];
    return seat;
  });
  const dealer: Card[] = [];
  for (let round = 0; round < 2; round++) {
    for (const seat of seats) {
      if (seat.hands[0]) {
        seat.hands[0].cards.push(shoe.pop()!);
      }
    }
    dealer.push(shoe.pop()!);
  }
  for (const seat of seats) {
    const hand = seat.hands[0];
    if (hand && isBlackjack(hand)) {
      hand.done = true;
    }
  }
  const next: BjState = {
    ...state,
    shoe,
    seats,
    dealer,
    phase: "playing",
    seat: -1,
    hand: 0,
    reshuffled,
  };
  // The dealer's peek: a natural ends the round before anyone can double into it.
  if (handTotal(dealer).total === 21) {
    return settle({ ...next, phase: "dealer" });
  }
  return moveOn(next, -1);
}

/** The next hand still to play after this seat, or on to the dealer. */
function moveOn(state: BjState, from: number): BjState {
  for (let index = Math.max(from, 0); index < state.seats.length; index++) {
    const hands = state.seats[index]!.hands;
    const open = hands.findIndex((hand) => !hand.done);
    if (open >= 0) {
      return { ...state, seat: index, hand: open };
    }
  }
  return { ...state, phase: "dealer", seat: -1, hand: 0 };
}

export function legalBj(state: BjState) {
  const seat = state.seats[state.seat];
  const hand = seat?.hands[state.hand];
  if (state.phase !== "playing" || !seat || !hand) {
    return { hit: false, stand: false, double: false, split: false };
  }
  const firstTwo = hand.cards.length === 2;
  return {
    hit: true,
    stand: true,
    double: firstTwo && seat.stack >= hand.bet,
    split:
      firstTwo &&
      seat.hands.length === 1 &&
      seat.stack >= hand.bet &&
      cardValue(hand.cards[0]!) === cardValue(hand.cards[1]!),
  };
}

/** Plays one action for the hand to act. Throws on an illegal one. */
export function applyBj(state: BjState, action: BjAction): BjState {
  const legal = legalBj(state);
  if (!legal[action]) {
    throw new Error(`Can't ${action} now`);
  }
  const shoe = state.shoe.slice();
  const seats = cloneSeats(state.seats);
  const seat = seats[state.seat]!;
  const hand = seat.hands[state.hand]!;
  const next: BjState = { ...state, shoe, seats };

  if (action === "stand") {
    hand.done = true;
  } else if (action === "hit" || action === "double") {
    if (action === "double") {
      seat.stack -= hand.bet;
      hand.bet *= 2;
      hand.doubled = true;
    }
    hand.cards.push(shoe.pop()!);
    const { total } = handTotal(hand.cards);
    hand.done = action === "double" || total >= 21;
  } else {
    seat.stack -= hand.bet;
    const [left, right] = hand.cards;
    const aces = rankOf(left!) === 14;
    const first = freshHand([left!, shoe.pop()!], hand.bet, true);
    const second = freshHand([right!, shoe.pop()!], hand.bet, true);
    // Split aces take their one card and that's it. So does a split 21.
    first.done = aces || handTotal(first.cards).total === 21;
    second.done = aces || handTotal(second.cards).total === 21;
    seat.hands = [first, second];
  }
  return moveOn(next, state.seat);
}

/** Whether the dealer has to draw at all: not when every hand is already decided. */
export function dealerMustDraw(state: BjState) {
  return state.seats.some((seat) =>
    seat.hands.some(
      (hand) => handTotal(hand.cards).total <= 21 && !isBlackjack(hand),
    ),
  );
}

/** One dealer step: takes a card, or settles once it stands. */
export function dealerStep(state: BjState): BjState {
  if (state.phase !== "dealer") {
    return state;
  }
  if (dealerMustDraw(state) && handTotal(state.dealer).total < 17) {
    const shoe = state.shoe.slice();
    return { ...state, shoe, dealer: [...state.dealer, shoe.pop()!] };
  }
  return settle(state);
}

function settle(state: BjState): BjState {
  const dealerTotal = handTotal(state.dealer).total;
  const dealerNatural = state.dealer.length === 2 && dealerTotal === 21;
  const seats = cloneSeats(state.seats);
  for (const seat of seats) {
    for (const hand of seat.hands) {
      const { total } = handTotal(hand.cards);
      const natural = isBlackjack(hand);
      if (total > 21) {
        hand.outcome = "bust";
        hand.paid = 0;
      } else if (natural && !dealerNatural) {
        hand.outcome = "blackjack";
        hand.paid = hand.bet + Math.floor((hand.bet * 3) / 2);
      } else if (dealerNatural) {
        hand.outcome = natural ? "push" : "lose";
        hand.paid = natural ? hand.bet : 0;
      } else if (dealerTotal > 21 || total > dealerTotal) {
        hand.outcome = "win";
        hand.paid = hand.bet * 2;
      } else if (total === dealerTotal) {
        hand.outcome = "push";
        hand.paid = hand.bet;
      } else {
        hand.outcome = "lose";
        hand.paid = 0;
      }
      hand.done = true;
      seat.stack += hand.paid;
    }
  }
  return { ...state, seats, phase: "settled", seat: -1, hand: 0 };
}

/** Net chips for a seat this round. */
export function seatNet(seat: BjSeat) {
  return seat.hands.reduce((sum, hand) => sum + hand.paid - hand.bet, 0);
}

/**
 * Basic strategy for six decks, dealer stands on soft 17, double after split.
 * `up` is the dealer's up card value, 2-11.
 */
export function basicStrategy(
  cards: readonly Card[],
  up: number,
  canDouble: boolean,
  canSplit: boolean,
): BjAction {
  const { total, soft } = handTotal(cards);
  if (canSplit) {
    const pair = cardValue(cards[0]!);
    const split =
      pair === 11 ||
      pair === 8 ||
      (pair === 9 && up !== 7 && up < 10) ||
      (pair === 7 && up <= 7) ||
      (pair === 6 && up <= 6) ||
      (pair === 4 && (up === 5 || up === 6)) ||
      ((pair === 2 || pair === 3) && up <= 7);
    if (split) {
      return "split";
    }
  }
  if (soft) {
    if (total >= 20) {
      return "stand";
    }
    if (total === 19) {
      return "stand";
    }
    if (total === 18) {
      if (canDouble && up >= 3 && up <= 6) {
        return "double";
      }
      return up >= 9 ? "hit" : "stand";
    }
    const low = total === 17 ? 3 : total >= 15 ? 4 : 5;
    return canDouble && up >= low && up <= 6 ? "double" : "hit";
  }
  if (total >= 17) {
    return "stand";
  }
  if (total >= 13) {
    return up <= 6 ? "stand" : "hit";
  }
  if (total === 12) {
    return up >= 4 && up <= 6 ? "stand" : "hit";
  }
  if (total === 11) {
    return canDouble && up !== 11 ? "double" : "hit";
  }
  if (total === 10) {
    return canDouble && up <= 9 ? "double" : "hit";
  }
  if (total === 9) {
    return canDouble && up >= 3 && up <= 6 ? "double" : "hit";
  }
  return "hit";
}

export type BjStyle =
  | "careful"
  | "basic"
  | "confident"
  | "splitter"
  | "doubler"
  | "dreamer"
  | "dealerLike";

/** What an agent does with its hand; always a legal action. */
export function decideBj(
  state: BjState,
  style: BjStyle,
  mistakes: number,
  random: Random,
): BjAction {
  const legal = legalBj(state);
  const hand = state.seats[state.seat]!.hands[state.hand]!;
  const up = cardValue(state.dealer[0]!);
  const { total, soft } = handTotal(hand.cards);
  const basic = basicStrategy(hand.cards, up, legal.double, legal.split);

  const pick = (): BjAction => {
    switch (style) {
      case "basic":
        return basic;
      case "careful":
        // Won't risk a bust on a stiff, and a double feels like a big commitment.
        if (!soft && total >= 15) {
          return "stand";
        }
        return basic === "double" && random() < 0.5 ? "hit" : basic;
      case "confident":
        if (!soft && total === 19 && random() < 0.7) {
          return "hit";
        }
        return basic;
      case "splitter":
        return legal.split && cardValue(hand.cards[0]!) === 10 ? "split" : basic;
      case "doubler":
        return legal.double ? "double" : basic;
      case "dreamer": {
        if (random() < 0.3) {
          return total < 21 && random() < 0.5 ? "hit" : "stand";
        }
        return basic;
      }
      case "dealerLike":
        return total < 17 ? "hit" : "stand";
    }
  };

  let action = pick();
  if (style !== "basic" && random() < mistakes) {
    action = total < 12 || random() < 0.5 ? "hit" : "stand";
  }
  if (!legal[action]) {
    action = action === "double" ? "hit" : basic;
    if (!legal[action]) {
      action = total >= 17 ? "stand" : "hit";
    }
  }
  return action;
}

/** An agent's opening bet, on the table's minimum steps. */
export function agentBet(
  style: BjStyle,
  stack: number,
  minBet: number,
  random: Random,
) {
  const steps: Record<BjStyle, number[]> = {
    careful: [1, 1, 1, 2],
    basic: [1, 1, 2, 2],
    confident: [2, 3, 5],
    splitter: [1, 2, 3],
    doubler: [2, 4, 8],
    dreamer: [1, 2, 3, 5],
    dealerLike: [1, 1, 2],
  };
  const options = steps[style];
  const bet = minBet * options[Math.floor(random() * options.length)]!;
  return Math.min(stack, bet);
}
