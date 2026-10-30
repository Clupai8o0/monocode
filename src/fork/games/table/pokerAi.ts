import type { Random } from "../kit";
import { freshDecks, type Card } from "./cards";
import { evaluate } from "./pokerEval";
import {
  legalActions,
  legalize,
  potTotal,
  type PokerAction,
  type PokerState,
} from "./poker";

/**
 * Fork: how an agent picks a move. It knows what a player would know: its own
 * cards, the board and the chips, never anyone else's cards. The personality
 * only bends how it reads the same honest numbers.
 */

export type PokerStyle = {
  /** Added to equity when deciding whether to stay in. */
  looseness: number;
  /** Chance of raising a hand that's good enough to. */
  aggression: number;
  /** Chance of raising with nothing. */
  bluff: number;
  /** Chance of shoving outright whenever a raise is allowed. */
  shove: number;
  /** Random wobble on how it reads its equity. */
  noise: number;
  /** Pot fraction it likes to raise. */
  sizing: number;
  /** How much a bad beat loosens it, 0-1. */
  tilt: number;
};

export type Skill = { noise: number };

/** Monte Carlo runs one slice at a time, so a table can yield between slices. */
export function* equityRuns(
  hole: readonly Card[],
  board: readonly Card[],
  opponents: number,
  runs: number,
  random: Random,
  sliceSize = 40,
): Generator<void, number> {
  const known = new Set<Card>([...hole, ...board]);
  const pool = freshDecks().filter((card) => !known.has(card));
  const needed = 5 - board.length + opponents * 2;
  const shared = new Array<Card>(7);
  const theirs = new Array<Card>(7);
  let score = 0;
  for (let run = 0; run < runs; run++) {
    // A partial shuffle: only the first `needed` cards get drawn.
    for (let i = 0; i < needed; i++) {
      const j = i + Math.floor(random() * (pool.length - i));
      const held = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = held;
    }
    let drawn = 0;
    shared.length = 0;
    shared.push(...board);
    while (shared.length < 5) {
      shared.push(pool[drawn++]!);
    }
    const mine = evaluate([...hole, ...shared]);
    let best = true;
    let ties = 1;
    for (let opponent = 0; opponent < opponents && best; opponent++) {
      theirs.length = 0;
      theirs.push(pool[drawn++]!, pool[drawn++]!, ...shared);
      const other = evaluate(theirs);
      if (other > mine) {
        best = false;
      } else if (other === mine) {
        ties += 1;
      }
    }
    if (best) {
      score += 1 / ties;
    }
    if ((run + 1) % sliceSize === 0) {
      yield;
    }
  }
  return runs > 0 ? score / runs : 0;
}

export function estimateEquity(
  hole: readonly Card[],
  board: readonly Card[],
  opponents: number,
  runs: number,
  random: Random,
) {
  const walk = equityRuns(hole, board, opponents, runs, random);
  let step = walk.next();
  while (!step.done) {
    step = walk.next();
  }
  return step.value;
}

export type Decision = { action: PokerAction; bluffing: boolean };

export function decidePoker(
  state: PokerState,
  style: PokerStyle,
  skill: Skill,
  equity: number,
  tilt: number,
  random: Random,
): Decision {
  const legal = legalActions(state);
  const pot = potTotal(state);
  const owed = legal.callAmount;
  const odds = owed > 0 ? owed / (pot + owed) : 0;
  const wobble = (style.noise + skill.noise) * (random() * 2 - 1);
  const read = equity + wobble + style.looseness + tilt * style.tilt * 0.15;

  const raiseTo = (fraction: number) => {
    const size = Math.max(state.minRaise, Math.floor(pot * fraction));
    return state.currentBet + size;
  };
  const raise = (fraction: number, bluffing = false): Decision => ({
    action: legalize(state, { type: "raise", to: raiseTo(fraction) }),
    bluffing,
  });
  const shove: Decision = {
    action: legalize(state, { type: "raise", to: legal.maxRaiseTo }),
    bluffing: equity < 0.35,
  };

  if (legal.canRaise) {
    if (random() < style.shove * (0.5 + tilt * style.tilt)) {
      return shove;
    }
    if (read > 0.62 && random() < 0.35 + style.aggression * 0.65) {
      return raise(style.sizing * (0.8 + random() * 0.6));
    }
    if (random() < style.bluff && read < 0.45) {
      return raise(style.sizing * (0.6 + random() * 0.8), true);
    }
  }
  if (legal.canCheck) {
    return { action: { type: "check" }, bluffing: false };
  }
  if (read >= odds) {
    return { action: { type: "call" }, bluffing: false };
  }
  return { action: { type: "fold" }, bluffing: false };
}
