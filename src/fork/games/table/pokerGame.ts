import { formatTokens } from "./tokens";

/**
 * Fork: the rules of a whole poker game, above a single hand. One buy-in starts
 * the game; every hand after it carries the stacks on the table. Blinds double
 * every ten hands, so a game always ends. Nothing here draws or deals.
 */

/** A full buy-in is this many big blinds. */
export const STACK_BIGS = 100;
/** Blinds double once every this many hands. */
export const BLIND_HANDS = 10;

export type Stakes = { small: number; big: number; noise: number };
export type Blinds = { small: number; big: number };

export type GamePlayer = { id: string; stack: number };

/** Playing, or how the game ended. Leave is a game you walked away from. */
export type GameResult = "playing" | "won" | "lost" | "left";

export type PokerGame = {
  /** Hands dealt so far. */
  hands: number;
  /** Your stack when the game began, before the blinds. */
  buyIn: number;
  /** Every seat's stack, you first, ready for the next deal. */
  stacks: number[];
  /** Fixed when the game begins; a later difficulty change waits for the next. */
  stakes: Stakes;
  result: GameResult;
};

/**
 * The blinds for a hand number, starting at hand 1. Hands 1-10 post the base,
 * 11-20 double it, and so on.
 */
export function blindsForHand(hand: number, base: Blinds): Blinds {
  const doubles = Math.floor(Math.max(0, hand - 1) / BLIND_HANDS);
  const scale = 2 ** doubles;
  return { small: base.small * scale, big: base.big * scale };
}

/** The first deal: one buy-in for you, a full cap for every agent. */
export function startGame(tokens: number, agents: number, stakes: Stakes): PokerGame {
  const cap = stakes.big * STACK_BIGS;
  const buyIn = Math.min(tokens, cap);
  return {
    hands: 0,
    buyIn,
    stacks: [buyIn, ...Array.from({ length: agents }, () => cap)],
    stakes: { ...stakes },
    result: "playing",
  };
}

/** The next hand's players: every seat keeps the stack it ended the last hand with. */
export function nextHandPlayers(
  you: string,
  agentIds: readonly string[],
  stacks: readonly number[],
): GamePlayer[] {
  return [you, ...agentIds].map((id, index) => ({
    id,
    stack: Math.max(0, stacks[index] ?? 0),
  }));
}

/** Every seat's stack once a hand has settled; busted seats stay at nothing. */
export function finishedStacks(seats: readonly { stack: number }[]): number[] {
  return seats.map((seat) => Math.max(0, seat.stack));
}

export type GameOver = {
  over: boolean;
  /** "you" took every chip, "agents" took yours. */
  winner: "you" | "agents" | null;
};

/** A game is over when you have no chips, or nobody else does. */
export function gameOver(stacks: readonly number[]): GameOver {
  if (stacks.length === 0) {
    return { over: false, winner: null };
  }
  if (stacks[0]! <= 0) {
    return { over: true, winner: "agents" };
  }
  if (stacks.slice(1).every((stack) => stack <= 0)) {
    return { over: true, winner: "you" };
  }
  return { over: false, winner: null };
}

/** The one short line the table shows when a game is no longer playing. */
export function resultLine(game: PokerGame): string {
  const hands = `${game.hands} ${game.hands === 1 ? "hand" : "hands"}`;
  if (game.result === "lost") {
    return `Busted after ${hands}`;
  }
  if (game.result === "won") {
    const net = game.stacks[0]! - game.buyIn;
    return `You took the table: +${formatTokens(net)} in ${hands}`;
  }
  if (game.result === "left") {
    return `You left with ${formatTokens(game.stacks[0]!)} after ${hands}`;
  }
  return "";
}
