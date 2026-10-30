import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AGENTS, AGENT_IDS, type AgentId } from "./agents";
import {
  BISHOP,
  KING,
  KNIGHT,
  PAWN,
  Position,
  QUEEN,
  ROOK,
  WHITE,
  gameStatus,
  moveName,
  squareName,
  type ChessStatus,
  type Move,
  type Side,
} from "./chess";
import { chessVerdict, findMove, modeDepth } from "./chessAi";
import { askEngine } from "./chessEngine";
import {
  ActionButton,
  Avatar,
  Bubble,
  SeatPicker,
  Sprite,
  TableFrame,
  ThinkingLabel,
  knownAgents,
  recalledSeats,
  rememberSeats,
  useChatter,
  useCoworkerLine,
  useRandom,
  useRivals,
} from "./kit";
import type { TableProps } from "./PokerTable";
import { PIECES } from "./sprites";
import { tokenStore } from "./tokens";

/** Fork: chess against one agent. Squares and pieces are fills; no grid lines. */

const PIECE_GRID = 12;
const MAX_MS = 1500;
const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];
const PIECE_NAMES: Record<number, string> = {
  [PAWN]: "pawn",
  [KNIGHT]: "knight",
  [BISHOP]: "bishop",
  [ROOK]: "rook",
  [QUEEN]: "queen",
  [KING]: "king",
};

/** How the game ended, for you. */
type Ending = { result: "win" | "loss" | "draw"; words: string };

function statusEnding(status: ChessStatus, you: Side): Ending | null {
  switch (status.kind) {
    case "playing":
      return null;
    case "checkmate":
      return status.winner === you
        ? { result: "win", words: "Checkmate. You win." }
        : { result: "loss", words: "Checkmate. You lost." };
    case "stalemate":
      return { result: "draw", words: "Stalemate. A draw." };
    case "insufficient":
      return { result: "draw", words: "Not enough pieces to mate. A draw." };
    case "threefold":
      return { result: "draw", words: "Same position three times. A draw." };
    case "fifty":
      return { result: "draw", words: "Fifty moves with no progress. A draw." };
  }
}

/** The start position, unless a browser test has set up a later one. */
function startingFen() {
  return (globalThis as { __MONOCODE_CHESS_FEN__?: string }).__MONOCODE_CHESS_FEN__;
}

function PieceArt({ piece, scale }: { piece: number; scale: number }) {
  const rows = PIECES[Math.abs(piece)]!;
  const fill = piece > 0 ? "var(--table-piece-white)" : "var(--table-piece-black)";
  return <Sprite rows={rows} scale={scale} colors={{ "#": fill }} />;
}

export function ChessTable({ mode, runId, active, waiting, onExit, onInput }: TableProps) {
  const talkRandom = useRandom(71);
  const seedRandom = useRandom(83);
  const { bubbles, say } = useChatter(talkRandom);
  const rivals = useRivals();

  const [opponent, setOpponent] = useState<AgentId>(() => {
    const saved = knownAgents([recalledSeats().chess])[0];
    return saved ?? AGENT_IDS[Math.floor(talkRandom() * (AGENT_IDS.length - 1))]!;
  });
  const [playing, setPlaying] = useState(opponent);
  const position = useRef(new Position(startingFen()));
  const [you, setYou] = useState<Side>(WHITE);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [thinking, setThinking] = useState(false);
  const [offer, setOffer] = useState(false);
  const [note, setNote] = useState("");
  const [promotion, setPromotion] = useState<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(4);
  const lastScore = useRef(0);
  const lastOffer = useRef(-100);

  const wrap = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ from: number; x: number; y: number; moved: boolean } | null>(null);

  useCoworkerLine(waiting, [playing], say, talkRandom);

  // Whole-number scales only, as big as the space allows.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const fit = () => {
      const room = Math.min(el.clientHeight - 16, el.clientWidth - 220);
      if (room > 0) {
        setScale(Math.max(2, Math.floor(room / (8 * PIECE_GRID))));
      }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    fit();
    return () => observer.disconnect();
  }, []);

  const pos = position.current;
  const inPlay = !ending;
  const yourTurn = inPlay && pos.side === you;
  const legal = yourTurn ? pos.legalMoves() : [];
  const targets = legal.filter((move) => move.from === selected);

  const finish = useCallback(
    (done: Ending) => {
      setEnding(done);
      setOffer(false);
      setPromotion(null);
      setSelected(-1);
      tokenStore.addRival(playing, {
        wins: done.result === "win" ? 1 : 0,
        losses: done.result === "loss" ? 1 : 0,
        draws: done.result === "draw" ? 1 : 0,
      });
    },
    [playing],
  );

  const afterMove = useCallback(() => {
    setVersion((value) => value + 1);
    const done = statusEnding(gameStatus(position.current), you);
    if (done) {
      finish(done);
    }
    return done;
  }, [finish, you]);

  const startGame = useCallback(
    (side: Side, agent: AgentId) => {
      position.current = new Position(startingFen());
      lastScore.current = 0;
      lastOffer.current = -100;
      setYou(side);
      setPlaying(agent);
      setEnding(null);
      setOffer(false);
      setPromotion(null);
      setSelected(-1);
      setNote("");
      setVersion((value) => value + 1);
    },
    [],
  );

  // New game: leaving one you've moved in counts as resigning it.
  const seenRun = useRef(runId);
  useEffect(() => {
    if (runId === seenRun.current) {
      return;
    }
    seenRun.current = runId;
    if (!active) {
      return;
    }
    const moved = position.current.history.length >= 2;
    if (!ending && moved) {
      tokenStore.addRival(playing, { losses: 1 });
    }
    startGame(ending || moved ? (-you as Side) : you, opponent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, active]);

  // The agent's move.
  useEffect(() => {
    if (!active || ending || pos.side === you) {
      return;
    }
    let cancelled = false;
    setThinking(true);
    const started = performance.now();
    const minimum = 400 + talkRandom() * 700;
    const style = AGENTS[playing].chess;
    const depth = modeDepth(mode, seedRandom);
    void askEngine({
      fen: pos.fen(),
      keys: pos.keys,
      depth,
      maxMs: MAX_MS,
      style,
      seed: Math.floor(seedRandom() * 2 ** 31),
    }).then((result) => {
      const wait = Math.max(0, minimum - (performance.now() - started));
      setTimeout(() => {
        if (cancelled) {
          return;
        }
        setThinking(false);
        lastScore.current = result.score;
        const ply = position.current.history.length;
        const verdict = chessVerdict(
          playing,
          result.score,
          ply,
          lastOffer.current,
          talkRandom(),
        );
        if (verdict === "resign") {
          say(playing, "resign");
          finish({ result: "win", words: `${AGENTS[playing].name} resigns. You win.` });
          return;
        }
        const move = findMove(position.current, result.move);
        if (!move) {
          return;
        }
        position.current.make(move);
        const done = afterMove();
        if (done) {
          if (done.result !== "draw") {
            say(playing, done.result === "loss" ? "chessWin" : "chessLose");
          }
          return;
        }
        if (position.current.inCheck()) {
          say(playing, "chessCheck");
        } else if (result.blundered) {
          say(playing, "blunder");
        } else {
          say(playing, "chessMove", 0.45);
        }
        if (verdict === "offer") {
          lastOffer.current = ply;
          setOffer(true);
          say(playing, "drawOffer");
        }
      }, wait);
    });
    return () => {
      cancelled = true;
      setThinking(false);
    };
    // The game state only changes through `version`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, version, ending, you, playing]);

  const playMove = (move: Move) => {
    position.current.make(move);
    setSelected(-1);
    setPromotion(null);
    setOffer(false);
    setNote("");
    const done = afterMove();
    if (done && done.result !== "draw") {
      say(playing, done.result === "win" ? "chessLose" : "chessWin");
    }
  };

  const tryMove = (from: number, to: number) => {
    const options = legal.filter((move) => move.from === from && move.to === to);
    if (options.length === 0) {
      return false;
    }
    if (options.length > 1) {
      setPromotion({ from, to });
      return true;
    }
    playMove(options[0]!);
    return true;
  };

  const squareFromPoint = (x: number, y: number) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) {
      return -1;
    }
    const cell = rect.width / 8;
    const col = Math.floor((x - rect.left) / cell);
    const row = Math.floor((y - rect.top) / cell);
    if (col < 0 || col > 7 || row < 0 || row > 7) {
      return -1;
    }
    return you === WHITE ? row * 8 + col : (7 - row) * 8 + (7 - col);
  };

  const onPointerDown = (event: React.PointerEvent, square: number) => {
    if (promotion || !yourTurn) {
      return;
    }
    if (selected >= 0 && tryMove(selected, square)) {
      return;
    }
    const piece = pos.board[square]!;
    if (piece && Math.sign(piece) === you) {
      setSelected(square);
      dragStart.current = { from: square, x: event.clientX, y: event.clientY, moved: false };
    } else {
      setSelected(-1);
    }
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = dragStart.current;
      if (!start) {
        return;
      }
      if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
        return;
      }
      start.moved = true;
      setDrag({ from: start.from, x: event.clientX, y: event.clientY });
    };
    const onUp = (event: PointerEvent) => {
      const start = dragStart.current;
      dragStart.current = null;
      setDrag(null);
      if (start?.moved) {
        const to = squareFromPoint(event.clientX, event.clientY);
        if (to < 0 || !tryMoveRef.current(start.from, to)) {
          setSelected(-1);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [you]);

  const tryMoveRef = useRef(tryMove);
  tryMoveRef.current = tryMove;

  const resign = () => {
    if (inPlay) {
      finish({ result: "loss", words: "You resigned." });
      say(playing, "chessWin");
    }
  };

  const offerDraw = () => {
    if (!inPlay || thinking) {
      return;
    }
    // It takes a draw when it isn't ahead, and only once the game has got going.
    const score = lastScore.current;
    if (pos.history.length >= 20 && score <= 30) {
      finish({ result: "draw", words: `${AGENTS[playing].name} agrees to a draw.` });
    } else {
      setNote(`${AGENTS[playing].name} would rather play on.`);
    }
  };

  const onKey = (key: string) => {
    if (key === " " && ending) {
      startGame(-you as Side, opponent);
    }
  };

  const last = pos.history[pos.history.length - 1]?.move;
  const cell = scale * PIECE_GRID;
  const checkSquare = inPlay && pos.inCheck() ? pos.board.indexOf(pos.side * KING) : -1;
  const order = Array.from({ length: 64 }, (_, i) => (you === WHITE ? i : 63 - i));
  const record = rivals[playing];
  const moves = pos.history.map((item) => moveName(item.move));
  const played = AGENT_IDS.filter((id) => {
    const rival = rivals[id];
    return rival && rival.wins + rival.losses + rival.draws > 0;
  });

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Chess table">
      <div ref={wrap} data-table-phase={ending ? "over" : "playing"} className="flex h-full gap-3 p-2">
        <div
          ref={boardRef}
          data-chess-board={you === WHITE ? "white" : "black"}
          className="relative grid shrink-0 self-start"
          style={{
            width: cell * 8,
            height: cell * 8,
            gridTemplateColumns: `repeat(8, ${cell}px)`,
            gridTemplateRows: `repeat(8, ${cell}px)`,
          }}
        >
          {order.map((square) => {
            const piece = pos.board[square]!;
            const dark = ((square >> 3) + (square & 7)) % 2 === 1;
            const isLast = last && (last.from === square || last.to === square);
            const isTarget = targets.some((move) => move.to === square);
            const background =
              square === checkSquare
                ? "var(--table-sq-check)"
                : square === selected
                  ? "var(--table-sq-from)"
                  : isLast
                    ? "var(--table-sq-to)"
                    : dark
                      ? "var(--table-sq-dark)"
                      : "var(--table-sq-light)";
            const name = squareName(square);
            const label = piece
              ? `${name}, ${piece > 0 ? "white" : "black"} ${PIECE_NAMES[Math.abs(piece)]}`
              : name;
            return (
              <button
                key={square}
                type="button"
                tabIndex={-1}
                data-square={name}
                data-piece={piece || undefined}
                aria-label={label}
                onPointerDown={(event) => onPointerDown(event, square)}
                style={{ background, width: cell, height: cell, touchAction: "none" }}
                className="relative grid cursor-pointer place-items-center"
              >
                {piece && drag?.from !== square ? <PieceArt piece={piece} scale={scale} /> : null}
                {isTarget ? (
                  <span
                    aria-hidden
                    data-legal-dot=""
                    className="pointer-events-none absolute"
                    style={{
                      width: scale * 3,
                      height: scale * 3,
                      background: "var(--table-dot)",
                    }}
                  />
                ) : null}
              </button>
            );
          })}
          {promotion ? (
            <div
              data-promotion=""
              role="group"
              aria-label="Promote to"
              className="absolute inset-0 z-20 flex items-center justify-center gap-1"
              style={{ background: "rgb(0 0 0 / 0.45)" }}
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  setPromotion(null);
                }
              }}
            >
              {PROMOTIONS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  tabIndex={-1}
                  aria-label={PIECE_NAMES[kind]}
                  data-promote={PIECE_NAMES[kind]}
                  onClick={() => {
                    const move = legal.find(
                      (item) =>
                        item.from === promotion.from &&
                        item.to === promotion.to &&
                        item.promotion === kind,
                    );
                    if (move) {
                      playMove(move);
                    }
                  }}
                  style={{ width: cell, height: cell, background: "var(--table-sq-light)" }}
                  className="table-button grid cursor-pointer place-items-center"
                >
                  <PieceArt piece={you * kind} scale={scale} />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col gap-2 font-mono text-[11px] text-content/75">
          <div className="relative flex items-center gap-2">
            <Avatar id={playing} scale={4} lively={thinking || !!bubbles[playing]} />
            <div className="flex flex-col leading-[14px]">
              <span className="text-content/90">{AGENTS[playing].name}</span>
              <span className="text-content/50">
                plays {you === WHITE ? "black" : "white"} · you {record?.wins ?? 0}-{record?.losses ?? 0}-{record?.draws ?? 0}
              </span>
            </div>
          </div>
          <div className="min-h-[46px]">
            {bubbles[playing] ? <Bubble text={bubbles[playing]!} className="!max-w-full" /> : null}
          </div>
          <div role="status" data-table-status="" className="min-h-4 text-content/80">
            {ending ? (
              ending.words
            ) : thinking ? (
              <ThinkingLabel id={playing} />
            ) : note ? (
              note
            ) : yourTurn ? (
              pos.inCheck() ? "You're in check." : "your move"
            ) : (
              ""
            )}
          </div>

          {offer ? (
            <div className="flex items-center gap-1.5" data-draw-offer="">
              <ActionButton
                icon="shake"
                primary
                label="Accept draw"
                data-action="accept-draw"
                onClick={() => finish({ result: "draw", words: "You took the draw." })}
              />
              <ActionButton label="Play on" data-action="decline-draw" onClick={() => setOffer(false)} />
            </div>
          ) : null}

          <div className="flex items-center gap-1.5">
            {ending ? (
              <ActionButton
                icon="deal"
                primary
                label="Play again"
                keyHint="Space"
                data-action="again"
                onClick={() => startGame(-you as Side, opponent)}
              />
            ) : (
              <>
                <ActionButton icon="flag" label="Resign" data-action="resign" onClick={resign} />
                <ActionButton icon="shake" label="Offer draw" data-action="offer-draw" onClick={offerDraw} />
              </>
            )}
          </div>

          <div className="mt-1 min-h-0 flex-1 overflow-hidden break-words text-[10px] leading-[14px] text-content/45" data-move-list="">
            {moves.slice(-24).join(" ")}
          </div>

          {played.length > 0 ? (
            <div className="flex flex-col text-[10px] leading-[14px] text-content/60" data-chess-record="">
              {played.map((id) => (
                <span key={id} className="tabular-nums">
                  {AGENTS[id].name} {rivals[id]!.wins}-{rivals[id]!.losses}-{rivals[id]!.draws}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-content/45">Next opponent</span>
            <SeatPicker
              single
              picked={[opponent]}
              max={1}
              onChange={(next) => {
                const id = next[0]!;
                setOpponent(id);
                rememberSeats({ chess: id });
                // A game not yet begun can change hands straight away.
                if (position.current.history.length === 0 && !ending) {
                  setPlaying(id);
                }
              }}
            />
          </div>
        </div>
      </div>
      {drag ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50"
          style={{ left: drag.x - cell / 2, top: drag.y - cell / 2 }}
        >
          <PieceArt piece={pos.board[drag.from]!} scale={scale} />
        </div>
      ) : null}
    </TableFrame>
  );
}
