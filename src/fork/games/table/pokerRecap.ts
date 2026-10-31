import { rankName, suitOf, type Card } from "./cards";
import { legalActions, type PokerAction, type PokerState, type Street } from "./poker";
import { evaluate, handCategory, handName } from "./pokerEval";
import { formatTokens } from "./tokens";

/**
 * Fork: what happened in a poker hand, in words. The table logs each action as
 * it is played; once the hand is over this turns the log and the result into a
 * few short lines: who did what on each street, and who took each pot and how.
 */

export type BettingStreet = Exclude<Street, "done">;

export type LoggedAction = {
  street: BettingStreet;
  seat: number;
  kind: "blind" | "fold" | "check" | "call" | "bet" | "raise";
  /** Chips a blind or call put in, or the raise-to. 0 for a fold or check. */
  amount: number;
  allIn: boolean;
};

/** The blinds as posted; a short stack posts less than the full blind. */
export function logBlinds(start: PokerState): LoggedAction[] {
  return [start.sbSeat, start.bbSeat].map((seat) => ({
    street: "preflop",
    seat,
    kind: "blind",
    amount: start.seats[seat]!.bet,
    allIn: start.seats[seat]!.allIn,
  }));
}

/** The log entry for a legal action, read before it is applied. */
export function logAction(state: PokerState, action: PokerAction): LoggedAction | null {
  if (state.toAct < 0 || state.street === "done") {
    return null;
  }
  const seat = state.toAct;
  const street = state.street;
  const legal = legalActions(state);
  if (action.type === "fold" || action.type === "check") {
    return { street, seat, kind: action.type, amount: 0, allIn: false };
  }
  if (action.type === "call") {
    const stack = state.seats[seat]!.stack;
    return {
      street,
      seat,
      kind: "call",
      amount: legal.callAmount,
      allIn: legal.callAmount >= stack,
    };
  }
  return {
    street,
    seat,
    kind: state.currentBet === 0 ? "bet" : "raise",
    amount: action.to,
    allIn: action.to >= legal.maxRaiseTo,
  };
}

const SUIT_MARKS = ["♣", "♦", "♥", "♠"];

export function cardText(card: Card) {
  return `${rankName(card)}${SUIT_MARKS[suitOf(card)]}`;
}

/**
 * Every dealt seat's best hand once there's a board to make one, folded seats
 * too, so the table can show what each player was holding.
 */
export function handScores(state: PokerState): Record<number, number> {
  const scores: Record<number, number> = {};
  if (state.board.length < 3) {
    return scores;
  }
  state.seats.forEach((seat, index) => {
    if (!seat.out && seat.hole.length > 0) {
      scores[index] = state.result?.shown[index] ?? evaluate([...seat.hole, ...state.board]);
    }
  });
  return scores;
}

const STREETS: { street: BettingStreet; name: string; from: number; to: number }[] = [
  { street: "preflop", name: "Preflop", from: 0, to: 0 },
  { street: "flop", name: "Flop", from: 0, to: 3 },
  { street: "turn", name: "Turn", from: 3, to: 4 },
  { street: "river", name: "River", from: 4, to: 5 },
];

function capital(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type Recap = {
  /** One line per street: the cards it dealt and what each seat did. */
  streets: string[];
  /** One line per pot: who took it, and with what. */
  results: string[];
};

/**
 * The hand in words. `names` is per seat index; seat 0 is you, written "you"
 * so the verbs read right ("you call", "Claude calls").
 */
export function recapHand(state: PokerState, log: readonly LoggedAction[], names: readonly string[]): Recap {
  const name = (seat: number) => (seat === 0 ? "you" : names[seat] ?? `seat ${seat}`);
  const verb = (seat: number, word: string) => (seat === 0 ? word : `${word}s`);
  const possessive = (seat: number) => (seat === 0 ? "your" : `${name(seat)}'s`);

  const spoken = (entry: LoggedAction) => {
    const who = name(entry.seat);
    const amount = formatTokens(entry.amount);
    if (entry.kind === "blind") {
      return `${who} ${amount}${entry.allIn ? " (all in)" : ""}`;
    }
    if (entry.kind === "fold" || entry.kind === "check") {
      return `${who} ${verb(entry.seat, entry.kind)}`;
    }
    if (entry.kind === "call") {
      return `${who} ${verb(entry.seat, "call")} ${amount}${entry.allIn ? " (all in)" : ""}`;
    }
    if (entry.allIn) {
      return `${who} ${entry.seat === 0 ? "go" : "goes"} all in for ${amount}`;
    }
    return entry.kind === "bet"
      ? `${who} ${verb(entry.seat, "bet")} ${amount}`
      : `${who} ${verb(entry.seat, "raise")} to ${amount}`;
  };

  const streets: string[] = [];
  for (const { street, name: label, from, to } of STREETS) {
    const cards = state.board.slice(from, to);
    const entries = log.filter((entry) => entry.street === street);
    const actions = entries.filter((entry) => entry.kind !== "blind").map(spoken);
    if (street === "preflop") {
      const blinds = entries.filter((entry) => entry.kind === "blind");
      const posted =
        blinds.length > 0
          ? blinds.map(spoken).join(", ")
          : `${name(state.sbSeat)} ${formatTokens(state.smallBlind)}, ${name(state.bbSeat)} ${formatTokens(state.bigBlind)}`;
      actions.unshift(`blinds ${posted}`);
    } else if (cards.length === 0) {
      continue;
    }
    const head = cards.length > 0 ? `${label} ${cards.map(cardText).join(" ")}` : label;
    streets.push(actions.length > 0 ? `${head}: ${actions.join(", ")}.` : `${head}.`);
  }

  const results: string[] = [];
  const result = state.result;
  if (!result) {
    return { streets, results };
  }
  const { pots, shown } = result;
  const contested = pots.filter((pot) => pot.eligible.length > 1);
  for (const pot of pots) {
    const amount = formatTokens(pot.amount);
    if (pot.eligible.length === 1) {
      const only = pot.eligible[0]!;
      if (contested.length === 0) {
        results.push(`${capital(name(only))} ${verb(only, "take")} ${amount}: everyone else folded.`);
        continue;
      }
      // Chips nobody matched go back; the rest of this pot came from seats that folded.
      const matched = Math.max(
        0,
        ...state.seats.flatMap((seat, index) => (index === only ? [] : [seat.total])),
      );
      const unmatched = Math.min(pot.amount, Math.max(0, state.seats[only]!.total - matched));
      const who = capital(name(only));
      if (unmatched >= pot.amount) {
        results.push(`${who} ${only === 0 ? "get" : "gets"} ${amount} back: nobody else could match it.`);
      } else if (unmatched > 0) {
        results.push(
          `Side pot ${amount}: ${name(only)} ${verb(only, "take")} it, ${formatTokens(unmatched)} of it unmatched chips back.`,
        );
      } else {
        results.push(`Side pot ${amount}: ${name(only)} ${verb(only, "take")} it, the others in it folded.`);
      }
      continue;
    }
    const label =
      contested.length === 1 ? "Pot" : pot === contested[0] ? "Main pot" : "Side pot";
    const winners = pot.winners;
    const best = shown[winners[0]!]!;
    if (winners.length > 1) {
      const who = winners.map(name).join(" and ");
      results.push(`${label} ${amount} split: ${who} tie with ${handName(best)}.`);
      continue;
    }
    const winner = winners[0]!;
    const runnerUp = pot.eligible
      .filter((seat) => seat !== winner)
      .sort((a, b) => shown[b]! - shown[a]!)[0];
    let beat = "";
    if (runnerUp !== undefined) {
      const theirs = shown[runnerUp]!;
      const closer = handCategory(theirs) === handCategory(best) ? " on higher cards" : "";
      beat = `, beating ${possessive(runnerUp)} ${handName(theirs)}${closer}`;
    }
    results.push(
      `${label} ${amount}: ${name(winner)} ${verb(winner, "win")} with ${handName(best)}${beat}.`,
    );
  }
  return { streets, results };
}
