import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TableProps } from "../table/PokerTable";
import { ActionButton, Felt, Sprite, TableFrame, reducedMotion } from "../table/kit";
import { COLOURS_FOR, TUBE_SIZE, canPour, generate, isSolved, pour, pourCount, type Board } from "./colourSort";

/** Fork: colour sort, a calm pour puzzle. One level per seed, counted per mode. */

const LEVEL_KEY = "monocode.fork.games.colourSort.level";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Okabe-Ito leaning, and every colour also wears its own mark. */
const PAINT = ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#f4f1ea", "#7a5cc9"];
const MARKS: string[][] = [
  ["..#..", ".###.", "#####", ".###.", "..#.."],
  ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  ["#####", "#...#", "#...#", "#...#", "#####"],
  ["..#..", "..#..", "#####", "..#..", "..#.."],
  ["#.#.#", ".....", "#.#.#", ".....", "#.#.#"],
  [".....", "#####", ".....", "#####", "....."],
  ["#....", "##...", "###..", "####.", "#####"],
  ["#.#.#", ".#.#.", "#.#.#", ".#.#.", "#.#.#"],
  [".###.", "#...#", "#.#.#", "#...#", ".###."],
];
const NAMES = ["orange", "sky", "green", "yellow", "blue", "red", "pink", "white", "violet"];

type Levels = Partial<Record<TableProps["mode"], number>>;

function readLevels(): Levels {
  try {
    return JSON.parse(localStorage.getItem(LEVEL_KEY) ?? "{}") as Levels;
  } catch {
    return {};
  }
}

function seedFor(mode: TableProps["mode"], level: number) {
  return level * 7919 + COLOURS_FOR[mode] * 104_729;
}

function Layer({ colour, scale }: { colour: number; scale: number }) {
  return (
    <div
      data-layer={colour}
      className="flex items-center justify-center rounded-[2px]"
      style={{ background: PAINT[colour], width: 26 * scale, height: 20 * scale, color: "rgba(0,0,0,0.42)" }}
    >
      <Sprite rows={MARKS[colour]!} scale={2 * scale} label={NAMES[colour]} />
    </div>
  );
}

export function SortTable({ mode, runId, active, onExit, onInput }: TableProps) {
  const [level, setLevel] = useState(() => readLevels()[mode] ?? 1);
  const [history, setHistory] = useState<Board[]>(() => [generate(seedFor(mode, level), COLOURS_FOR[mode])]);
  const [held, setHeld] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ tube: number; count: number; at: number } | null>(null);
  const tubes = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const board = history[history.length - 1]!;
  const solved = isSolved(board);

  const start = (next: number) => {
    setHistory([generate(seedFor(mode, next), COLOURS_FOR[mode])]);
    setHeld(null);
    setLanded(null);
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
      const width = entry?.contentRect.width ?? 0;
      setScale(width >= 520 && board.length <= 8 ? 1.25 : 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [board.length]);

  useLayoutEffect(() => {
    const el = landed ? tubes.current[landed.tube] : null;
    if (!el || !landed || reducedMotion()) {
      return;
    }
    const layers = [...el.querySelectorAll("[data-layer]")].slice(-landed.count);
    const motions = layers.map((layer, index) =>
      layer.animate(
        [{ transform: "translateY(-14px)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 240, delay: index * 50, easing: EASE_OUT, fill: "backwards" },
      ),
    );
    return () => motions.forEach((motion) => motion.cancel());
  }, [landed]);

  const next = () => {
    if (!solved) {
      return;
    }
    const upcoming = level + 1;
    localStorage.setItem(LEVEL_KEY, JSON.stringify({ ...readLevels(), [mode]: upcoming }));
    setLevel(upcoming);
    start(upcoming);
  };

  const undo = () => {
    if (history.length > 1) {
      setHistory(history.slice(0, -1));
      setHeld(null);
      setLanded(null);
    }
  };

  const restart = () => start(level);

  const tap = (index: number) => {
    if (solved) {
      return;
    }
    if (held === null) {
      if (board[index]!.length > 0) {
        setHeld(index);
      }
      return;
    }
    if (held === index) {
      setHeld(null);
      return;
    }
    if (canPour(board, held, index)) {
      const count = pourCount(board, held, index);
      setHistory([...history, pour(board, held, index)]);
      setLanded({ tube: index, count, at: Date.now() });
      setHeld(null);
    } else if (board[index]!.length > 0) {
      setHeld(index);
    } else {
      setHeld(null);
    }
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

  const moves = history.length - 1;
  const lift = reducedMotion() ? "none" : `transform 160ms ${EASE_OUT}`;

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Colour sort">
      <div data-sort-solved={solved ? "" : undefined} className="relative flex h-full flex-col">
        <Felt className="inset-x-3 top-1 bottom-[52px]" />

        <div className="relative z-10 flex shrink-0 items-baseline justify-center gap-3 pt-4 font-mono text-[11px] text-content/60">
          <span className="text-content/85">Level {level}</span>
          <span>{moves} {moves === 1 ? "pour" : "pours"}</span>
        </div>

        <div ref={box} className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="flex max-w-[420px] flex-wrap items-end justify-center gap-x-3 gap-y-6">
            {board.map((tube, index) => {
              const lifted = held === index;
              const target = held !== null && held !== index && canPour(board, held, index);
              return (
                <button
                  key={index}
                  ref={(el) => {
                    tubes.current[index] = el;
                  }}
                  type="button"
                  tabIndex={-1}
                  data-tube={index}
                  aria-label={`Tube ${index + 1}${tube.length ? `: ${tube.map((c) => NAMES[c]).join(", ")}` : ": empty"}`}
                  aria-pressed={lifted}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => tap(index)}
                  className={`flex cursor-pointer flex-col-reverse items-center gap-[3px] rounded-b-md rounded-t-sm p-[3px] ${
                    target ? "bg-content/20" : "bg-content/[0.09] hover:bg-content/15"
                  }`}
                  style={{
                    height: (20 * TUBE_SIZE + 3 * (TUBE_SIZE - 1)) * scale + 6,
                    transform: lifted ? "translateY(-10px)" : "none",
                    transition: lift,
                  }}
                >
                  {tube.map((colour, layer) => (
                    <Layer key={layer} colour={colour} scale={scale} />
                  ))}
                  {tube.length === 0 ? <div style={{ width: 26 * scale }} /> : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="relative z-10 flex h-[52px] shrink-0 items-center justify-center gap-2">
          {solved ? (
            <>
              <span className="font-mono text-[11px] text-content/70">Sorted in {moves}</span>
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
