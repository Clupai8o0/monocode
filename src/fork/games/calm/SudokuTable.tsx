import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TableProps } from "../table/PokerTable";
import { ActionButton, Felt, TableFrame, reducedMotion } from "../table/kit";
import {
  CELLS,
  CLUES_FOR,
  arePeers,
  conflicts,
  emptyBoard,
  emptyCount,
  erase,
  generate,
  hasNote,
  isSolved,
  place,
  remaining,
  restoreBoard,
  toggleNote,
  type Board,
  type Puzzle,
} from "./sudoku";

/**
 * Fork: sudoku, a calm number puzzle. One level per seed, counted per mode.
 * A puzzle can take a while, so the board is saved as you go and comes back
 * after a restart.
 */

const SAVE_KEY = "monocode.fork.games.sudoku";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const SELECTED = "rgba(86, 180, 233, 0.42)";
const NAMED_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete"];
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Fill instead of lines: a small gap between cells, a wider one between boxes. */
const CELL_GAP = 2;
const BOX_GAP = 6;
const PAD_BUTTON = 40;
const PAD_GAP = 4;

type Mode = TableProps["mode"];
type Game = { mode: Mode; level: number; puzzle: Puzzle; history: Board[] };
type Saved = Partial<Record<Mode, { level?: unknown; board?: unknown }>>;

function readSave(): Saved {
  try {
    return (JSON.parse(localStorage.getItem(SAVE_KEY) ?? "{}") ?? {}) as Saved;
  } catch {
    return {};
  }
}

function seedFor(mode: Mode, level: number) {
  return level * 7877 + CLUES_FOR[mode] * 104_659;
}

function freshGame(mode: Mode, level: number): Game {
  const puzzle = generate(seedFor(mode, level), mode);
  return { mode, level, puzzle, history: [emptyBoard(puzzle)] };
}

function loadGame(mode: Mode): Game {
  const saved = readSave()[mode];
  const level = Number.isInteger(saved?.level) && (saved?.level as number) > 0 ? (saved?.level as number) : 1;
  const game = freshGame(mode, level);
  const board = restoreBoard(saved?.board, game.puzzle);
  return board ? { ...game, history: [board] } : game;
}

function firstOpen(board: Board) {
  const index = board.values.indexOf(0);
  return index === -1 ? 0 : index;
}

function Notes({ mask, size }: { mask: number; size: number }) {
  return (
    <span
      aria-hidden
      className="absolute inset-[1px] grid grid-cols-3 grid-rows-3 place-items-center font-mono leading-none text-content/60"
      style={{ fontSize: Math.max(7, Math.floor(size * 0.24)) }}
    >
      {DIGITS.map((digit) => (
        <span key={digit}>{hasNote(mask, digit) ? digit : ""}</span>
      ))}
    </span>
  );
}

export function SudokuTable({ mode, runId, active, onExit, onInput }: TableProps) {
  const [game, setGame] = useState(() => loadGame(mode));
  const [cell, setCell] = useState(() => firstOpen(game.history[game.history.length - 1]!));
  const [noting, setNoting] = useState(false);
  const [landed, setLanded] = useState<{ index: number; at: number } | null>(null);
  const [room, setRoom] = useState({ width: 420, height: 280 });
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);

  const { level, puzzle, history } = game;
  const board = history[history.length - 1]!;
  const solved = isSolved(board);
  const clashes = useMemo(() => conflicts(board.values), [board.values]);
  const left = emptyCount(board.values);
  const started = board.values.some((value, index) => value !== puzzle.givens[index]) || board.notes.some(Boolean);

  // Written against the game's own mode, so a mode switch never files a board under the wrong one.
  useEffect(() => {
    try {
      const current = game.history[game.history.length - 1]!;
      localStorage.setItem(SAVE_KEY, JSON.stringify({ ...readSave(), [game.mode]: { level: game.level, board: current } }));
    } catch {
      // A full or blocked store only forgets the progress.
    }
  }, [game]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect;
      if (rect) {
        setRoom({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = landed ? cells.current[landed.index]?.querySelector("[data-sudoku-digit]") : null;
    if (!el || reducedMotion()) {
      return;
    }
    const motion = el.animate([{ transform: "scale(0.7)", opacity: 0.4 }, { transform: "none", opacity: 1 }], {
      duration: 120,
      easing: EASE_OUT,
    });
    return () => motion.cancel();
  }, [landed]);

  // The finished board ripples out from the last cell placed.
  const wasSolved = useRef(solved);
  useLayoutEffect(() => {
    const justSolved = solved && !wasSolved.current;
    wasSolved.current = solved;
    if (!justSolved || reducedMotion()) {
      return;
    }
    const fromRow = Math.floor(cell / 9);
    const fromCol = cell % 9;
    const motions = cells.current.flatMap((el, index) => {
      if (!el) {
        return [];
      }
      const distance = Math.max(Math.abs(Math.floor(index / 9) - fromRow), Math.abs((index % 9) - fromCol));
      return [
        el.animate([{ transform: "none" }, { transform: "scale(0.86)" }, { transform: "none" }], {
          duration: 240,
          delay: distance * 35,
          easing: EASE_OUT,
        }),
      ];
    });
    return () => motions.forEach((motion) => motion.cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solved]);

  const commit = (nextBoard: Board, index?: number) => {
    if (nextBoard !== board) {
      setGame({ ...game, history: [...history, nextBoard] });
      if (index !== undefined) {
        setLanded({ index, at: Date.now() });
      }
    }
  };

  /** A level's board is thrown away only as one more step, so U brings it back. */
  const restart = () => {
    if (started && !solved) {
      commit(emptyBoard(puzzle));
      setLanded(null);
      setCell(firstOpen(emptyBoard(puzzle)));
    }
  };

  const open = (nextGame: Game) => {
    setGame(nextGame);
    setCell(firstOpen(nextGame.history[nextGame.history.length - 1]!));
    setNoting(false);
    setLanded(null);
  };

  // A new mode brings back its own board. The panel's new game clears this one
  // only while it's showing: the run number is shared by every table.
  const seen = useRef({ mode, runId });
  useEffect(() => {
    if (seen.current.mode !== mode) {
      open(loadGame(mode));
    } else if (seen.current.runId !== runId && active) {
      if (solved) {
        open(freshGame(mode, level));
      } else {
        restart();
      }
    }
    seen.current = { mode, runId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, runId]);

  const next = () => {
    if (solved) {
      open(freshGame(game.mode, level + 1));
    }
  };

  const undo = () => {
    if (!solved && history.length > 1) {
      setGame({ ...game, history: history.slice(0, -1) });
      setLanded(null);
    }
  };

  const enter = (digit: number) => {
    if (solved) {
      return;
    }
    if (noting) {
      commit(toggleNote(board, puzzle, cell, digit));
    } else {
      const placed = place(board, puzzle, cell, digit);
      commit(placed, placed.values[cell] === digit ? cell : undefined);
    }
  };

  const clear = () => {
    if (!solved) {
      commit(erase(board, puzzle, cell));
    }
  };

  const move = (rows: number, cols: number) => {
    const row = (Math.floor(cell / 9) + rows + 9) % 9;
    const col = ((cell % 9) + cols + 9) % 9;
    setCell(row * 9 + col);
  };

  const onKey = (key: string) => {
    if (key >= "1" && key <= "9") {
      enter(Number(key));
    } else if (key === "0" || key === "x" || key === "Backspace" || key === "Delete") {
      clear();
    } else if (key === "ArrowLeft") {
      move(0, -1);
    } else if (key === "ArrowRight") {
      move(0, 1);
    } else if (key === "ArrowUp") {
      move(-1, 0);
    } else if (key === "ArrowDown") {
      move(1, 0);
    } else if (key === "u") {
      undo();
    } else if (key === "r") {
      restart();
    } else if (key === "n" && !solved) {
      setNoting((value) => !value);
    } else if ((key === "n" || key === " ") && solved) {
      next();
    }
  };

  // The pad sits beside the board or under it, whichever leaves the bigger board.
  const gaps = 6 * CELL_GAP + 2 * BOX_GAP;
  const padSide = PAD_BUTTON * 3 + PAD_GAP * 2;
  const padRow = (PAD_BUTTON - 8) * 9 + PAD_GAP * 8;
  const fit = (width: number, height: number) => Math.max(16, Math.floor((Math.min(width, height) - gaps) / 9));
  const beside = fit(room.width - padSide - 20, room.height);
  const under = room.width >= padRow ? fit(room.width, room.height - PAD_BUTTON - 10) : 0;
  const stacked = under > beside;
  const size = Math.min(56, stacked ? under : beside);

  const span = size * 9 + gaps;
  const at = (line: number) => line * (size + CELL_GAP) + Math.floor(line / 3) * (BOX_GAP - CELL_GAP);

  const selected = board.values[cell]!;

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Sudoku" namedKeys={NAMED_KEYS}>
      <div data-sudoku-solved={solved ? "" : undefined} className="relative flex h-full flex-col">
        <Felt className="inset-x-3 top-1 bottom-[52px]" />

        <div className="relative z-10 flex shrink-0 items-baseline justify-center gap-3 pt-4 pb-1 font-mono text-[11px] text-content/60">
          <span className="text-content/85">Level {level}</span>
          {solved ? null : <span data-sudoku-left={left}>{left} to fill</span>}
        </div>

        <div ref={box} className="relative z-10 min-h-0 flex-1 px-5 pb-1">
          <div className={`flex h-full items-center justify-center ${stacked ? "flex-col gap-2.5" : "gap-5"}`}>
            <div className="relative shrink-0" style={{ width: span, height: span }}>
              {Array.from({ length: CELLS }, (_, index) => {
                const value = board.values[index]!;
                const given = puzzle.givens[index] !== 0;
                const isCell = index === cell;
                const clash = clashes.has(index);
                const sameDigit = selected !== 0 && value === selected;
                const related = !isCell && arePeers(index, cell);
                const col = index % 9;
                const row = Math.floor(index / 9);
                const tint = isCell
                  ? ""
                  : sameDigit
                    ? "bg-content/[0.22]"
                    : related
                      ? "bg-content/[0.13]"
                      : given
                        ? "bg-content/[0.1]"
                        : "bg-content/[0.05] hover:bg-content/15";
                return (
                  <button
                    key={index}
                    ref={(el) => {
                      cells.current[index] = el;
                    }}
                    type="button"
                    tabIndex={-1}
                    data-sudoku-cell={index}
                    data-sudoku-value={value}
                    data-sudoku-given={given ? "" : undefined}
                    data-sudoku-clash={clash ? "" : undefined}
                    aria-label={`Row ${row + 1}, column ${col + 1}: ${value === 0 ? "empty" : value}${given ? ", given" : ""}${clash ? ", clashes" : ""}`}
                    aria-pressed={isCell}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setCell(index)}
                    className={`relative flex cursor-pointer items-center justify-center rounded-[3px] font-mono ${tint} ${
                      given ? "font-semibold text-content" : "text-content/75"
                    }`}
                    style={{
                      position: "absolute",
                      left: at(col),
                      top: at(row),
                      width: size,
                      height: size,
                      fontSize: Math.floor(size * 0.52),
                      background: isCell ? SELECTED : undefined,
                      color: clash ? "var(--table-red)" : undefined,
                    }}
                  >
                    {value !== 0 ? <span data-sudoku-digit>{value}</span> : null}
                    {value === 0 && board.notes[index] ? <Notes mask={board.notes[index]!} size={size} /> : null}
                    {clash ? (
                      <span
                        aria-hidden
                        className="absolute right-[2px] top-[2px] h-[4px] w-[4px] rounded-full"
                        style={{ background: "var(--table-red)" }}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div
              className="grid"
              style={{
                gridTemplateColumns: stacked ? `repeat(9, ${PAD_BUTTON - 8}px)` : `repeat(3, ${PAD_BUTTON}px)`,
                gridAutoRows: PAD_BUTTON,
                gap: PAD_GAP,
              }}
            >
              {DIGITS.map((digit) => {
                const count = remaining(board.values, digit);
                return (
                  <button
                    key={digit}
                    type="button"
                    tabIndex={-1}
                    data-sudoku-pad={digit}
                    aria-label={`${noting ? "Pencil" : "Place"} ${digit}, ${count} left`}
                    disabled={solved}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => enter(digit)}
                    className={`relative flex cursor-pointer items-center justify-center rounded-[3px] bg-content/[0.07] font-mono text-[15px] hover:bg-content/15 disabled:cursor-default ${
                      count === 0 ? "text-content/30" : "text-content/90"
                    }`}
                  >
                    {digit}
                    <span aria-hidden className="absolute bottom-[2px] right-[3px] text-[8px] leading-none text-content/45">
                      {count === 0 ? "" : count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="relative z-10 flex h-[52px] shrink-0 items-center justify-center gap-2">
          {solved ? (
            <>
              <span className="font-mono text-[11px] text-content/70">Solved</span>
              <ActionButton primary label="Next" keyHint="N" data-action="next" onClick={next} />
            </>
          ) : (
            <>
              <ActionButton
                primary={noting}
                label={noting ? "Notes on" : "Notes"}
                keyHint="N"
                data-action="notes"
                onClick={() => setNoting((value) => !value)}
              />
              <ActionButton label="Erase" keyHint="X" data-action="erase" onClick={clear} />
              <ActionButton label="Undo" keyHint="U" data-action="undo" disabled={history.length <= 1} onClick={undo} />
              <ActionButton label="Restart" keyHint="R" data-action="restart" disabled={!started} onClick={restart} />
            </>
          )}
        </div>
      </div>
    </TableFrame>
  );
}
