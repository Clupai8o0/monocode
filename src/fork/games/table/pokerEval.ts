import { rankOf, suitOf, type Card } from "./cards";

/**
 * Fork: best five cards out of five to seven. The score is a plain number: a
 * bigger score is a better hand, an equal score a split pot.
 */

export const HAND_NAMES = [
  "high card",
  "pair",
  "two pair",
  "three of a kind",
  "straight",
  "flush",
  "full house",
  "four of a kind",
  "straight flush",
] as const;

const BASE = 15;

function pack(category: number, ranks: readonly number[]) {
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * BASE + (ranks[i] ?? 0);
  }
  return score;
}

/** The top card of the best straight in a mask of rank bits, or 0. */
function straightHigh(mask: number) {
  for (let high = 14; high >= 6; high--) {
    if (((mask >> (high - 4)) & 0b11111) === 0b11111) {
      return high;
    }
  }
  // The wheel: the ace plays low, so the five is the top card.
  const wheel = (1 << 14) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
  return (mask & wheel) === wheel ? 5 : 0;
}

function topRanks(mask: number, count: number) {
  const ranks: number[] = [];
  for (let rank = 14; rank >= 2 && ranks.length < count; rank--) {
    if (mask & (1 << rank)) {
      ranks.push(rank);
    }
  }
  return ranks;
}

export function evaluate(cards: readonly Card[]): number {
  const counts = new Array<number>(15).fill(0);
  const suitMasks = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  let mask = 0;
  for (const card of cards) {
    const rank = rankOf(card);
    const suit = suitOf(card);
    counts[rank]! += 1;
    suitMasks[suit]! |= 1 << rank;
    suitCounts[suit]! += 1;
    mask |= 1 << rank;
  }

  const flushSuit = suitCounts.findIndex((count) => count >= 5);
  if (flushSuit >= 0) {
    const high = straightHigh(suitMasks[flushSuit]!);
    if (high) {
      return pack(8, [high]);
    }
  }

  let quads = 0;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let rank = 14; rank >= 2; rank--) {
    const count = counts[rank]!;
    if (count === 4) {
      quads = rank;
    } else if (count === 3) {
      trips.push(rank);
    } else if (count === 2) {
      pairs.push(rank);
    }
  }

  if (quads) {
    return pack(7, [quads, ...topRanks(mask & ~(1 << quads), 1)]);
  }
  if (trips.length > 0 && trips.length + pairs.length > 1) {
    // A second set of trips can fill the house, and can beat the best pair.
    const pair = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return pack(6, [trips[0]!, pair]);
  }
  if (flushSuit >= 0) {
    return pack(5, topRanks(suitMasks[flushSuit]!, 5));
  }
  const straight = straightHigh(mask);
  if (straight) {
    return pack(4, [straight]);
  }
  if (trips.length > 0) {
    const set = trips[0]!;
    return pack(3, [set, ...topRanks(mask & ~(1 << set), 2)]);
  }
  if (pairs.length >= 2) {
    const [high, low] = [pairs[0]!, pairs[1]!];
    return pack(2, [high, low, ...topRanks(mask & ~(1 << high) & ~(1 << low), 1)]);
  }
  if (pairs.length === 1) {
    const pair = pairs[0]!;
    return pack(1, [pair, ...topRanks(mask & ~(1 << pair), 3)]);
  }
  return pack(0, topRanks(mask, 5));
}

export function handCategory(score: number) {
  return Math.floor(score / BASE ** 5);
}

export function handName(score: number) {
  return HAND_NAMES[handCategory(score)]!;
}
