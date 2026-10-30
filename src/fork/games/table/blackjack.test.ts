import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { AGENTS, AGENT_IDS } from "./agents";
import {
  agentBet,
  applyBj,
  basicStrategy,
  createTable,
  deal,
  dealerStep,
  decideBj,
  handTotal,
  legalBj,
  seatNet,
  type BjState,
} from "./blackjack";
import { parseCard, parseCards } from "./cards";

/**
 * A table whose shoe deals these cards in order. One seat: its first card, the
 * dealer's up card, its second, the dealer's hole card, then draws.
 */
function rigged(cards: string, stack = 1000, seats = 1): BjState {
  const table = createTable(
    Array.from({ length: seats }, (_, index) => ({ id: `p${index}`, stack })),
    seeded(1),
  );
  const order = parseCards(cards).reverse();
  const padding = new Array<number>(200).fill(parseCard("2c"));
  return { ...table, shoe: [...padding, ...order] };
}

const finish = (state: BjState) => {
  let next = state;
  while (next.phase === "dealer") {
    next = dealerStep(next);
  }
  return next;
};

describe("totals", () => {
  it("counts aces as 11 until that busts", () => {
    expect(handTotal(parseCards("As 9d"))).toEqual({ total: 20, soft: true });
    expect(handTotal(parseCards("As 9d 5c"))).toEqual({ total: 15, soft: false });
    expect(handTotal(parseCards("As Ad"))).toEqual({ total: 12, soft: true });
    expect(handTotal(parseCards("Ks Qd"))).toEqual({ total: 20, soft: false });
  });
});

describe("payouts", () => {
  it("pays blackjack 3:2", () => {
    const state = deal(rigged("As 9d Kc 7h"), [100], seeded(1));
    expect(state.seats[0]!.hands[0]!.done).toBe(true);
    const done = finish(state);
    expect(done.seats[0]!.hands[0]!.outcome).toBe("blackjack");
    expect(done.seats[0]!.stack).toBe(1150);
  });

  it("pushes blackjack against a dealer blackjack, ending the round at the peek", () => {
    const state = deal(rigged("As Ad Kc Kd"), [100], seeded(1));
    expect(state.phase).toBe("settled");
    expect(state.seats[0]!.hands[0]!.outcome).toBe("push");
    expect(state.seats[0]!.stack).toBe(1000);
  });

  it("takes only the bet when the dealer peeks a blackjack", () => {
    const state = deal(rigged("9s Ad 9c Kd"), [100], seeded(1));
    expect(state.phase).toBe("settled");
    expect(state.seats[0]!.stack).toBe(900);
    expect(seatNet(state.seats[0]!)).toBe(-100);
  });

  it("returns the bet on a push and pays even money on a win", () => {
    let state = deal(rigged("Ks Td Qc 9h"), [100], seeded(1));
    state = finish(applyBj(state, "stand"));
    expect(state.seats[0]!.hands[0]!.outcome).toBe("win");
    expect(state.seats[0]!.stack).toBe(1100);
    state = deal(rigged("Ks Td Qc Th"), [100], seeded(1));
    state = finish(applyBj(state, "stand"));
    expect(state.seats[0]!.hands[0]!.outcome).toBe("push");
    expect(state.seats[0]!.stack).toBe(1000);
  });

  it("loses a bust whatever the dealer does", () => {
    let state = deal(rigged("Ks Td 6c 6h Qs"), [100], seeded(1));
    state = finish(applyBj(state, "hit"));
    expect(state.seats[0]!.hands[0]!.outcome).toBe("bust");
    expect(state.seats[0]!.stack).toBe(900);
    // The only hand is gone, so the dealer doesn't draw.
    expect(state.dealer).toHaveLength(2);
  });
});

describe("dealer", () => {
  it("stands on soft 17", () => {
    let state = deal(rigged("Ks Ad 8c 6h"), [100], seeded(1));
    state = finish(applyBj(state, "stand"));
    expect(handTotal(state.dealer)).toEqual({ total: 17, soft: true });
    expect(state.dealer).toHaveLength(2);
    expect(state.seats[0]!.hands[0]!.outcome).toBe("win");
  });

  it("draws to 17", () => {
    let state = deal(rigged("Ks 5d Tc 6h 2s 4d"), [100], seeded(1));
    state = finish(applyBj(state, "stand"));
    expect(handTotal(state.dealer).total).toBe(17);
    expect(state.dealer).toHaveLength(4);
  });
});

describe("double and split", () => {
  it("doubles on the first two cards only, for one card", () => {
    let state = deal(rigged("6s Td 5c 9h Ks"), [100], seeded(1));
    expect(legalBj(state).double).toBe(true);
    state = applyBj(state, "double");
    expect(state.phase).toBe("dealer");
    const done = finish(state);
    expect(done.seats[0]!.hands[0]!.bet).toBe(200);
    expect(done.seats[0]!.stack).toBe(1200);

    let hit = deal(rigged("2s Td 3c 9h 4s"), [100], seeded(1));
    hit = applyBj(hit, "hit");
    expect(legalBj(hit).double).toBe(false);
    expect(() => applyBj(hit, "double")).toThrow();
  });

  it("won't double or split without the chips", () => {
    const state = deal(rigged("8s Td 8c 9h", 150), [100], seeded(1));
    expect(legalBj(state).double).toBe(false);
    expect(legalBj(state).split).toBe(false);
  });

  it("splits once, and each hand plays on", () => {
    let state = deal(rigged("8s Td 8c 7h 3d Kh 8d 9s"), [100], seeded(1));
    expect(legalBj(state).split).toBe(true);
    state = applyBj(state, "split");
    const seat = state.seats[0]!;
    expect(seat.hands).toHaveLength(2);
    expect(seat.stack).toBe(800);
    expect(state.hand).toBe(0);
    // A second split isn't allowed, even with another pair.
    expect(legalBj(state).split).toBe(false);
  });

  it("gives split aces one card each, and a split 21 isn't a blackjack", () => {
    let state = deal(rigged("As Td Ac 7h Kd 5s"), [100], seeded(1));
    state = applyBj(state, "split");
    expect(state.phase).toBe("dealer");
    const done = finish(state);
    const [first, second] = done.seats[0]!.hands;
    expect(first!.cards).toHaveLength(2);
    expect(second!.cards).toHaveLength(2);
    expect(first!.outcome).toBe("win");
    // Even money on the 21, a loss on the 16.
    expect(second!.outcome).toBe("lose");
    expect(done.seats[0]!.stack).toBe(1000);
  });

  it("splits tens by value", () => {
    const state = deal(rigged("Ks Td Qc 7h"), [100], seeded(1));
    expect(legalBj(state).split).toBe(true);
  });
});

describe("the shoe", () => {
  it("is six decks and reshuffles once 75% has gone", () => {
    const table = createTable([{ id: "a", stack: 1000 }], seeded(2));
    expect(table.shoe).toHaveLength(312);
    const low = { ...table, shoe: table.shoe.slice(0, 78) };
    const dealt = deal(low, [10], seeded(3));
    expect(dealt.reshuffled).toBe(true);
    expect(dealt.shoe.length).toBeGreaterThan(300);
    const above = { ...table, shoe: table.shoe.slice(0, 79) };
    expect(deal(above, [10], seeded(3)).reshuffled).toBe(false);
  });
});

describe("agents", () => {
  it("Codex follows the chart", () => {
    const pick = (cards: string, up: number, canDouble = true, canSplit = false) =>
      basicStrategy(parseCards(cards), up, canDouble, canSplit);
    expect(pick("Ts 6d", 10)).toBe("hit");
    expect(pick("Ts 6d", 6)).toBe("stand");
    expect(pick("Ts 2d", 3)).toBe("hit");
    expect(pick("Ts 2d", 4)).toBe("stand");
    expect(pick("6s 5d", 10)).toBe("double");
    expect(pick("6s 5d", 11)).toBe("hit");
    expect(pick("As 7d", 3)).toBe("double");
    expect(pick("As 7d", 2)).toBe("stand");
    expect(pick("As 7d", 9)).toBe("hit");
    expect(pick("8s 8d", 10, true, true)).toBe("split");
    expect(pick("As Ad", 11, true, true)).toBe("split");
    expect(pick("Ts Td", 6, true, true)).toBe("stand");
    expect(pick("9s 9d", 7, true, true)).toBe("stand");
    expect(pick("9s 9d", 8, true, true)).toBe("split");
    expect(pick("5s 5d", 6, true, true)).toBe("double");
  });

  it("each plays its quirk", () => {
    const tens = deal(rigged("Ks 9d Qc 7h 2c 3c 4c 5c"), [100], seeded(1));
    expect(decideBj(tens, "splitter", 0, () => 0.9)).toBe("split");
    const nineteen = deal(rigged("Ks 9d 9c 7h"), [100], seeded(1));
    expect(decideBj(nineteen, "confident", 0, () => 0.1)).toBe("hit");
    expect(decideBj(tens, "doubler", 0, () => 0.9)).toBe("double");
  });

  it("never picks an illegal action, and chips add up, over many rounds", () => {
    const random = seeded(12);
    const ids = AGENT_IDS.slice(0, 4);
    let state = createTable(
      ids.map((id) => ({ id, stack: 100_000 })),
      random,
    );
    for (let round = 0; round < 500; round++) {
      const before = state.seats.map((seat) => seat.stack);
      const bets = ids.map((id, index) =>
        agentBet(AGENTS[id].blackjack, state.seats[index]!.stack, 100, random),
      );
      state = deal(state, bets, random);
      let guard = 0;
      while (state.phase === "playing") {
        expect(guard++).toBeLessThan(40);
        const id = ids[state.seat]!;
        const action = decideBj(state, AGENTS[id].blackjack, 0.2, random);
        expect(legalBj(state)[action]).toBe(true);
        state = applyBj(state, action);
      }
      state = finish(state);
      expect(state.phase).toBe("settled");
      state.seats.forEach((seat, index) => {
        expect(seat.stack).toBe(before[index]! + seatNet(seat));
        expect(seat.hands.length).toBeLessThanOrEqual(2);
      });
    }
  });

  it("repeats exactly from a seed", () => {
    const play = () => {
      const random = seeded(8);
      let state = createTable([{ id: "codex", stack: 5000 }], random);
      for (let round = 0; round < 50; round++) {
        state = deal(state, [100], random);
        while (state.phase === "playing") {
          state = applyBj(state, decideBj(state, "basic", 0, random));
        }
        state = finish(state);
      }
      return state.seats[0]!.stack;
    };
    expect(play()).toBe(play());
  });
});
