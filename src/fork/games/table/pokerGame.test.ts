import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { parseCards } from "./cards";
import { advance, applyAction, startHand, type PokerState } from "./poker";
import {
  blindsForHand,
  finishedStacks,
  gameOver,
  nextHandPlayers,
  resultLine,
  startGame,
  type PokerGame,
} from "./pokerGame";

const players = (...stacks: number[]) =>
  stacks.map((stack, index) => ({ id: `p${index}`, stack }));

const hand = (stacks: number[], button = -1, seed = 1) =>
  startHand(players(...stacks), button, 5, 10, seeded(seed));

function runOut(state: PokerState) {
  let next = state;
  while (next.street !== "done" && next.toAct < 0) {
    next = advance(next);
  }
  return next;
}

function fixedShowdown(
  stacks: number[],
  holes: string[],
  board: string,
  button = 0,
): PokerState {
  const state = hand(stacks, button - 1);
  const dealt = {
    ...state,
    seats: state.seats.map((item, index) => ({
      ...item,
      hole: parseCards(holes[index]!),
    })),
    // advance() pops: burn, three, burn, one, burn, one.
    deck: (() => {
      const [a, b, c, d, e] = parseCards(board);
      return [e!, 0, d!, 0, c!, b!, a!, 0];
    })(),
  };
  return dealt;
}

const game = (change: Partial<PokerGame>): PokerGame => ({
  hands: 1,
  buyIn: 5000,
  stacks: [5000, 5000],
  stakes: { small: 25, big: 50, noise: 0 },
  result: "playing",
  ...change,
});

describe("blinds", () => {
  const base = { small: 25, big: 50 };

  it("posts the base blinds for the first ten hands", () => {
    expect(blindsForHand(1, base)).toEqual({ small: 25, big: 50 });
    expect(blindsForHand(10, base)).toEqual({ small: 25, big: 50 });
  });

  it("doubles every ten hands", () => {
    expect(blindsForHand(11, base)).toEqual({ small: 50, big: 100 });
    expect(blindsForHand(12, base)).toEqual({ small: 50, big: 100 });
    expect(blindsForHand(20, base)).toEqual({ small: 50, big: 100 });
    expect(blindsForHand(21, base)).toEqual({ small: 100, big: 200 });
    expect(blindsForHand(31, base)).toEqual({ small: 200, big: 400 });
  });

  it("keeps the same answer for any hand in its block", () => {
    for (let hand = 1; hand <= 40; hand++) {
      expect(blindsForHand(hand, base)).toEqual(
        blindsForHand(Math.floor((hand - 1) / 10) * 10 + 1, base),
      );
    }
  });
});

describe("carried stacks", () => {
  it("starts you with one buy-in, capped at a full stack, and agents at the cap", () => {
    const stakes = { small: 25, big: 50, noise: 0 };
    expect(startGame(10_000, 3, stakes)).toEqual({
      hands: 0,
      buyIn: 5000,
      stakes,
      result: "playing",
      stacks: [5000, 5000, 5000, 5000],
    });
    expect(startGame(3000, 2, stakes).stacks).toEqual([3000, 5000, 5000]);
  });

  it("gives the next hand every seat's carried stack, busted seats included", () => {
    expect(nextHandPlayers("you", ["a", "b"], [1200, 0, 5000])).toEqual([
      { id: "you", stack: 1200 },
      { id: "a", stack: 0 },
      { id: "b", stack: 5000 },
    ]);
  });

  it("takes the stacks out of a settled hand", () => {
    expect(finishedStacks([{ stack: 1200 }, { stack: 0 }, { stack: 800 }])).toEqual([
      1200, 0, 800,
    ]);
  });
});

describe("ending a game", () => {
  it("is over when you have no chips left", () => {
    expect(gameOver([0, 300, 200])).toEqual({ over: true, winner: "agents" });
  });

  it("is over when nobody else has chips", () => {
    expect(gameOver([900, 0, 0])).toEqual({ over: true, winner: "you" });
  });

  it("goes on while two seats still have chips", () => {
    expect(gameOver([900, 0, 200])).toEqual({ over: false, winner: null });
  });

  it("says the result in one short line", () => {
    expect(resultLine(game({ result: "lost", hands: 23, stacks: [0, 5000] }))).toBe(
      "Busted after 23 hands",
    );
    expect(resultLine(game({ result: "lost", hands: 1, stacks: [0, 5000] }))).toBe(
      "Busted after 1 hand",
    );
    expect(
      resultLine(
        game({
          result: "won",
          hands: 31,
          stacks: [9200, 0, 0, 0, 0],
        }),
      ),
    ).toBe("You took the table: +4.2k in 31 hands");
    expect(
      resultLine(game({ result: "left", hands: 8, stacks: [8400, 5000] })),
    ).toBe("You left with 8.4k after 8 hands");
    expect(resultLine(game({ result: "playing" }))).toBe("");
  });
});

describe("whole games", () => {
  it("side pots can leave exactly one player with chips", () => {
    // You cover three shorter stacks; all four are all in and you win every pot.
    let state = fixedShowdown(
      [1000, 300, 200, 100],
      ["As Ad", "Ks Kd", "Qs Qd", "Js Jd"],
      "Ah 7c 2d 9s 4h",
      0,
    );
    expect(state.toAct).toBe(3);
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "raise", to: 1000 });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = runOut(state);

    expect(state.result!.pots.map((pot) => pot.amount)).toEqual([400, 300, 200, 700]);
    const stacks = finishedStacks(state.seats);
    expect(stacks).toEqual([1600, 0, 0, 0]);
    expect(stacks.filter((stack) => stack > 0)).toHaveLength(1);
    expect(gameOver(stacks)).toEqual({ over: true, winner: "you" });
  });

  it("an all-in can bust you and end the game", () => {
    let state = fixedShowdown(
      [500, 1000],
      ["2c 3d", "As Ad"],
      "Kh Qh 9c 7d 4s",
      0,
    );
    expect(state.toAct).toBe(0);
    state = applyAction(state, { type: "raise", to: 500 });
    state = applyAction(state, { type: "call" });
    state = runOut(state);

    const stacks = finishedStacks(state.seats);
    expect(stacks).toEqual([0, 1500]);
    expect(gameOver(stacks)).toEqual({ over: true, winner: "agents" });
    expect(
      resultLine(game({ result: "lost", hands: 7, stacks })),
    ).toBe("Busted after 7 hands");
  });
});
