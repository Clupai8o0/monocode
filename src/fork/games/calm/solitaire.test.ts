import { describe, expect, it } from "vitest";
import { makeCard, parseCard } from "../table/cards";
import {
  apply,
  autoMove,
  canAutoFinish,
  deal,
  drawStock,
  finishStep,
  isLegal,
  isWon,
  revive,
  undo,
  type SolState,
} from "./solitaire";

function count(state: SolState) {
  return state.stock.length + state.waste.length
    + state.foundations.flat().length + state.tableau.flat().length;
}

function empty(): SolState {
  return {
    tableau: [[], [], [], [], [], [], []],
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
    draw: 1,
    moves: 0,
    history: [],
  };
}

const up = (text: string) => ({ card: parseCard(text), up: true });

describe("solitaire", () => {
  it("deals 7 piles with the top card up and 24 in the stock", () => {
    const state = deal(5);
    expect(state.tableau.map((pile) => pile.length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(state.tableau.every((pile) => pile.at(-1)!.up && pile.slice(0, -1).every((s) => !s.up))).toBe(true);
    expect(state.stock).toHaveLength(24);
    expect(count(state)).toBe(52);
  });

  it("deals the same game from the same seed", () => {
    expect(deal(9)).toEqual(deal(9));
    expect(deal(9)).not.toEqual(deal(10));
  });

  it("draws one or three and recycles the waste", () => {
    let one = deal(1, 1);
    one = drawStock(one);
    expect(one.waste).toHaveLength(1);
    let three = deal(1, 3);
    three = drawStock(three);
    expect(three.waste).toHaveLength(3);
    for (let i = 0; i < 7; i++) {
      three = drawStock(three);
    }
    expect(three.stock).toHaveLength(0);
    const order = [...three.waste];
    three = drawStock(three);
    expect(three.waste).toHaveLength(0);
    expect(three.stock).toEqual(order.reverse());
  });

  it("stacks alternate colours one lower, and only kings on empty piles", () => {
    const state = empty();
    state.tableau[0] = [up("Ts")];
    state.tableau[1] = [up("9h")];
    state.tableau[2] = [up("9c")];
    state.tableau[3] = [up("Kd")];
    const move = (pile: number, dest: number) => ({ from: "tableau" as const, pile, index: 0, dest: { to: "tableau" as const, pile: dest } });
    expect(isLegal(state, move(1, 0))).toBe(true);
    expect(isLegal(state, move(2, 0))).toBe(false);
    expect(isLegal(state, move(1, 6))).toBe(false);
    expect(isLegal(state, move(3, 6))).toBe(true);
  });

  it("builds foundations by suit from the ace", () => {
    const state = empty();
    state.waste = [parseCard("2h"), parseCard("Ah")];
    const home = { from: "waste" as const, dest: { to: "foundation" as const } };
    let next = apply(state, home);
    expect(next.foundations[2]).toEqual([makeCard(14, 2)]);
    next = apply(next, home);
    expect(next.foundations[2]).toHaveLength(2);
    expect(next.moves).toBe(2);
  });

  it("moves a run and flips the card left behind", () => {
    const state = empty();
    state.tableau[0] = [{ card: parseCard("3c"), up: false }, up("8s"), up("7h")];
    state.tableau[1] = [up("9d")];
    const next = apply(state, { from: "tableau", pile: 0, index: 1, dest: { to: "tableau", pile: 1 } });
    expect(next.tableau[1]).toHaveLength(3);
    expect(next.tableau[0]).toEqual([up("3c")]);
  });

  it("leaves the state alone on an illegal move", () => {
    const state = deal(3);
    const next = apply(state, { from: "foundation", suit: 0, dest: { to: "tableau", pile: 0 } });
    expect(next).toBe(state);
  });

  it("undoes moves and draws", () => {
    const start = deal(4);
    const drawn = drawStock(start);
    const back = undo(drawn);
    expect(back.waste).toEqual(start.waste);
    expect(back.stock).toEqual(start.stock);
    expect(back.moves).toBe(0);
    expect(undo(start)).toBe(start);
  });

  it("auto-moves home first, else onto a pile", () => {
    const state = empty();
    state.waste = [parseCard("Ac")];
    expect(autoMove(state, { from: "waste" })?.dest).toEqual({ to: "foundation" });
    state.waste = [parseCard("7h")];
    state.tableau[4] = [up("8c")];
    expect(autoMove(state, { from: "waste" })?.dest).toEqual({ to: "tableau", pile: 4 });
    state.waste = [parseCard("5h")];
    expect(autoMove(state, { from: "waste" })).toBeNull();
  });

  it("doesn't shuffle a bottom king between empty piles", () => {
    const state = empty();
    state.tableau[0] = [up("Ks")];
    expect(autoMove(state, { from: "tableau", pile: 0, index: 0 })).toBeNull();
  });

  it("auto-finishes once everything is face up", () => {
    let state = empty();
    for (let suit = 0; suit < 4; suit++) {
      state.tableau[suit] = [];
      for (let rank = 13; rank >= 1; rank--) {
        state.tableau[suit]!.push({ card: makeCard(rank === 1 ? 14 : rank, suit), up: true });
      }
    }
    expect(canAutoFinish(state)).toBe(true);
    let steps = 0;
    while (!isWon(state)) {
      const next = finishStep(state);
      expect(next).not.toBeNull();
      state = next!;
      steps++;
    }
    expect(steps).toBe(52);
    expect(canAutoFinish(state)).toBe(false);
  });

  it("does not auto-finish with cards face down", () => {
    expect(canAutoFinish(deal(2))).toBe(false);
  });

  it("revives a saved game and rejects junk", () => {
    const state = drawStock(deal(8));
    expect(revive(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(revive({ tableau: [] })).toBeNull();
    expect(revive(null)).toBeNull();
  });
});
