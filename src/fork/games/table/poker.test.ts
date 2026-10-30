import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { AGENTS, AGENT_IDS } from "./agents";
import { parseCards } from "./cards";
import {
  advance,
  applyAction,
  buildPots,
  legalActions,
  legalize,
  startHand,
  type PokerSeat,
  type PokerState,
} from "./poker";
import { decidePoker, estimateEquity } from "./pokerAi";

const players = (...stacks: number[]) =>
  stacks.map((stack, index) => ({ id: `p${index}`, stack }));

const hand = (stacks: number[], button = -1, seed = 1) =>
  startHand(players(...stacks), button, 5, 10, seeded(seed));

function seat(total: number, folded = false): PokerSeat {
  return {
    id: "x",
    stack: 0,
    hole: [],
    bet: 0,
    total,
    folded,
    allIn: false,
    out: false,
    acted: true,
    mayRaise: false,
  };
}

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

describe("blinds and order", () => {
  it("posts blinds left of the button, and the seat after acts first", () => {
    const state = hand([1000, 1000, 1000, 1000]);
    expect(state.button).toBe(0);
    expect(state.sbSeat).toBe(1);
    expect(state.bbSeat).toBe(2);
    expect(state.seats[1]!.bet).toBe(5);
    expect(state.seats[2]!.bet).toBe(10);
    expect(state.toAct).toBe(3);
  });

  it("heads-up the button posts the small blind and acts first preflop, last after", () => {
    const state = hand([1000, 1000]);
    expect(state.button).toBe(0);
    expect(state.sbSeat).toBe(0);
    expect(state.bbSeat).toBe(1);
    expect(state.toAct).toBe(0);
    let next = applyAction(state, { type: "call" });
    expect(next.toAct).toBe(1);
    next = applyAction(next, { type: "check" });
    expect(next.toAct).toBe(-1);
    next = advance(next);
    expect(next.street).toBe("flop");
    expect(next.board).toHaveLength(3);
    expect(next.toAct).toBe(1);
  });

  it("moves the button past a seat with no chips", () => {
    const state = hand([1000, 0, 1000, 1000], 0);
    expect(state.button).toBe(2);
    expect(state.seats[1]!.hole).toHaveLength(0);
    expect(state.seats[1]!.out).toBe(true);
  });

  it("gives the big blind its option", () => {
    let state = hand([1000, 1000, 1000]);
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    expect(state.toAct).toBe(state.bbSeat);
    expect(legalActions(state).canCheck).toBe(true);
    expect(legalActions(state).canRaise).toBe(true);
  });
});

describe("raises", () => {
  it("enforces the minimum raise, and tracks the last raise's size", () => {
    let state = hand([1000, 1000, 1000]);
    expect(legalActions(state).minRaiseTo).toBe(20);
    expect(() => applyAction(state, { type: "raise", to: 15 })).toThrow();
    state = applyAction(state, { type: "raise", to: 40 });
    expect(state.minRaise).toBe(30);
    expect(legalActions(state).minRaiseTo).toBe(70);
  });

  it("lets a short stack go all in below the minimum, without reopening the betting", () => {
    let state = hand([1000, 1000, 55]);
    // Seat 0 (button) raises to 40; the small blind calls; the big blind shoves 55.
    state = applyAction(state, { type: "raise", to: 40 });
    state = applyAction(state, { type: "call" });
    expect(state.toAct).toBe(2);
    expect(legalActions(state).minRaiseTo).toBe(70);
    expect(legalActions(state).maxRaiseTo).toBe(55);
    state = applyAction(state, { type: "raise", to: 55 });
    expect(state.currentBet).toBe(55);
    expect(state.minRaise).toBe(30);
    // Seat 0 has to answer it, but may not raise again.
    expect(state.toAct).toBe(0);
    expect(legalActions(state).canRaise).toBe(false);
    expect(legalActions(state).callAmount).toBe(15);
  });

  it("reopens the betting once short all-ins add up to a full raise", () => {
    let state = hand([1000, 1000, 150, 200, 1000], 3);
    expect(state.button).toBe(4);
    expect(state.toAct).toBe(2);
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "raise", to: 100 }); // The button, by 90.
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "raise", to: 150 }); // Seat 2 all in, +50.
    expect(state.minRaise).toBe(90);
    expect(state.toAct).toBe(3);
    state = applyAction(state, { type: "raise", to: 200 }); // Seat 3 all in, +50.
    // That's 100 since the full raise, so the button may raise again.
    expect(state.toAct).toBe(4);
    expect(legalActions(state).canRaise).toBe(true);
    expect(state.minRaise).toBe(90);
  });

  it("keeps the betting shut while short all-ins fall short of a full raise", () => {
    let state = hand([1000, 1000, 150, 1000, 1000], 3);
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "raise", to: 100 });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "raise", to: 150 });
    expect(state.toAct).toBe(3);
    expect(legalActions(state).canRaise).toBe(true); // Hasn't acted since the raise.
    state = applyAction(state, { type: "call" });
    expect(state.toAct).toBe(4);
    expect(legalActions(state).canRaise).toBe(false); // Raised already; only +50 since.
  });

  it("can't raise when nobody else can bet", () => {
    // Seat 0 has the button and the small blind, and shoves its whole stack.
    let state = hand([200, 1000]);
    state = applyAction(state, { type: "raise", to: 200 });
    expect(state.toAct).toBe(1);
    expect(legalActions(state).canRaise).toBe(false);
    expect(legalActions(state).callAmount).toBe(190);
  });

  it("legalize turns anything into something the engine accepts", () => {
    const state = hand([1000, 1000, 1000]);
    expect(legalize(state, { type: "check" })).toEqual({ type: "call" });
    expect(legalize(state, { type: "raise", to: 12 })).toEqual({ type: "raise", to: 20 });
    expect(legalize(state, { type: "raise", to: 99999 })).toEqual({ type: "raise", to: 1000 });
  });
});

describe("side pots", () => {
  it("cuts pots by what each seat put in", () => {
    const pots = buildPots([seat(100), seat(300), seat(500), seat(500)]);
    expect(pots).toEqual([
      { amount: 400, eligible: [0, 1, 2, 3] },
      { amount: 600, eligible: [1, 2, 3] },
      { amount: 400, eligible: [2, 3] },
    ]);
  });

  it("keeps a folded seat's chips in play, but it can't win them", () => {
    const pots = buildPots([seat(100, true), seat(300), seat(300)]);
    expect(pots).toEqual([{ amount: 700, eligible: [1, 2] }]);
  });

  it("adds chips a folded seat put in above every live total to the top pot", () => {
    const pots = buildPots([seat(500, true), seat(100), seat(100)]);
    expect(pots).toEqual([{ amount: 700, eligible: [1, 2] }]);
  });

  it("pays the short stack only the main pot, and returns an uncalled bet", () => {
    // Seat 1 has the best hand but only 100 in. Seat 2 beats seat 0 for the side.
    let state = fixedShowdown(
      [1000, 100, 500],
      ["2c 3d", "As Ad", "Ks Kd"],
      "7h 8h 9c Jd 4s",
      0,
    );
    state = applyAction(state, { type: "raise", to: 1000 });
    // Both short stacks call for less than the bet, which puts them all in.
    state = applyAction(state, { type: "call" });
    state = applyAction(state, { type: "call" });
    state = runOut(state);
    const result = state.result!;
    expect(state.street).toBe("done");
    expect(result.pots.map((pot) => pot.amount)).toEqual([300, 800, 500]);
    expect(result.pots[0]!.winners).toEqual([1]);
    expect(result.pots[1]!.winners).toEqual([2]);
    // Seat 0's extra 500 had no callers, and comes back.
    expect(result.pots[2]!.eligible).toEqual([0]);
    expect(state.seats.map((item) => item.stack)).toEqual([500, 300, 800]);
  });
});

describe("split pots and the odd chip", () => {
  it("gives the odd chip to the first winner left of the button", () => {
    // Blinds 5/10, 3 seats; everyone in for 10, plus a folded small blind's 5.
    let state = fixedShowdown(
      [100, 100, 100],
      ["2c 3d", "2s 3h", "2d 3c"],
      "Ac Kd Qh Js Tc",
      0,
    );
    state = applyAction(state, { type: "call" }); // button
    state = applyAction(state, { type: "fold" }); // small blind, 5 dead
    state = applyAction(state, { type: "check" }); // big blind
    for (let street = 0; street < 3; street++) {
      state = advance(state);
      state = applyAction(state, { type: "check" });
      state = applyAction(state, { type: "check" });
    }
    state = advance(state);
    const pot = state.result!.pots[0]!;
    expect(pot.amount).toBe(25);
    expect(pot.winners).toEqual([0, 2]);
    // Left of the button (seat 0): seat 1 folded, so seat 2 gets the extra chip.
    expect(pot.payouts).toEqual({ 0: 12, 2: 13 });
  });

  it("shows hands at showdown, and not when everyone folded", () => {
    let state = hand([100, 100, 100]);
    state = applyAction(state, { type: "fold" });
    state = applyAction(state, { type: "fold" });
    expect(state.street).toBe("done");
    expect(state.result!.shown).toEqual({});
    expect(state.seats[2]!.stack).toBe(105);
    expect(state.result!.net).toEqual({ 0: 0, 1: -5, 2: 5 });
  });
});

describe("whole hands", () => {
  it("never loses a chip or makes an illegal move, across every personality", () => {
    const random = seeded(99);
    const ids = AGENT_IDS;
    for (let run = 0; run < 400; run++) {
      const count = 2 + Math.floor(random() * 5);
      const stacks = Array.from({ length: count }, () =>
        1 + Math.floor(random() * 800),
      );
      const total = stacks.reduce((sum, value) => sum + value, 0);
      let state = startHand(players(...stacks), run % count, 5, 10, random);
      let guard = 0;
      while (state.street !== "done") {
        expect(guard++).toBeLessThan(200);
        if (state.toAct < 0) {
          state = advance(state);
          continue;
        }
        const seatNow = state.seats[state.toAct]!;
        const agent = AGENTS[ids[state.toAct % ids.length]!];
        const opponents = state.seats.filter(
          (item, index) => index !== state.toAct && !item.out && !item.folded,
        ).length;
        const equity = estimateEquity(seatNow.hole, state.board, opponents, 8, random);
        const { action } = decidePoker(
          state,
          agent.poker,
          { noise: 0.1 },
          equity,
          random(),
          random,
        );
        state = applyAction(state, action);
      }
      const after = state.seats.reduce((sum, item) => sum + item.stack, 0);
      expect(after).toBe(total);
      const net = Object.values(state.result!.net).reduce((sum, value) => sum + value, 0);
      expect(net).toBe(0);
      for (const item of state.seats) {
        expect(item.stack).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("repeats exactly from a seed", () => {
    const play = () => {
      const random = seeded(5);
      let state = startHand(players(500, 500, 500), -1, 5, 10, random);
      const trail: string[] = [];
      while (state.street !== "done") {
        if (state.toAct < 0) {
          state = advance(state);
          continue;
        }
        const seatNow = state.seats[state.toAct]!;
        const equity = estimateEquity(seatNow.hole, state.board, 2, 50, random);
        const { action } = decidePoker(state, AGENTS.grok.poker, { noise: 0 }, equity, 0, random);
        trail.push(JSON.stringify(action));
        state = applyAction(state, action);
      }
      return { trail, stacks: state.seats.map((item) => item.stack), board: state.board };
    };
    expect(play()).toEqual(play());
  });
});

describe("equity", () => {
  it("reads strong and weak hands sensibly", () => {
    const random = seeded(3);
    const aces = estimateEquity(parseCards("As Ad"), [], 1, 800, random);
    const rags = estimateEquity(parseCards("7c 2d"), [], 1, 800, random);
    expect(aces).toBeGreaterThan(0.78);
    expect(rags).toBeLessThan(0.42);
    const nuts = estimateEquity(parseCards("As Ks"), parseCards("Qs Js Ts 2d 3c"), 3, 100, random);
    expect(nuts).toBe(1);
  });

  it("Codex plays pot odds exactly", () => {
    const random = seeded(4);
    const state = hand([1000, 1000, 1000]);
    const raised = applyAction(state, { type: "raise", to: 500 });
    // 495 more to win 515+495: needs about 49%.
    const noRaise = { ...AGENTS.codex.poker, bluff: 0, aggression: 0 };
    const fold = decidePoker(raised, noRaise, { noise: 0 }, 0.3, 0, random);
    expect(fold.action.type).toBe("fold");
    const call = decidePoker(raised, noRaise, { noise: 0 }, 0.55, 0, () => 0.99);
    expect(call.action.type).toBe("call");
  });
});
