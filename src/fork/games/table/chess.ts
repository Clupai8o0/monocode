/**
 * Fork: chess rules, written for this panel with no dependency. A position is
 * a 64-square board (a8 is 0, h1 is 63) changed in place by `make` and put back
 * by `unmake`, which keeps perft and the engine fast. The perft numbers in the
 * test are what prove the move generator.
 */

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export type Side = 1 | -1;
export const WHITE: Side = 1;
export const BLACK: Side = -1;

/** Piece on a square: positive is white, negative black. */
export type Piece = number;

export type Move = {
  from: number;
  to: number;
  promotion: number;
  castle: boolean;
  enPassant: boolean;
};

type Undo = {
  move: Move;
  captured: Piece;
  castling: number;
  ep: number;
  halfmove: number;
};

const WK = 1;
const WQ = 2;
const BK = 4;
const BQ = 8;

const KNIGHT_STEPS = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
] as const;
const DIAGONALS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;
const STRAIGHTS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
const ALL_WAYS = [...DIAGONALS, ...STRAIGHTS];

const PIECE_LETTERS = " pnbrqk";

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function squareName(square: number) {
  return `${"abcdefgh"[square & 7]}${8 - (square >> 3)}`;
}

export function squareAt(name: string) {
  const file = name.charCodeAt(0) - 97;
  const rank = 8 - Number(name[1]);
  return rank * 8 + file;
}

/** A move in the plain form tests and the move list use: "e2e4", "e7e8q". */
export function moveName(move: Move) {
  const promotion = move.promotion ? PIECE_LETTERS[move.promotion] : "";
  return `${squareName(move.from)}${squareName(move.to)}${promotion}`;
}

export class Position {
  board = new Int8Array(64);
  side: Side = WHITE;
  castling = 0;
  /** En passant target square, or -1. */
  ep = -1;
  halfmove = 0;
  fullmove = 1;
  /** Keys of every position so far, for threefold repetition. */
  keys: string[] = [];
  history: Undo[] = [];
  /** Off during search: `keys` only matters for moves really played. */
  tracksKeys = true;

  constructor(fen = START_FEN) {
    const [placement, side, castling, ep, halfmove, fullmove] = fen.split(" ");
    let square = 0;
    for (const char of placement!) {
      if (char === "/") {
        continue;
      }
      const empties = Number(char);
      if (empties) {
        square += empties;
        continue;
      }
      const kind = PIECE_LETTERS.indexOf(char.toLowerCase());
      this.board[square] = char === char.toLowerCase() ? -kind : kind;
      square += 1;
    }
    this.side = side === "b" ? BLACK : WHITE;
    for (const char of castling ?? "") {
      this.castling |=
        char === "K" ? WK : char === "Q" ? WQ : char === "k" ? BK : char === "q" ? BQ : 0;
    }
    this.ep = ep && ep !== "-" ? squareAt(ep) : -1;
    this.halfmove = Number(halfmove ?? 0);
    this.fullmove = Number(fullmove ?? 1);
    this.keys.push(this.key());
  }

  fen() {
    const rows: string[] = [];
    for (let rank = 0; rank < 8; rank++) {
      let row = "";
      let gap = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this.board[rank * 8 + file]!;
        if (!piece) {
          gap += 1;
          continue;
        }
        if (gap) {
          row += gap;
          gap = 0;
        }
        const letter = PIECE_LETTERS[Math.abs(piece)]!;
        row += piece > 0 ? letter.toUpperCase() : letter;
      }
      rows.push(gap ? row + gap : row);
    }
    const castling =
      (this.castling & WK ? "K" : "") +
      (this.castling & WQ ? "Q" : "") +
      (this.castling & BK ? "k" : "") +
      (this.castling & BQ ? "q" : "");
    return [
      rows.join("/"),
      this.side === WHITE ? "w" : "b",
      castling || "-",
      this.ep >= 0 ? squareName(this.ep) : "-",
      this.halfmove,
      this.fullmove,
    ].join(" ");
  }

  /** What makes two positions "the same" for repetition, per the laws of chess. */
  key() {
    // The en passant square only counts when the capture is really playable.
    const liveEp = this.ep >= 0 && this.hasLegalEnPassant();
    return `${this.board.join(",")}|${this.side}|${this.castling}|${liveEp ? this.ep : -1}`;
  }

  private hasLegalEnPassant() {
    return this.legalMoves().some((move) => move.enPassant);
  }

  private kingSquare(side: Side) {
    return this.board.indexOf(side * KING);
  }

  /** Is this square attacked by `by`? */
  attacked(square: number, by: Side) {
    const { board } = this;
    const rank = square >> 3;
    const file = square & 7;
    // White pawns attack up the board (toward lower indexes).
    const pawnRank = rank + by;
    if (pawnRank >= 0 && pawnRank < 8) {
      for (const df of [-1, 1]) {
        const pawnFile = file + df;
        if (
          pawnFile >= 0 &&
          pawnFile < 8 &&
          board[pawnRank * 8 + pawnFile] === by * PAWN
        ) {
          return true;
        }
      }
    }
    for (const [dr, df] of KNIGHT_STEPS) {
      const r = rank + dr;
      const f = file + df;
      if (r >= 0 && r < 8 && f >= 0 && f < 8 && board[r * 8 + f] === by * KNIGHT) {
        return true;
      }
    }
    for (const [dr, df] of ALL_WAYS) {
      const diagonal = dr !== 0 && df !== 0;
      let r = rank + dr;
      let f = file + df;
      let distance = 1;
      while (r >= 0 && r < 8 && f >= 0 && f < 8) {
        const piece = board[r * 8 + f]!;
        if (piece) {
          if (Math.sign(piece) === by) {
            const kind = Math.abs(piece);
            if (
              kind === QUEEN ||
              (diagonal ? kind === BISHOP : kind === ROOK) ||
              (kind === KING && distance === 1)
            ) {
              return true;
            }
          }
          break;
        }
        r += dr;
        f += df;
        distance += 1;
      }
    }
    return false;
  }

  inCheck(side: Side = this.side) {
    return this.attacked(this.kingSquare(side), -side as Side);
  }

  /** Moves by the pieces' own rules, which may still leave the king in check. */
  pseudoMoves(capturesOnly = false): Move[] {
    const moves: Move[] = [];
    const { board, side } = this;
    const add = (from: number, to: number) =>
      moves.push({ from, to, promotion: 0, castle: false, enPassant: false });
    for (let from = 0; from < 64; from++) {
      const piece = board[from]!;
      if (!piece || Math.sign(piece) !== side) {
        continue;
      }
      const kind = Math.abs(piece);
      const rank = from >> 3;
      const file = from & 7;
      if (kind === PAWN) {
        const forward = -side;
        const startRank = side === WHITE ? 6 : 1;
        const lastRank = side === WHITE ? 0 : 7;
        const pushRank = rank + forward;
        const pawnTo = (to: number) => {
          if (pushRank === lastRank) {
            for (const promotion of [QUEEN, ROOK, BISHOP, KNIGHT]) {
              moves.push({ from, to, promotion, castle: false, enPassant: false });
            }
          } else {
            add(from, to);
          }
        };
        const ahead = pushRank * 8 + file;
        if (!capturesOnly && board[ahead] === EMPTY) {
          pawnTo(ahead);
          if (rank === startRank && board[ahead + forward * 8] === EMPTY) {
            add(from, ahead + forward * 8);
          }
        }
        for (const df of [-1, 1]) {
          const f = file + df;
          if (f < 0 || f > 7) {
            continue;
          }
          const to = pushRank * 8 + f;
          const target = board[to]!;
          if (target && Math.sign(target) !== side) {
            pawnTo(to);
          } else if (to === this.ep) {
            moves.push({ from, to, promotion: 0, castle: false, enPassant: true });
          }
        }
        continue;
      }
      if (kind === KNIGHT || kind === KING) {
        const steps = kind === KNIGHT ? KNIGHT_STEPS : ALL_WAYS;
        for (const [dr, df] of steps) {
          const r = rank + dr;
          const f = file + df;
          if (r < 0 || r > 7 || f < 0 || f > 7) {
            continue;
          }
          const to = r * 8 + f;
          const target = board[to]!;
          if (target ? Math.sign(target) !== side : !capturesOnly) {
            add(from, to);
          }
        }
        continue;
      }
      const ways =
        kind === BISHOP ? DIAGONALS : kind === ROOK ? STRAIGHTS : ALL_WAYS;
      for (const [dr, df] of ways) {
        let r = rank + dr;
        let f = file + df;
        while (r >= 0 && r < 8 && f >= 0 && f < 8) {
          const to = r * 8 + f;
          const target = board[to]!;
          if (target) {
            if (Math.sign(target) !== side) {
              add(from, to);
            }
            break;
          }
          if (!capturesOnly) {
            add(from, to);
          }
          r += dr;
          f += df;
        }
      }
    }
    if (!capturesOnly) {
      this.castlingMoves(moves);
    }
    return moves;
  }

  private castlingMoves(moves: Move[]) {
    const { board, side, castling } = this;
    const home = side === WHITE ? 60 : 4;
    const kingSide = side === WHITE ? WK : BK;
    const queenSide = side === WHITE ? WQ : BQ;
    const enemy = -side as Side;
    if (board[home] !== side * KING || !(castling & (kingSide | queenSide))) {
      return;
    }
    if (this.attacked(home, enemy)) {
      return;
    }
    if (
      castling & kingSide &&
      board[home + 3] === side * ROOK &&
      !board[home + 1] &&
      !board[home + 2] &&
      !this.attacked(home + 1, enemy) &&
      !this.attacked(home + 2, enemy)
    ) {
      moves.push({ from: home, to: home + 2, promotion: 0, castle: true, enPassant: false });
    }
    if (
      castling & queenSide &&
      board[home - 4] === side * ROOK &&
      !board[home - 1] &&
      !board[home - 2] &&
      !board[home - 3] &&
      !this.attacked(home - 1, enemy) &&
      !this.attacked(home - 2, enemy)
    ) {
      moves.push({ from: home, to: home - 2, promotion: 0, castle: true, enPassant: false });
    }
  }

  legalMoves(): Move[] {
    const mover = this.side;
    const tracking = this.tracksKeys;
    this.tracksKeys = false;
    const legal = this.pseudoMoves().filter((move) => {
      this.make(move);
      const safe = !this.inCheck(mover);
      this.unmake();
      return safe;
    });
    this.tracksKeys = tracking;
    return legal;
  }

  make(move: Move) {
    const { board } = this;
    const piece = board[move.from]!;
    const kind = Math.abs(piece);
    let captured = board[move.to]!;
    this.history.push({
      move,
      captured,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
    });
    board[move.to] = move.promotion ? Math.sign(piece) * move.promotion : piece;
    board[move.from] = EMPTY;
    if (move.enPassant) {
      const victim = move.to + this.side * 8;
      captured = board[victim]!;
      board[victim] = EMPTY;
    }
    if (move.castle) {
      const kingSide = move.to > move.from;
      const rookFrom = kingSide ? move.to + 1 : move.to - 2;
      const rookTo = kingSide ? move.to - 1 : move.to + 1;
      board[rookTo] = board[rookFrom]!;
      board[rookFrom] = EMPTY;
    }
    this.castling &= CASTLE_KEEP[move.from]! & CASTLE_KEEP[move.to]!;
    this.ep =
      kind === PAWN && Math.abs(move.to - move.from) === 16
        ? (move.from + move.to) / 2
        : -1;
    this.halfmove = kind === PAWN || captured ? 0 : this.halfmove + 1;
    if (this.side === BLACK) {
      this.fullmove += 1;
    }
    this.side = -this.side as Side;
    if (this.tracksKeys) {
      this.keys.push(this.key());
    }
  }

  unmake() {
    const undo = this.history.pop();
    if (!undo) {
      return;
    }
    const { move } = undo;
    const { board } = this;
    this.side = -this.side as Side;
    if (this.side === BLACK) {
      this.fullmove -= 1;
    }
    const moved = board[move.to]!;
    board[move.from] = move.promotion ? this.side * PAWN : moved;
    board[move.to] = undo.captured;
    if (move.enPassant) {
      board[move.to + this.side * 8] = -this.side * PAWN;
    }
    if (move.castle) {
      const kingSide = move.to > move.from;
      const rookFrom = kingSide ? move.to + 1 : move.to - 2;
      const rookTo = kingSide ? move.to - 1 : move.to + 1;
      board[rookFrom] = board[rookTo]!;
      board[rookTo] = EMPTY;
    }
    this.castling = undo.castling;
    this.ep = undo.ep;
    this.halfmove = undo.halfmove;
    if (this.tracksKeys) {
      this.keys.pop();
    }
  }

  /** Bare kings, a lone minor, or bishops on one colour: nobody can mate. */
  insufficientMaterial() {
    const minors: { kind: number; square: number }[] = [];
    for (let square = 0; square < 64; square++) {
      const piece = Math.abs(this.board[square]!);
      if (piece === EMPTY || piece === KING) {
        continue;
      }
      if (piece !== KNIGHT && piece !== BISHOP) {
        return false;
      }
      minors.push({ kind: piece, square });
    }
    if (minors.length <= 1) {
      return true;
    }
    if (minors.every(({ kind }) => kind === BISHOP)) {
      const colour = (square: number) => ((square >> 3) + (square & 7)) % 2;
      return minors.every(
        ({ square }) => colour(square) === colour(minors[0]!.square),
      );
    }
    return false;
  }

  repetitions() {
    const now = this.keys[this.keys.length - 1];
    return this.keys.filter((key) => key === now).length;
  }
}

/** Squares that lose a castling right when anything moves from or onto them. */
const CASTLE_KEEP: number[] = new Array<number>(64).fill(15);
CASTLE_KEEP[60] = 15 & ~(WK | WQ);
CASTLE_KEEP[63] = 15 & ~WK;
CASTLE_KEEP[56] = 15 & ~WQ;
CASTLE_KEEP[4] = 15 & ~(BK | BQ);
CASTLE_KEEP[7] = 15 & ~BK;
CASTLE_KEEP[0] = 15 & ~BQ;

export type ChessStatus =
  | { kind: "playing" }
  | { kind: "checkmate"; winner: Side }
  | { kind: "stalemate" }
  | { kind: "insufficient" }
  | { kind: "threefold" }
  | { kind: "fifty" };

export function gameStatus(position: Position): ChessStatus {
  if (position.legalMoves().length === 0) {
    return position.inCheck()
      ? { kind: "checkmate", winner: -position.side as Side }
      : { kind: "stalemate" };
  }
  if (position.insufficientMaterial()) {
    return { kind: "insufficient" };
  }
  if (position.repetitions() >= 3) {
    return { kind: "threefold" };
  }
  if (position.halfmove >= 100) {
    return { kind: "fifty" };
  }
  return { kind: "playing" };
}

export function perft(position: Position, depth: number): number {
  if (depth === 0) {
    return 1;
  }
  const tracking = position.tracksKeys;
  position.tracksKeys = false;
  let nodes = 0;
  for (const move of position.legalMoves()) {
    if (depth === 1) {
      nodes += 1;
      continue;
    }
    position.make(move);
    nodes += perft(position, depth - 1);
    position.unmake();
  }
  position.tracksKeys = tracking;
  return nodes;
}
