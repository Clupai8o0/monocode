import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { freshDecks, parseCards, shuffle } from "./cards";
import { evaluate, handName } from "./pokerEval";

const score = (text: string) => evaluate(parseCards(text));
const name = (text: string) => handName(score(text));

describe("evaluate", () => {
  it("names every rank of hand", () => {
    expect(name("2c 5d 9h Js Ac 3d 7h")).toBe("high card");
    expect(name("2c 2d 9h Js Ac 3d 7h")).toBe("pair");
    expect(name("2c 2d 9h 9s Ac 3d 7h")).toBe("two pair");
    expect(name("2c 2d 2h 9s Ac 3d 7h")).toBe("three of a kind");
    expect(name("4c 5d 6h 7s 8c Kd Kh")).toBe("straight");
    expect(name("2h 5h 9h Jh Kh 3d 7c")).toBe("flush");
    expect(name("2c 2d 2h 9s 9c 3d 7h")).toBe("full house");
    expect(name("2c 2d 2h 2s Ac 3d 7h")).toBe("four of a kind");
    expect(name("4h 5h 6h 7h 8h Kd Kh")).toBe("straight flush");
  });

  it("orders the ranks", () => {
    const ladder = [
      "2c 5d 9h Js Ac",
      "2c 2d 9h Js Ac",
      "2c 2d 9h 9s Ac",
      "2c 2d 2h 9s Ac",
      "4c 5d 6h 7s 8c",
      "2h 5h 9h Jh Kh",
      "2c 2d 2h 9s 9c",
      "2c 2d 2h 2s Ac",
      "4h 5h 6h 7h 8h",
    ].map(score);
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
  });

  it("plays the ace low in the wheel, and only there", () => {
    const wheel = score("Ac 2d 3h 4s 5c");
    expect(handName(wheel)).toBe("straight");
    expect(wheel).toBeLessThan(score("2d 3h 4s 5c 6c"));
    expect(score("Ad Kh Qs Jc Tc")).toBeGreaterThan(score("9d Kh Qs Jc Tc"));
    expect(name("Qc Kd Ah 2s 3c")).toBe("high card");
    expect(name("Ah 2h 3h 4h 5h")).toBe("straight flush");
  });

  it("settles ties on kickers", () => {
    expect(score("Ac Ad Kh 9s 2c")).toBeGreaterThan(score("Ah As Qh Js Tc"));
    expect(score("9c 9d 4h 4s Ac")).toBeGreaterThan(score("9h 9s 4c 4d Kc"));
    expect(score("7c 7d 7h As Kc")).toBeGreaterThan(score("7c 7d 7h As Qc"));
    expect(score("Ah 9h 7h 4h 3h")).toBeGreaterThan(score("Ad 9d 7d 4d 2d"));
  });

  it("splits the pot when the board plays", () => {
    const board = "Ac Kd Qh Js Tc";
    expect(score(`2c 3d ${board}`)).toBe(score(`4h 5s ${board}`));
  });

  it("finds the best house from two sets of trips", () => {
    expect(score("Kc Kd Kh 9c 9d 9h 2s")).toBe(score("Kc Kd Kh 9c 9d"));
    expect(score("9c 9d 9h Ks Kd 2c 2s")).toBe(score("9c 9d 9h Ks Kd"));
  });

  it("agrees with trying all 21 fives from seven", () => {
    const random = seeded(7);
    for (let run = 0; run < 2000; run++) {
      const seven = shuffle(freshDecks(), random).slice(0, 7);
      let best = 0;
      for (let a = 0; a < 7; a++) {
        for (let b = a + 1; b < 7; b++) {
          best = Math.max(best, evaluate(seven.filter((_, i) => i !== a && i !== b)));
        }
      }
      expect(evaluate(seven)).toBe(best);
    }
  });
});
