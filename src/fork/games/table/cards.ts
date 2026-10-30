import type { Random } from "../kit";

/**
 * Fork: playing cards as small numbers, which keeps the hand evaluator and the
 * thousands of simulated deals cheap. A card is rank * 4 + suit, rank 2-14.
 */
export type Card = number;

export const SUITS = ["c", "d", "h", "s"] as const;
export type Suit = (typeof SUITS)[number];

export function makeCard(rank: number, suit: number): Card {
  return rank * 4 + suit;
}

export function rankOf(card: Card) {
  return card >> 2;
}

export function suitOf(card: Card) {
  return card & 3;
}

export function isRed(card: Card) {
  const suit = suitOf(card);
  return suit === 1 || suit === 2;
}

const RANK_NAMES: Record<number, string> = {
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export function rankName(card: Card) {
  const rank = rankOf(card);
  return RANK_NAMES[rank] ?? String(rank);
}

const SUIT_WORDS = ["clubs", "diamonds", "hearts", "spades"];

/** "A of spades", for screen readers and tests. */
export function cardLabel(card: Card) {
  return `${rankName(card)} of ${SUIT_WORDS[suitOf(card)]}`;
}

/** Reads "As", "Td", "2c": tests set up exact hands with it. */
export function parseCard(text: string): Card {
  const rank = "23456789TJQKA".indexOf(text[0]!) + 2;
  const suit = SUITS.indexOf(text[1] as Suit);
  if (rank < 2 || suit < 0) {
    throw new Error(`Not a card: ${text}`);
  }
  return makeCard(rank, suit);
}

export function parseCards(text: string): Card[] {
  return text.split(/\s+/).filter(Boolean).map(parseCard);
}

export function freshDecks(count = 1): Card[] {
  const cards: Card[] = [];
  for (let deck = 0; deck < count; deck++) {
    for (let rank = 2; rank <= 14; rank++) {
      for (let suit = 0; suit < 4; suit++) {
        cards.push(makeCard(rank, suit));
      }
    }
  }
  return cards;
}

export function shuffle<T>(items: T[], random: Random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const held = items[i]!;
    items[i] = items[j]!;
    items[j] = held;
  }
  return items;
}
