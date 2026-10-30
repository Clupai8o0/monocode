import type { Random } from "../kit";
import {
  BISHOP,
  KING,
  KNIGHT,
  PAWN,
  Position,
  QUEEN,
  ROOK,
  moveName,
  type Move,
} from "./chess";

/**
 * Fork: alpha-beta with piece-square tables. It runs in a worker; if there's no
 * worker it runs here with the same time cap. Personality bends what it picks
 * at the root, never the rules.
 */

export type ChessStyle = {
  /** Depth change from the mode's depth. */
  depthBonus: number;
  /** Random centipawns added to each root move. */
  noise: number;
  /** Centipawns a root capture or check is worth to it, on top of the search. */
  showoff: number;
  /** Chance of playing a move it hasn't really looked at. */
  blunder: number;
};

export type SearchRequest = {
  fen: string;
  /** Keys of the earlier positions, so it can see a repetition coming at the root. */
  keys?: string[];
  depth: number;
  maxMs: number;
  style: ChessStyle;
  seed: number;
};

export type SearchResult = {
  /** Move name, or "" with no legal moves. */
  move: string;
  /** From the mover's side, in centipawns. */
  score: number;
  depth: number;
  nodes: number;
  blundered: boolean;
};

const VALUE = [0, 100, 320, 330, 500, 900, 20000];
const MATE = 100000;

/** Tables read from white's side: index 0 is a8. Black mirrors them. */
const PST: Record<number, readonly number[]> = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30,
    20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5,
    -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0,
    0,
  ],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30,
    0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20,
    20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20,
    -40, -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0,
    5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10,
    0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20,
    -10, -10, -10, -10, -10, -10, -20,
  ],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0,
    -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0,
    0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5,
    5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5,
    5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10,
    -10, -20,
  ],
  [KING]: [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40,
    -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40,
    -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20,
    -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

/** From the side to move's point of view. */
export function evaluatePosition(position: Position) {
  let score = 0;
  const { board } = position;
  for (let square = 0; square < 64; square++) {
    const piece = board[square]!;
    if (!piece) {
      continue;
    }
    const kind = Math.abs(piece);
    if (piece > 0) {
      score += VALUE[kind]! + PST[kind]![square]!;
    } else {
      score -= VALUE[kind]! + PST[kind]![square ^ 56]!;
    }
  }
  return score * position.side;
}

class TimeUp extends Error {}

class Search {
  nodes = 0;
  constructor(
    private position: Position,
    private deadline: number,
  ) {}

  private tick() {
    this.nodes += 1;
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) {
      throw new TimeUp();
    }
  }

  private order(moves: Move[]) {
    const { board } = this.position;
    const weigh = (move: Move) => {
      const victim = Math.abs(board[move.to]!);
      const attacker = Math.abs(board[move.from]!);
      return (victim ? 10 * VALUE[victim]! - attacker : 0) + (move.promotion ? 800 : 0);
    };
    return moves.sort((a, b) => weigh(b) - weigh(a));
  }

  private quiescence(alpha: number, beta: number, depth: number): number {
    this.tick();
    const stand = evaluatePosition(this.position);
    if (stand >= beta || depth <= 0) {
      return stand;
    }
    let best = Math.max(alpha, stand);
    const moves = this.order(this.position.pseudoMoves(true));
    const mover = this.position.side;
    for (const move of moves) {
      this.position.make(move);
      if (this.position.inCheck(mover)) {
        this.position.unmake();
        continue;
      }
      const score = -this.quiescence(-beta, -best, depth - 1);
      this.position.unmake();
      if (score >= beta) {
        return score;
      }
      best = Math.max(best, score);
    }
    return best;
  }

  alphaBeta(depth: number, alpha: number, beta: number, ply: number): number {
    this.tick();
    if (this.position.halfmove >= 100) {
      return 0;
    }
    if (depth <= 0) {
      return this.quiescence(alpha, beta, 4);
    }
    const moves = this.order(this.position.legalMoves());
    if (moves.length === 0) {
      return this.position.inCheck() ? -MATE + ply : 0;
    }
    let best = alpha;
    for (const move of moves) {
      this.position.make(move);
      const score = -this.alphaBeta(depth - 1, -beta, -best, ply + 1);
      this.position.unmake();
      if (score >= beta) {
        return score;
      }
      best = Math.max(best, score);
    }
    return best;
  }
}

export function chooseMove(request: SearchRequest, random: Random): SearchResult {
  const position = new Position(request.fen);
  position.tracksKeys = false;
  const moves = position.legalMoves();
  if (moves.length === 0) {
    return { move: "", score: 0, depth: 0, nodes: 0, blundered: false };
  }

  const { style } = request;
  const deadline = Date.now() + request.maxMs;
  const search = new Search(position, deadline);
  const maxDepth = Math.max(1, request.depth + style.depthBonus);
  // One bend per root move, fixed up front so deeper passes rank it the same.
  const bends = new Map<Move, number>();
  for (const move of moves) {
    const capture = position.board[move.to] !== 0 || move.enPassant;
    position.make(move);
    const check = position.inCheck();
    position.unmake();
    bends.set(
      move,
      (random() - 0.5) * 2 * style.noise +
        (capture || check ? style.showoff : 0),
    );
  }
  const fullWindow = style.noise > 0 || style.showoff > 0;

  // Avoid repeating into a draw at the root unless the alternatives are worse.
  const seen = new Set(request.keys ?? []);

  let bestMove = moves[0]!;
  let bestScore = -Infinity;
  let reached = 0;
  let order = moves;
  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      let roundBest: Move | null = null;
      let roundScore = -Infinity;
      let roundTrue = -Infinity;
      let alpha = -MATE * 2;
      const scored = new Map<Move, number>();
      for (const move of order) {
        position.make(move);
        let score = -search.alphaBeta(depth - 1, -MATE * 2, -alpha, 1);
        const repeated = seen.size > 0 && seen.has(position.key());
        position.unmake();
        if (repeated) {
          score = Math.min(score, 0);
        }
        scored.set(move, score);
        const bent = score + (bends.get(move) ?? 0);
        if (bent > roundScore) {
          roundScore = bent;
          roundTrue = score;
          roundBest = move;
        }
        if (!fullWindow) {
          alpha = Math.max(alpha, score);
        }
      }
      if (roundBest) {
        bestMove = roundBest;
        bestScore = roundTrue;
        reached = depth;
        order = [...moves].sort(
          (a, b) => (scored.get(b) ?? -MATE) - (scored.get(a) ?? -MATE),
        );
      }
    } catch (error) {
      if (error instanceof TimeUp) {
        break;
      }
      throw error;
    }
    // Sure of a mate already: no deeper look will change the move.
    if (Math.abs(bestScore) > MATE - 1000) {
      break;
    }
  }

  // A blunder: any legal move that isn't the search's pick.
  let blundered = false;
  if (style.blunder > 0 && moves.length > 1 && random() < style.blunder) {
    const others = moves.filter((move) => move !== bestMove);
    const pick = others[Math.floor(random() * others.length)]!;
    bestMove = pick;
    blundered = true;
  }

  return {
    move: moveName(bestMove),
    score: bestScore,
    depth: reached,
    nodes: search.nodes,
    blundered,
  };
}

/**
 * After a search, whether the agent bows out or proposes a draw. Claude resigns
 * early and offers draws politely; the others only give up once it's hopeless.
 */
export function chessVerdict(
  id: string,
  score: number,
  ply: number,
  lastOffer: number,
  roll: number,
): "resign" | "offer" | null {
  const claude = id === "claude";
  if (score < (claude ? -600 : -1500) && ply > (claude ? 20 : 30)) {
    return "resign";
  }
  if (claude && ply > 30 && ply - lastOffer >= 20 && Math.abs(score) < 60 && roll < 0.25) {
    return "offer";
  }
  return null;
}

/** Finds a played move by name in a position's legal moves. */
export function findMove(position: Position, name: string): Move | null {
  return position.legalMoves().find((move) => moveName(move) === name) ?? null;
}

/** Depth by mode: low wanders between 1 and 2. */
export function modeDepth(mode: string, random: Random) {
  if (mode === "low") {
    return random() < 0.5 ? 1 : 2;
  }
  return mode === "hard" ? 4 : 3;
}
