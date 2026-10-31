import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { parseCards } from "./cards";
import { advance, applyAction, startHand, type PokerAction, type PokerState } from "./poker";
import { cardText, handScores, logAction, logBlinds, recapHand, type LoggedAction } from "./pokerRecap";

const NAMES = ["you", "Claude", "Codex"];

/** Three seats, you on the button; fixed hole cards and board. */
function rigged(stacks: number[], holes: string[], board: string): PokerState {
  const state = startHand(
    stacks.map((stack, index) => ({ id: `p${index}`, stack })),
    -1,
    5,
    10,
    seeded(1),
  );
  const [a, b, c, d, e] = parseCards(board);
  return {
    ...state,
    seats: state.seats.map((seat, index) => ({ ...seat, hole: parseCards(holes[index]!) })),
    // advance() pops: burn, three, burn, one, burn, one.
    deck: [e!, 0, d!, 0, c!, b!, a!, 0],
  };
}

/** Plays the actions in turn, dealing streets between them, and logs each. */
function play(start: PokerState, actions: PokerAction[]) {
  let state = start;
  const log: LoggedAction[] = logBlinds(start);
  for (const action of actions) {
    while (state.toAct < 0 && state.street !== "done") {
      state = advance(state);
    }
    log.push(logAction(state, action)!);
    state = applyAction(state, action);
  }
  while (state.street !== "done") {
    if (state.toAct >= 0) {
      throw new Error("The hand still wants an action");
    }
    state = advance(state);
  }
  return { state, log };
}

describe("hand recap", () => {
  it("tells each street and who won the showdown with what", () => {
    const start = rigged([1000, 1000, 1000], ["As Ad", "Ks Kd", "7c 2h"], "Ah 9c 4d 3s 8h");
    // Button 0, small blind 1, big blind 2; you act first preflop.
    expect(start.sbSeat).toBe(1);
    const { state, log } = play(start, [
      { type: "raise", to: 30 },
      { type: "call" },
      { type: "fold" },
      // Flop: Claude first, then you.
      { type: "check" },
      { type: "raise", to: 50 },
      { type: "call" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
    ]);
    const recap = recapHand(state, log, NAMES);
    expect(recap.streets).toEqual([
      "Preflop: blinds Claude 5, Codex 10, you raise to 30, Claude calls 25, Codex folds.",
      "Flop A♥ 9♣ 4♦: Claude checks, you bet 50, Claude calls 50.",
      "Turn 3♠: Claude checks, you check.",
      "River 8♥: Claude checks, you check.",
    ]);
    expect(recap.results).toEqual([
      "Pot 170: you win with three of a kind, beating Claude's pair.",
    ]);
  });

  it("shows every seat's hand at the end, folded ones too", () => {
    const start = rigged([1000, 1000, 1000], ["As Ad", "Ks Kd", "7c 7h"], "Ah 9c 4d 3s 8h");
    const { state } = play(start, [
      { type: "call" },
      { type: "fold" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
    ]);
    const scores = handScores(state);
    expect(Object.keys(scores).map(Number)).toEqual([0, 1, 2]);
    expect(scores[0]! > scores[2]!).toBe(true);
  });

  it("an uncontested hand says everyone else folded", () => {
    const start = rigged([1000, 1000, 1000], ["As Ad", "Ks Kd", "7c 2h"], "Ah 9c 4d 3s 8h");
    const { state, log } = play(start, [{ type: "raise", to: 40 }, { type: "fold" }, { type: "fold" }]);
    const recap = recapHand(state, log, NAMES);
    expect(recap.streets).toEqual([
      "Preflop: blinds Claude 5, Codex 10, you raise to 40, Claude folds, Codex folds.",
    ]);
    expect(recap.results).toEqual(["You take 55: everyone else folded."]);
    expect(handScores(state)).toEqual({});
  });

  it("an all-in runout lists the dealt streets, and a side pot and the change go back", () => {
    const start = rigged([200, 1000, 1000], ["As Ad", "Ks Kd", "Qs Qd"], "2h 9c 4d 3s 8h");
    const { state, log } = play(start, [
      { type: "raise", to: 200 },
      { type: "raise", to: 600 },
      { type: "raise", to: 1000 },
      { type: "call" },
    ]);
    const recap = recapHand(state, log, NAMES);
    expect(recap.streets[0]).toBe(
      "Preflop: blinds Claude 5, Codex 10, you go all in for 200, Claude raises to 600, Codex goes all in for 1k, Claude calls 400 (all in).",
    );
    expect(recap.streets.slice(1)).toEqual(["Flop 2♥ 9♣ 4♦.", "Turn 3♠.", "River 8♥."]);
    expect(recap.results).toEqual([
      "Main pot 600: you win with pair, beating Claude's pair on higher cards.",
      "Side pot 1.6k: Claude wins with pair, beating Codex's pair on higher cards.",
    ]);
  });

  it("a tie splits the pot", () => {
    const start = rigged([1000, 1000, 1000], ["2c 3d", "2d 3c", "7c 8h"], "As Ks Qs Js 9d");
    const { state, log } = play(start, [
      { type: "call" },
      { type: "call" },
      { type: "fold" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
      { type: "check" },
    ]);
    expect(recapHand(state, log, NAMES).results).toEqual(["Pot 30 split: you and Claude tie with high card."]);
  });

  it("a short blind shows what it really posted", () => {
    const start = rigged([1000, 1000, 6], ["As Ad", "Ks Kd", "7c 2h"], "Ah 9c 4d 3s 8h");
    const checks: PokerAction[] = Array.from({ length: 6 }, () => ({ type: "check" }));
    const { state, log } = play(start, [{ type: "call" }, { type: "call" }, ...checks]);
    expect(recapHand(state, log, NAMES).streets[0]).toBe(
      "Preflop: blinds Claude 5, Codex 6 (all in), you call 10, Claude calls 5.",
    );
  });

  it("a side pot fed by a folded seat is won, not only handed back", () => {
    const start = rigged([100, 1000, 1000], ["As Ad", "Ks Kd", "Qs Qd"], "2h 9c 4d 3s 8h");
    const { state, log } = play(start, [
      { type: "raise", to: 100 },
      { type: "raise", to: 300 },
      { type: "call" },
      { type: "raise", to: 200 },
      { type: "fold" },
    ]);
    expect(recapHand(state, log, NAMES).results).toEqual([
      "Pot 300: you win with pair, beating Claude's pair on higher cards.",
      "Side pot 600: Claude takes it, 200 of it unmatched chips back.",
    ]);
  });

  it("writes cards short", () => {
    expect(parseCards("Ts Ah 2c").map(cardText)).toEqual(["10♠", "A♥", "2♣"]);
  });
});
