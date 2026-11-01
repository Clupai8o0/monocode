import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TableProps } from "../table/PokerTable";
import { ActionButton, Felt, TableFrame, reducedMotion } from "../table/kit";
import { E, N, S, SIZE_FOR, W, deployReached, flow, generate, isSolved, rotate, type Board } from "./pipeline";

/** Fork: pipeline, a calm routing puzzle. One level per seed, counted per mode. */

const LEVEL_KEY = "monocode.fork.games.pipeline.level";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const FLOW = "#56b4e9";
const GOOD = "#009e73";
const LABEL_COLUMN = 54;

type Levels = Partial<Record<TableProps["mode"], number>>;

function readLevels(): Levels {
  try {
    return JSON.parse(localStorage.getItem(LEVEL_KEY) ?? "{}") as Levels;
  } catch {
    return {};
  }
}

function seedFor(mode: TableProps["mode"], level: number) {
  return level * 6007 + SIZE_FOR[mode].cols * 90_001 + SIZE_FOR[mode].rows * 1_009;
}

function fresh(mode: TableProps["mode"], level: number): Board {
  return generate(seedFor(mode, level), mode).board;
}

/** Thick rounded bars from the tile centre to each open side. */
function Pipes({ mask, colour, opacity }: { mask: number; colour: string; opacity: number }) {
  const bars: [number, number, number][] = [
    [N, 50, 0],
    [E, 100, 50],
    [S, 50, 100],
    [W, 0, 50],
  ];
  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
      {bars.map(([bit, x, y]) =>
        mask & bit ? (
          <line key={bit} x1={50} y1={50} x2={x} y2={y} stroke={colour} strokeWidth={22} strokeLinecap="butt" opacity={opacity} />
        ) : null,
      )}
      {mask ? <circle cx={50} cy={50} r={11} fill={colour} opacity={opacity} /> : null}
    </svg>
  );
}

export function PipelineTable({ mode, runId, active, onExit, onInput }: TableProps) {
  const [level, setLevel] = useState(() => readLevels()[mode] ?? 1);
  const [history, setHistory] = useState<Board[]>(() => [fresh(mode, level)]);
  const [turned, setTurned] = useState<{ index: number; at: number } | null>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 420, height: 240 });

  const board = history[history.length - 1]!;
  const { cols, rows } = board;
  const lit = flow(board);
  const solved = isSolved(board);
  const reached = deployReached(board, lit);
  const moves = history.length - 1;

  const start = (next: number) => {
    setHistory([fresh(mode, next)]);
    setTurned(null);
  };

  // A new mode reads its own level; a new run restarts the level.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const saved = readLevels()[mode] ?? 1;
    setLevel(saved);
    start(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, runId]);

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

  // The new orientation is already drawn; spin from a quarter turn back so it settles into place.
  useLayoutEffect(() => {
    const el = turned ? tiles.current[turned.index]?.querySelector("[data-pipe-art]") : null;
    if (!el || reducedMotion()) {
      return;
    }
    const motion = el.animate([{ transform: "rotate(-90deg)" }, { transform: "none" }], {
      duration: 180,
      easing: EASE_OUT,
    });
    return () => motion.cancel();
  }, [turned]);

  const next = () => {
    if (!solved) {
      return;
    }
    const upcoming = level + 1;
    try {
      localStorage.setItem(LEVEL_KEY, JSON.stringify({ ...readLevels(), [mode]: upcoming }));
    } catch {
      // A full or blocked store only forgets the level number.
    }
    setLevel(upcoming);
    start(upcoming);
  };

  const undo = () => {
    if (history.length > 1) {
      setHistory(history.slice(0, -1));
      setTurned(null);
    }
  };

  const restart = () => start(level);

  const tap = (index: number) => {
    if (solved) {
      return;
    }
    setHistory([...history, rotate(board, index)]);
    setTurned({ index, at: Date.now() });
  };

  const onKey = (key: string) => {
    if (key === "u") {
      undo();
    } else if (key === "r") {
      restart();
    } else if ((key === "n" || key === " ") && solved) {
      next();
    }
  };

  // Two label columns flank the grid; the tile size fits whichever side is tighter.
  const size = Math.max(
    24,
    Math.min(64, Math.floor((room.width - 2 * LABEL_COLUMN) / cols), Math.floor(room.height / rows)),
  );
  const checkAt = new Map(board.checks.map((check) => [check.index, check.label]));

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Pipeline">
      <div data-pipe-solved={solved ? "" : undefined} className="relative flex h-full flex-col">
        <Felt className="inset-x-3 top-1 bottom-[52px]" />

        <div className="relative z-10 flex shrink-0 items-baseline justify-center gap-3 pt-4 font-mono text-[11px] text-content/60">
          <span className="text-content/85">Level {level}</span>
          <span>{moves} {moves === 1 ? "turn" : "turns"}</span>
        </div>

        <div ref={box} className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-3">
          <div
            className="grid items-center"
            style={{
              gridTemplateColumns: `${LABEL_COLUMN}px repeat(${cols}, ${size}px) ${LABEL_COLUMN}px`,
              gridTemplateRows: `repeat(${rows}, ${size}px)`,
            }}
          >
            {Array.from({ length: rows }, (_, y) => {
              const row = [];
              row.push(
                <div
                  key={`l${y}`}
                  className="pr-1 text-right font-mono text-[10px]"
                  style={{ color: y === board.start && lit.size > 0 ? FLOW : undefined }}
                >
                  {y === board.start ? <span data-pipe-commit>{"commit →"}</span> : null}
                </div>,
              );
              for (let x = 0; x < cols; x++) {
                const index = y * cols + x;
                const mask = board.tiles[index]!;
                const isLit = lit.has(index);
                const label = checkAt.get(index);
                const colour = label && isLit ? GOOD : isLit ? FLOW : "currentColor";
                row.push(
                  <button
                    key={index}
                    ref={(el) => {
                      tiles.current[index] = el;
                    }}
                    type="button"
                    tabIndex={-1}
                    data-pipe-tile={index}
                    data-pipe-lit={isLit ? "" : undefined}
                    aria-label={`Tile ${index + 1}${label ? `, ${label} checkpoint` : ""}${isLit ? ", flowing" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => tap(index)}
                    className="relative cursor-pointer rounded-[3px] bg-content/[0.07] text-content hover:bg-content/15"
                    style={{ width: size - 3, height: size - 3, margin: 1.5 }}
                  >
                    <div data-pipe-art className="absolute inset-0">
                      <Pipes mask={mask} colour={colour} opacity={isLit ? 1 : 0.32} />
                    </div>
                    {label ? (
                      <span
                        data-pipe-check={label}
                        className="absolute left-0 top-0 rounded-br-[3px] rounded-tl-[3px] px-[3px] font-mono text-[8px] leading-[11px]"
                        style={{
                          background: isLit ? GOOD : "rgba(128,128,128,0.35)",
                          color: isLit ? "#06130f" : undefined,
                        }}
                      >
                        {label}
                      </span>
                    ) : null}
                  </button>,
                );
              }
              row.push(
                <div
                  key={`r${y}`}
                  className="pl-1 font-mono text-[10px]"
                  style={{ color: y === board.end && reached ? FLOW : undefined }}
                >
                  {y === board.end ? <span data-pipe-deploy>{"→ deploy"}</span> : null}
                </div>,
              );
              return row;
            })}
          </div>
        </div>

        <div className="relative z-10 flex h-[52px] shrink-0 items-center justify-center gap-2">
          {solved ? (
            <>
              <span className="font-mono text-[11px] text-content/70">Shipped in {moves} {moves === 1 ? "turn" : "turns"}</span>
              <ActionButton primary label="Next" keyHint="N" data-action="next" onClick={next} />
            </>
          ) : (
            <>
              <ActionButton label="Undo" keyHint="U" data-action="undo" disabled={moves === 0} onClick={undo} />
              <ActionButton label="Restart" keyHint="R" data-action="restart" disabled={moves === 0} onClick={restart} />
            </>
          )}
        </div>
      </div>
    </TableFrame>
  );
}
