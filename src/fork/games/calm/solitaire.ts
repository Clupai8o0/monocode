import { seeded } from "../seeded";
import { freshDecks, isRed, rankOf, shuffle, suitOf, type Card } from "../table/cards";

/** Fork: patience on Klondike rules. Pure: every move returns a new state. */

export type Slot = { card: Card; up: boolean };

export type Board = {
  tableau: Slot[][];
  stock: Card[];
  waste: Card[];
  /** One per suit, by suit index. */
  foundations: Card[][];
  draw: 1 | 3;
  moves: number;
};

export type SolState = Board & { history: Board[] };

export type From =
  | { from: "waste" }
  | { from: "tableau"; pile: number; index: number }
  | { from: "foundation"; suit: number };

export type To = { to: "foundation" } | { to: "tableau"; pile: number };

export type Move = From & { dest: To };

const HISTORY_CAP = 300;

/** The nth item from the end (1 is the last). */
export function last<T>(items: readonly T[] | undefined, n: number): T | undefined
{
  return items ? items[items.length - n] : undefined;
}

/** Ace is low here: 1-13. */
export function solRank(card: Card) {
  const rank = rankOf(card);
  return rank === 14 ? 1 : rank;
}

export function deal(seed: number, draw: 1 | 3 = 1): SolState {
  const deck = shuffle(freshDecks(1), seeded(seed));
  const tableau: Slot[][] = [];
  for (let pile = 0; pile < 7; pile++) {
    const cards: Slot[] = [];
    for (let i = 0; i <= pile; i++) {
      cards.push({ card: deck.pop()!, up: i === pile });
    }
    tableau.push(cards);
  }
  return {
    tableau,
    stock: deck,
    waste: [],
    foundations: [[], [], [], []],
    draw,
    moves: 0,
    history: [],
  };
}

function board(state: SolState): Board {
  const { history: _history, ...rest } = state;
  return rest;
}

function clone(state: Board): Board {
  return {
    ...state,
    tableau: state.tableau.map((pile) => pile.map((slot) => ({ ...slot }))),
    stock: [...state.stock],
    waste: [...state.waste],
    foundations: state.foundations.map((pile) => [...pile]),
  };
}

function push(before: SolState, next: Board): SolState {
  const history = [...before.history, board(before)];
  if (history.length > HISTORY_CAP) {
    history.shift();
  }
  return { ...next, history };
}

/** The cards a source would pick up, top of the run last. */
export function picked(state: Board, source: From): Card[] {
  if (source.from === "waste") {
    const top = last(state.waste, 1);
    return top === undefined ? [] : [top];
  }
  if (source.from === "foundation") {
    const top = last(state.foundations[source.suit], 1);
    return top === undefined ? [] : [top];
  }
  const pile = state.tableau[source.pile];
  if (!pile || source.index < 0 || source.index >= pile.length || !pile[source.index]!.up) {
    return [];
  }
  return pile.slice(source.index).map((slot) => slot.card);
}

export function canOnTableau(state: Board, cards: Card[], pile: number) {
  const first = cards[0];
  const target = state.tableau[pile];
  if (first === undefined || !target) {
    return false;
  }
  const top = last(target, 1);
  if (!top) {
    return solRank(first) === 13;
  }
  return top.up && isRed(top.card) !== isRed(first) && solRank(top.card) === solRank(first) + 1;
}

export function canOnFoundation(state: Board, cards: Card[]) {
  if (cards.length !== 1) {
    return false;
  }
  const card = cards[0]!;
  const pile = state.foundations[suitOf(card)]!;
  return solRank(card) === pile.length + 1;
}

export function isLegal(state: Board, move: Move) {
  const cards = picked(state, move);
  if (cards.length === 0) {
    return false;
  }
  if (move.dest.to === "foundation") {
    return move.from !== "foundation" && canOnFoundation(state, cards);
  }
  if (move.from === "tableau" && move.pile === move.dest.pile) {
    return false;
  }
  return canOnTableau(state, cards, move.dest.pile);
}

/** Applies a legal move; an illegal one returns the state unchanged. */
export function apply(state: SolState, move: Move): SolState {
  if (!isLegal(state, move)) {
    return state;
  }
  const next = clone(state);
  const cards = picked(next, move);
  if (move.from === "waste") {
    next.waste.pop();
  } else if (move.from === "foundation") {
    next.foundations[move.suit]!.pop();
  } else {
    const pile = next.tableau[move.pile]!;
    pile.splice(move.index);
    const top = last(pile, 1);
    if (top && !top.up) {
      top.up = true;
    }
  }
  if (move.dest.to === "foundation") {
    next.foundations[suitOf(cards[0]!)]!.push(cards[0]!);
  } else {
    next.tableau[move.dest.pile]!.push(...cards.map((card) => ({ card, up: true })));
  }
  next.moves += 1;
  return push(state, next);
}

/** Draws from the stock, or turns the waste back over when it's empty. */
export function drawStock(state: SolState): SolState {
  if (state.stock.length === 0 && state.waste.length === 0) {
    return state;
  }
  const next = clone(state);
  if (next.stock.length === 0) {
    next.stock = [...next.waste].reverse();
    next.waste = [];
  } else {
    for (let i = 0; i < next.draw && next.stock.length > 0; i++) {
      next.waste.push(next.stock.pop()!);
    }
  }
  next.moves += 1;
  return push(state, next);
}

export function undo(state: SolState): SolState {
  const prior = last(state.history, 1);
  if (!prior) {
    return state;
  }
  return { ...prior, history: state.history.slice(0, -1) };
}

/** Where a click sends a card: home first, else a pile that frees a card, else any pile. */
export function autoMove(state: Board, source: From): Move | null {
  const cards = picked(state, source);
  if (cards.length === 0) {
    return null;
  }
  if (source.from !== "foundation") {
    const home: Move = { ...source, dest: { to: "foundation" } };
    if (isLegal(state, home)) {
      return home;
    }
  }
  const options: Move[] = [];
  for (let pile = 0; pile < 7; pile++) {
    const move: Move = { ...source, dest: { to: "tableau", pile } };
    if (isLegal(state, move)) {
      options.push(move);
    }
  }
  // A king already at the bottom of its pile gains nothing from an empty one.
  const useful = options.filter((move) => {
    if (source.from !== "tableau" || source.index !== 0 || move.dest.to !== "tableau") {
      return true;
    }
    return state.tableau[move.dest.pile]!.length > 0;
  });
  return useful.find((move) => move.dest.to === "tableau" && state.tableau[move.dest.pile]!.length > 0)
    ?? useful[0]
    ?? null;
}

export function isWon(state: Board) {
  return state.foundations.every((pile) => pile.length === 13);
}

/** Every card is face up and the stock is spent: the rest plays itself. */
export function canAutoFinish(state: Board) {
  return !isWon(state)
    && state.stock.length === 0
    && state.waste.length <= 1
    && state.tableau.every((pile) => pile.every((slot) => slot.up));
}

/** One step of the finish: the lowest card that can go home. */
export function finishStep(state: SolState): SolState | null {
  let best: Move | null = null;
  let low = 99;
  const sources: From[] = [{ from: "waste" }];
  state.tableau.forEach((pile, index) => {
    if (pile.length > 0) {
      sources.push({ from: "tableau", pile: index, index: pile.length - 1 });
    }
  });
  for (const source of sources) {
    const move: Move = { ...source, dest: { to: "foundation" } };
    const card = picked(state, source)[0];
    if (card !== undefined && isLegal(state, move) && solRank(card) < low) {
      best = move;
      low = solRank(card);
    }
  }
  return best ? apply(state, best) : null;
}

/** Reads a saved game back, or null when it isn't one. */
export function revive(value: unknown): SolState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as SolState;
  const ok = Array.isArray(state.tableau) && state.tableau.length === 7
    && Array.isArray(state.stock) && Array.isArray(state.waste)
    && Array.isArray(state.foundations) && state.foundations.length === 4
    && (state.draw === 1 || state.draw === 3) && typeof state.moves === "number";
  if (!ok) {
    return null;
  }
  const count = state.stock.length + state.waste.length
    + state.foundations.reduce((sum, pile) => sum + pile.length, 0)
    + state.tableau.reduce((sum, pile) => sum + pile.length, 0);
  if (count !== 52) {
    return null;
  }
  return { ...state, history: Array.isArray(state.history) ? state.history : [] };
}
