import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { AGENTS, AGENT_IDS, defaultSeats, fillSeats, pickLine, type ChatterEvent } from "./agents";
import { formatTokens, rivalLine, rivalShares } from "./tokens";

const EVENTS: ChatterEvent[] = [
  "thinking",
  "fold",
  "check",
  "call",
  "raise",
  "allIn",
  "win",
  "lose",
  "bluffCaught",
  "bust",
  "blackjack",
  "hit",
  "stand",
  "double",
  "split",
  "chessCheck",
  "chessMove",
  "chessWin",
  "chessLose",
  "blunder",
  "resign",
  "drawOffer",
  "coworker",
];

describe("agents", () => {
  it("has lines for every moment, short enough for a bubble", () => {
    for (const id of AGENT_IDS) {
      for (const event of EVENTS) {
        const lines = AGENTS[id].lines[event];
        expect(lines.length, `${id} ${event}`).toBeGreaterThanOrEqual(3);
        expect(new Set(lines).size, `${id} ${event}`).toBe(lines.length);
        for (const line of lines) {
          expect(line.length, line).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  it("doesn't repeat itself back to back", () => {
    const random = seeded(1);
    let last: string | undefined;
    for (let i = 0; i < 100; i++) {
      const line = pickLine(AGENTS.codex, "fold", random, last);
      expect(line).not.toBe(last);
      last = line;
    }
  });

  it("seats four by default, and Kimi only fills a gap", () => {
    const seats = defaultSeats(seeded(4));
    expect(seats).toHaveLength(4);
    expect(new Set(seats).size).toBe(4);
    expect(seats).not.toContain("kimi");
    expect(fillSeats(["claude"], 2)).toEqual(["claude", "kimi"]);
    expect(fillSeats(["claude", "codex"], 2)).toEqual(["claude", "codex"]);
  });
});

describe("tokens", () => {
  it("formats amounts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12400)).toBe("12.4k");
    expect(formatTokens(3000)).toBe("3k");
    expect(formatTokens(-1500)).toBe("-1.5k");
  });

  it("says how you stand", () => {
    expect(rivalLine("Codex", 3200)).toBe("you're up 3.2k on Codex");
    expect(rivalLine("Grok", -500)).toBe("you're down 500 to Grok");
    expect(rivalLine("Muse", 0)).toBe("even with Muse");
  });

  it("splits your result across who paid for it", () => {
    expect(rivalShares(300, { a: -200, b: -100, c: 50 })).toEqual({ a: 200, b: 100 });
    expect(rivalShares(-300, { a: 200, b: 100, c: -50 })).toEqual({ a: -200, b: -100 });
    expect(rivalShares(0, { a: 10 })).toEqual({});
  });
});
