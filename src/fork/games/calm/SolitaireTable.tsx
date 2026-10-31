import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { suitOf } from "../table/cards";
import { ActionButton, CardSlot, Felt, PixelCard, TableFrame, reducedMotion, useRandom } from "../table/kit";
import type { TableProps } from "../table/PokerTable";
import { CARD_H, CARD_W } from "../table/sprites";
import {
  apply,
  autoMove,
  canAutoFinish,
  deal,
  drawStock,
  finishStep,
  isLegal,
  isWon,
  last,
  revive,
  undo,
  type From,
  type Move,
  type SolState,
  type To,
} from "./solitaire";

/** Fork: patience on the felt. No clock: take your time. */

const SAVE_KEY = "monocode.fork.games.solitaire";
const SAVED_HISTORY = 60;
const FINISH_MS = 90;
const DRAG_PX = 4;
const SUIT_GLYPHS = ["♣", "♦", "♥", "♠"];

const drawFor = (mode: TableProps["mode"]) => (mode === "hard" ? 3 : 1);

function load(): SolState | null {
  try {
    return revive(JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

function save(state: SolState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...state, history: state.history.slice(-SAVED_HISTORY) }));
  } catch {
    // Only a nicety; the game just won't survive a reload.
  }
}

type Drag = { source: From; x: number; y: number; dx: number; dy: number; moved: boolean };

function sameSource(a: From | undefined, b: From) {
  if (!a || a.from !== b.from) {
    return false;
  }
  if (a.from === "tableau" && b.from === "tableau") {
    return a.pile === b.pile && b.index >= a.index;
  }
  if (a.from === "foundation" && b.from === "foundation") {
    return a.suit === b.suit;
  }
  return true;
}

function readDrop(x: number, y: number): To | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  const value = el?.dataset.drop;
  if (!value) {
    return null;
  }
  if (value === "foundation") {
    return { to: "foundation" };
  }
  return { to: "tableau", pile: Number(value) };
}

export function SolitaireTable({ mode, runId, active, onExit, onInput }: TableProps) {
  const random = useRandom(71);
  const newSeed = useCallback(() => Math.floor(random() * 2 ** 31), [random]);
  const [state, setState] = useState<SolState>(() => load() ?? deal(newSeed(), drawFor(mode)));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [scale, setScale] = useState(3);
  const box = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const firstRun = useRef(runId);

  const commit = useCallback((next: SolState) => {
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
      save(next);
    }
  }, []);

  const newDeal = useCallback(() => {
    commit(deal(newSeed(), drawFor(modeRef.current)));
  }, [commit, newSeed]);

  useEffect(() => {
    if (runId !== firstRun.current) {
      firstRun.current = runId;
      newDeal();
    }
  }, [runId, newDeal]);

  // Cards grow with the panel, in whole pixels.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const fit = () => {
      const width = el.clientWidth - 32;
      const height = el.clientHeight - 90;
      const byWidth = Math.floor(width / (7 * CARD_W + 6 * 3));
      const byHeight = Math.floor(height / (CARD_H * 2 + 6 + 18 * 3));
      setScale(Math.max(2, Math.min(4, byWidth, byHeight)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const won = isWon(state);
  const finishing = canAutoFinish(state);

  useEffect(() => {
    if (!finishing) {
      return;
    }
    const timer = setTimeout(() => {
      const next = finishStep(stateRef.current);
      if (next) {
        commit(next);
      }
    }, reducedMotion() ? 0 : FINISH_MS);
    return () => clearTimeout(timer);
  }, [finishing, state, commit]);

  const clickCard = (source: From) => {
    const move = autoMove(stateRef.current, source);
    if (move) {
      commit(apply(stateRef.current, move));
    }
  };

  const onKey = (key: string) => {
    if (key === "u") {
      commit(undo(stateRef.current));
    } else if (key === "n") {
      newDeal();
    } else if (key === " " || key === "d") {
      commit(drawStock(stateRef.current));
    }
  };

  const startDrag = (source: From) => (event: ReactPointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ source, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false });
  };

  const moveDrag = (event: ReactPointerEvent) => {
    setDrag((current) => {
      if (!current) {
        return current;
      }
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      return { ...current, dx, dy, moved: current.moved || Math.hypot(dx, dy) > DRAG_PX };
    });
  };

  const endDrag = (event: ReactPointerEvent) => {
    const current = drag;
    setDrag(null);
    if (!current) {
      return;
    }
    if (!current.moved) {
      clickCard(current.source);
      return;
    }
    const dest = readDrop(event.clientX, event.clientY);
    if (dest) {
      const move: Move = { ...current.source, dest };
      if (isLegal(stateRef.current, move)) {
        commit(apply(stateRef.current, move));
      }
    }
  };

  const cardW = CARD_W * scale;
  const cardH = CARD_H * scale;
  const downStep = 3 * scale;
  const upStep = 7 * scale;

  const dragStyle = (source: From) =>
    drag?.moved && sameSource(drag.source, source)
      ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 30, pointerEvents: "none" as const }
      : undefined;

  const handlers = (source: From) => ({
    onPointerDown: startDrag(source),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: () => setDrag(null),
  });

  const wasteShown = state.waste.slice(state.draw === 3 ? -3 : -1);
  const fan = Math.round(5 * scale);

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Solitaire">
      <div ref={box} className="relative flex h-full flex-col items-center px-4 py-3">
        <Felt className="inset-2" />
        <div className="relative flex flex-col gap-3" style={{ width: cardW * 7 + 3 * scale * 6 }}>
          <div className="flex justify-between">
            <div className="flex" style={{ gap: 3 * scale }}>
              <button
                type="button"
                tabIndex={-1}
                aria-label={state.stock.length > 0 ? "Draw from the stock" : "Turn the waste over"}
                data-sol="stock"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(drawStock(stateRef.current))}
                className="cursor-pointer"
              >
                {state.stock.length > 0 ? <PixelCard card={null} scale={scale} /> : <CardSlot scale={scale} />}
              </button>
              <div className="relative" style={{ width: cardW + fan * 2, height: cardH }} data-sol="waste">
                {wasteShown.length === 0 ? <CardSlot scale={scale} /> : null}
                {wasteShown.map((card, index) => {
                  const top = index === wasteShown.length - 1;
                  return (
                    <span
                      key={card}
                      className={`absolute top-0 ${top ? "cursor-pointer touch-none" : ""}`}
                      style={{ left: index * fan, ...(top ? dragStyle({ from: "waste" }) : undefined) }}
                      {...(top ? handlers({ from: "waste" }) : {})}
                    >
                      <PixelCard card={card} scale={scale} />
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="flex" style={{ gap: 3 * scale }} data-drop="foundation">
              {state.foundations.map((pile, suit) => {
                const top = last(pile, 1);
                return (
                  <div key={suit} className="relative" style={{ width: cardW, height: cardH }} data-foundation={suit}>
                    {pile.length > 1 ? (
                      <span className="absolute inset-0">
                        <PixelCard card={last(pile, 2)!} scale={scale} />
                      </span>
                    ) : (
                      <span className="absolute inset-0 grid place-items-center">
                        <CardSlot scale={scale} />
                        <span className="absolute font-mono text-[14px] text-content/25" aria-hidden>
                          {SUIT_GLYPHS[suit]}
                        </span>
                      </span>
                    )}
                    {top !== undefined ? (
                      <span
                        className="absolute inset-0 cursor-grab touch-none"
                        style={dragStyle({ from: "foundation", suit: suitOf(top) })}
                        {...handlers({ from: "foundation", suit })}
                      >
                        <PixelCard card={top} scale={scale} />
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex" style={{ gap: 3 * scale }}>
            {state.tableau.map((pile, pileIndex) => {
              let offset = 0;
              const tops = pile.map((slot) => {
                const top = offset;
                offset += slot.up ? upStep : downStep;
                return top;
              });
              const height = (last(tops, 1) ?? 0) + cardH;
              return (
                <div
                  key={pileIndex}
                  data-drop={pileIndex}
                  className="relative"
                  style={{ width: cardW, height: Math.max(height, cardH) + upStep }}
                >
                  {pile.length === 0 ? <CardSlot scale={scale} /> : null}
                  {pile.map((slot, index) => {
                    const source: From = { from: "tableau", pile: pileIndex, index };
                    return (
                      <span
                        key={slot.card}
                        className={`absolute left-0 ${slot.up ? "cursor-pointer touch-none" : ""}`}
                        style={{ top: tops[index], ...(slot.up ? dragStyle(source) : undefined) }}
                        {...(slot.up ? handlers(source) : {})}
                      >
                        <PixelCard card={slot.up ? slot.card : null} scale={scale} />
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div className="relative mt-auto flex items-center gap-2 pt-2">
          <span className="font-mono text-[11px] tabular-nums text-content/60" data-sol-moves={state.moves}>
            {state.moves} {state.moves === 1 ? "move" : "moves"}
          </span>
          <ActionButton
            label="Undo"
            keyHint="U"
            data-action="undo"
            disabled={state.history.length === 0}
            onClick={() => commit(undo(stateRef.current))}
          />
          <ActionButton label="New deal" keyHint="N" data-action="new" primary={won} onClick={newDeal} />
        </div>
        {won ? (
          <div role="status" className="pointer-events-none absolute inset-x-0 top-1/3 grid place-items-center">
            <span className="table-bubble rounded-sm bg-[var(--table-felt)] px-3 py-2 font-mono text-[12px] text-content/90">
              All home, in {state.moves} moves. Nicely done.
            </span>
          </div>
        ) : null}
      </div>
    </TableFrame>
  );
}
