import { describe, expect, it } from "vitest";
import { seeded } from "../seeded";
import { AGENTS, AGENT_IDS } from "./agents";
import {
  BLACK,
  Position,
  WHITE,
  gameStatus,
  moveName,
  perft,
  QUEEN,
  squareAt,
} from "./chess";
import { chessVerdict, chooseMove, findMove, modeDepth } from "./chessAi";

const KIWIPETE =
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

function play(position: Position, ...names: string[]) {
  for (const name of names) {
    const move = findMove(position, name);
    if (!move) {
      throw new Error(`Illegal in test: ${name} at ${position.fen()}`);
    }
    position.make(move);
  }
  return position;
}

describe("perft", () => {
  it("matches the start position", () => {
    const position = new Position();
    expect(perft(position, 1)).toBe(20);
    expect(perft(position, 2)).toBe(400);
    expect(perft(position, 3)).toBe(8902);
    expect(perft(position, 4)).toBe(197281);
  });

  it("matches kiwipete", () => {
    const position = new Position(KIWIPETE);
    expect(perft(position, 1)).toBe(48);
    expect(perft(position, 2)).toBe(2039);
    expect(perft(position, 3)).toBe(97862);
  });

  it("matches the standard promotion and en passant positions", () => {
    expect(perft(new Position("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"), 4)).toBe(43238);
    expect(
      perft(new Position("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1"), 3),
    ).toBe(9467);
    expect(perft(new Position("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8"), 3)).toBe(62379);
  });

  it("leaves the position as it found it", () => {
    const position = new Position(KIWIPETE);
    const before = position.fen();
    perft(position, 3);
    expect(position.fen()).toBe(before);
    expect(position.keys).toHaveLength(1);
  });
});

describe("rules", () => {
  it("round-trips a position through FEN", () => {
    expect(new Position(KIWIPETE).fen()).toBe(KIWIPETE);
  });

  it("castles both ways, and moves the rook", () => {
    const position = new Position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    play(position, "e1g1");
    expect(position.board[squareAt("f1")]).toBe(4);
    expect(position.board[squareAt("h1")]).toBe(0);
    play(position, "e8c8");
    expect(position.board[squareAt("d8")]).toBe(-4);
    expect(position.fen().split(" ")[2]).toBe("-");
  });

  it("refuses to castle out of, through or into check", () => {
    const through = new Position("4k3/8/8/8/8/5r2/8/4K2R w K - 0 1");
    expect(findMove(through, "e1g1")).toBeNull();
    const out = new Position("4k3/8/8/8/8/4r3/8/4K2R w K - 0 1");
    expect(findMove(out, "e1g1")).toBeNull();
    const into = new Position("4k3/8/8/8/8/6r1/8/4K2R w K - 0 1");
    expect(findMove(into, "e1g1")).toBeNull();
  });

  it("loses castling rights when the rook is captured", () => {
    const position = new Position("r3k2r/8/8/8/8/8/6B1/R3K2R w KQkq - 0 1");
    play(position, "g2a8");
    expect(position.fen().split(" ")[2]).toBe("KQk");
  });

  it("captures en passant, only right away", () => {
    const position = new Position("4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1");
    play(position, "d7d5");
    expect(position.fen().split(" ")[3]).toBe("d6");
    const taken = new Position(position.fen());
    play(taken, "e5d6");
    expect(taken.board[squareAt("d5")]).toBe(0);
    play(position, "e1e2", "e8e7");
    expect(findMove(position, "e5d6")).toBeNull();
  });

  it("won't capture en passant if that exposes the king", () => {
    const position = new Position("8/8/8/KPp4r/8/8/8/4k3 w - c6 0 1");
    expect(findMove(position, "b5c6")).toBeNull();
  });

  it("promotes to all four, and puts the pawn back on unmake", () => {
    const position = new Position("8/4P3/8/8/8/8/8/4K2k w - - 0 1");
    const names = position.legalMoves().map(moveName).filter((name) => name.startsWith("e7e8"));
    expect(names.sort()).toEqual(["e7e8b", "e7e8n", "e7e8q", "e7e8r"]);
    const move = findMove(position, "e7e8q")!;
    position.make(move);
    expect(position.board[squareAt("e8")]).toBe(QUEEN);
    position.unmake();
    expect(position.board[squareAt("e7")]).toBe(1);
  });
});

describe("how games end", () => {
  it("sees checkmate", () => {
    const position = play(new Position(), "f2f3", "e7e5", "g2g4", "d8h4");
    expect(gameStatus(position)).toEqual({ kind: "checkmate", winner: BLACK });
    const scholar = play(new Position(), "e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7");
    expect(gameStatus(scholar)).toEqual({ kind: "checkmate", winner: WHITE });
  });

  it("sees stalemate", () => {
    expect(gameStatus(new Position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).kind).toBe("stalemate");
  });

  it("sees insufficient material", () => {
    const kind = (fen: string) => gameStatus(new Position(fen)).kind;
    expect(kind("8/8/8/4k3/8/4K3/8/8 w - - 0 1")).toBe("insufficient");
    expect(kind("8/8/8/4k3/8/4KB2/8/8 w - - 0 1")).toBe("insufficient");
    expect(kind("8/8/8/4k3/8/4KN2/8/8 w - - 0 1")).toBe("insufficient");
    // Bishops on one colour can't mate; on opposite colours they could.
    expect(kind("8/8/8/2b1k3/8/4KB2/8/8 w - - 0 1")).toBe("playing");
    expect(kind("8/8/8/3bk3/8/4KB2/8/8 w - - 0 1")).toBe("insufficient");
    expect(kind("8/8/8/4k3/8/4KR2/8/8 w - - 0 1")).toBe("playing");
    expect(kind("8/8/8/4k3/8/3NKN2/8/8 w - - 0 1")).toBe("playing");
  });

  it("sees threefold repetition, not twofold", () => {
    const position = new Position();
    play(position, "g1f3", "g8f6", "f3g1", "f6g8");
    expect(gameStatus(position).kind).toBe("playing");
    play(position, "g1f3", "g8f6", "f3g1", "f6g8");
    expect(gameStatus(position).kind).toBe("threefold");
  });

  it("counts castling rights in repetition", () => {
    const position = new Position("4k2r/8/8/8/8/8/8/4K2R w Kk - 0 1");
    // The first visit has rights; later visits don't, so it isn't the same position.
    play(position, "h1g1", "h8g8", "g1h1", "g8h8");
    play(position, "h1g1", "h8g8", "g1h1", "g8h8");
    expect(gameStatus(position).kind).toBe("playing");
    play(position, "h1g1", "h8g8", "g1h1", "g8h8");
    expect(gameStatus(position).kind).toBe("threefold");
  });

  it("sees the 50-move draw, but mate on that move still wins", () => {
    expect(gameStatus(new Position("8/8/8/4k3/8/4KR2/8/8 w - - 100 80")).kind).toBe("fifty");
    expect(gameStatus(new Position("8/8/8/4k3/8/4KR2/8/8 w - - 99 80")).kind).toBe("playing");
    const mate = new Position("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 99 80");
    play(mate, "a1a8");
    expect(gameStatus(mate).kind).toBe("checkmate");
  });
});

const CALM = { depthBonus: 0, noise: 0, showoff: 0, blunder: 0 };
const ask = (fen: string, depth: number, seed = 1) =>
  chooseMove({ fen, depth, maxMs: 1500, style: CALM, seed }, seeded(seed));

describe("the engine", () => {
  it("finds mate in one", () => {
    expect(ask("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", 2).move).toBe("a1a8");
    expect(ask("r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1", 2).move).toBe("h5f7");
  });

  it("takes a hanging queen, and won't hang its own", () => {
    expect(ask("4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1", 3).move).toBe("e4d5");
    const defended = ask("4k3/8/2p5/3p4/8/8/3Q4/4K3 w - - 0 1", 3);
    expect(defended.move).not.toBe("d2d5");
  });

  it("stays inside the time cap at the deepest setting", () => {
    const start = Date.now();
    const result = chooseMove(
      { fen: KIWIPETE, depth: 6, maxMs: 200, style: CALM, seed: 1 },
      seeded(1),
    );
    expect(Date.now() - start).toBeLessThan(600);
    expect(result.move).not.toBe("");
  });

  it("repeats exactly from a seed", () => {
    const style = AGENTS.grok.chess;
    const request = { fen: KIWIPETE, depth: 2, maxMs: 60_000, style, seed: 9 };
    expect(chooseMove(request, seeded(9)).move).toBe(chooseMove(request, seeded(9)).move);
  });

  it("Grok prefers a capture when it's close", () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3";
    const showy = chooseMove(
      { fen, depth: 2, maxMs: 1500, style: { ...CALM, showoff: 90 }, seed: 1 },
      seeded(1),
    );
    expect(showy.move).toMatch(/^d4e5$/);
  });

  it("never plays an illegal move, for any agent, through whole games", () => {
    const random = seeded(21);
    for (const id of AGENT_IDS) {
      const position = new Position();
      for (let ply = 0; ply < 60; ply++) {
        if (gameStatus(position).kind !== "playing") {
          break;
        }
        const result = chooseMove(
          {
            fen: position.fen(),
            keys: position.keys,
            depth: modeDepth("low", random),
            maxMs: 200,
            style: AGENTS[id].chess,
            seed: Math.floor(random() * 1e9),
          },
          random,
        );
        const move = findMove(position, result.move);
        expect(move, `${id} at ${position.fen()}: ${result.move}`).not.toBeNull();
        position.make(move!);
      }
    }
  }, 60_000);
});

describe("how an agent bows out", () => {
  it("Claude resigns when lost and offers draws politely; others hang on longer", () => {
    expect(chessVerdict("claude", -700, 25, -100, 0.9)).toBe("resign");
    expect(chessVerdict("claude", -700, 15, -100, 0.9)).toBeNull();
    expect(chessVerdict("codex", -700, 25, -100, 0.9)).toBeNull();
    expect(chessVerdict("codex", -1600, 35, -100, 0.9)).toBe("resign");
    expect(chessVerdict("claude", 10, 40, -100, 0.1)).toBe("offer");
    expect(chessVerdict("claude", 10, 40, 30, 0.1)).toBeNull();
    expect(chessVerdict("claude", 200, 40, -100, 0.1)).toBeNull();
    expect(chessVerdict("grok", 10, 40, -100, 0.1)).toBeNull();
  });
});
