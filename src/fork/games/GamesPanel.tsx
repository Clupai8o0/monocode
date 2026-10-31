import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GlassBackdrop } from "../../app/shell/GlassBackdrop";
import {
  ARCADE_MODES,
  type ArcadeMode,
} from "../../features/terminal/arcade/gridArcade";
import { GRID_GAMES } from "../../features/terminal/arcade/gridGames";
import { TerminalGridBackground } from "../../features/terminal/ui/TerminalGridBackground";
import { LAYER } from "../../shared/lib/layers";
import { useAgentActivity } from "../backgroundAgents/runningAgents";
import {
  DEFAULT_GAME,
  DEFAULT_SIZES,
  activityLabel,
  activityNotice,
  gamesPanel,
  loadBest,
  loadFullscreen,
  loadLastGame,
  loadSizes,
  saveBest,
  saveFullscreen,
  saveLastGame,
  saveSizes,
  type BestScores,
  type PanelKind,
  type PanelSize,
  type PanelSizes,
} from "./gamesPanelStore";
// Fork: poker, blackjack and chess share the panel with the grid games.
import {
  TABLE_GAMES,
  TableGames,
  TableScore,
  isTableGame,
  tableHint,
} from "./table/TableGames";

/**
 * Fork: a floating panel that plays the grid games. It isn't modal, so the chat
 * underneath keeps working; the game simply pauses whenever the board doesn't
 * have the keyboard. Hiding is display:none, which parks the board's draw loop
 * and keeps the game where it was.
 */

/** Clear of the footer and the window's edge. */
const MARGIN = 10;
const FOOTER = 34;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 360;

/** The largest the panel may be: full screen is this and nothing more. */
function room(): PanelSize {
  return {
    width: Math.max(0, window.innerWidth - MARGIN * 2),
    height: Math.max(0, window.innerHeight - FOOTER - MARGIN),
  };
}

function clampSize(size: PanelSize, max: PanelSize): PanelSize {
  return {
    width: Math.min(
      Math.max(size.width, Math.min(MIN_WIDTH, max.width)),
      max.width,
    ),
    height: Math.min(
      Math.max(size.height, Math.min(MIN_HEIGHT, max.height)),
      max.height,
    ),
  };
}

function withSize(
  sizes: PanelSizes,
  kind: PanelKind,
  size: PanelSize,
): PanelSizes {
  return kind === "grid" ? { ...sizes, grid: size } : { ...sizes, table: size };
}

const CHIP =
  "h-6 cursor-pointer whitespace-nowrap rounded px-1.5 text-[11px] leading-none";
const CHIP_ON = "bg-content/10 text-content";
const CHIP_OFF = "text-content/50 hover:bg-content/10 hover:text-content";

type ResizeAxis = "both" | "x" | "y";

type ResizeSession = {
  axis: ResizeAxis;
  kind: PanelKind;
  pointerId: number;
  startX: number;
  startY: number;
  startSize: PanelSize;
  size: PanelSize;
};

export function GamesPanel() {
  const open = useSyncExternalStore(gamesPanel.subscribe, gamesPanel.isOpen);
  const activity = useAgentActivity();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [gameId, setGameId] = useState(() =>
    loadLastGame([...GRID_GAMES, ...TABLE_GAMES].map((game) => game.id)),
  );
  const [mode, setMode] = useState<ArcadeMode>("mid");
  const [runId, setRunId] = useState(0);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Fork: a pause you asked for, which hiding the panel keeps.
  const [userPaused, setUserPaused] = useState(false);
  const [stats, setStats] = useState({ score: 0, lives: 0, over: false });
  const [best, setBest] = useState<BestScores>(loadBest);
  // Fork: grid games and tables are sized apart, and full screen is a choice.
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const [bounds, setBounds] = useState(room);
  const [fullscreen, setFullscreen] = useState(loadFullscreen);
  const resizing = useRef<ResizeSession | null>(null);

  // Fork: a table game leaves the grid board parked on its last game.
  const atTable = isTableGame(gameId);
  const tableOpened = useRef(atTable);
  tableOpened.current ||= atTable;
  const lastGrid = useRef(DEFAULT_GAME);
  if (!atTable) {
    lastGrid.current = gameId;
  }
  const gridId = lastGrid.current;
  const [tableRun, setTableRun] = useState(0);
  const game = GRID_GAMES.find((item) => item.id === gridId) ?? GRID_GAMES[0]!;
  const paused = !open || !focused || notice !== null || atTable || userPaused;
  const kind: PanelKind = atTable ? "table" : "grid";
  const size = clampSize(sizes[kind], bounds);

  // A smaller window takes room back from a panel made for a bigger one.
  useEffect(() => {
    const fit = () => setBounds(room());
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Where focus goes back to on hiding. Read before the board's effect takes it.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && !root.current?.contains(active)) {
      returnFocus.current = active;
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      return;
    }
    setNotice(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, [open]);

  // Only a change while the panel's up is worth stopping a game for.
  const seen = useRef(activity);
  useEffect(() => {
    const message = activityNotice(seen.current, activity);
    seen.current = activity;
    if (message && gamesPanel.isOpen()) {
      setNotice(message);
    }
  }, [activity]);

  const resume = () => {
    setNotice(null);
    setUserPaused(false);
  };

  const focusBoard = () => {
    root.current
      ?.querySelector<HTMLElement>(
        atTable ? "[data-table-active] [data-table-board]" : "[data-grid-board]",
      )
      ?.focus();
  };

  const pickGame = (id: string) => {
    resume();
    setGameId(id);
    saveLastGame(id);
    focusBoard();
  };

  const pickMode = (next: ArcadeMode) => {
    resume();
    setMode(next);
    focusBoard();
  };

  const newGame = () => {
    resume();
    // Fork: a table restarting leaves the parked grid game alone.
    (atTable ? setTableRun : setRunId)((value) => value + 1);
    focusBoard();
  };

  // Fork: P parks a grid game where it is, and brings it back.
  const togglePause = () => {
    if (userPaused || notice) {
      resume();
      return;
    }
    if (!stats.over) {
      setUserPaused(true);
    }
  };

  // Fork: fills the window, but never the footer. Not the OS's own full screen.
  const toggleFullscreen = () => {
    setFullscreen((current) => {
      const next = !current;
      saveFullscreen(next);
      return next;
    });
  };

  const startResize =
    (axis: ResizeAxis) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || fullscreen) {
        return;
      }
      // This press is the grip's, not the header's or the board's.
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const start = clampSize(sizesRef.current[kind], room());
      resizing.current = {
        axis,
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startSize: start,
        size: start,
      };
    };

  const resizeTo = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizing.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const next = clampSize(
      {
        width:
          session.axis === "y"
            ? session.startSize.width
            : session.startSize.width + session.startX - event.clientX,
        height:
          session.axis === "x"
            ? session.startSize.height
            : session.startSize.height + session.startY - event.clientY,
      },
      room(),
    );
    session.size = next;
    const updated = withSize(sizesRef.current, session.kind, next);
    sizesRef.current = updated;
    setSizes(updated);
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizing.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    resizing.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    // Written once the drag ends, never on every step.
    saveSizes(withSize(sizesRef.current, session.kind, session.size));
  };

  const resetSize = () => {
    const next = withSize(sizesRef.current, kind, DEFAULT_SIZES[kind]);
    sizesRef.current = next;
    setSizes(next);
    saveSizes(next);
  };

  const onStats = (score: number, lives: number, over: boolean) => {
    setStats({ score, lives, over });
    setBest((current) => {
      if (score <= (current[gridId] ?? 0)) {
        return current;
      }
      const next = { ...current, [gridId]: score };
      saveBest(next);
      return next;
    });
  };

  // Fork: a drill has no clock, and a finished grid game has nothing to pause.
  const canPause = atTable ? gameId !== "code" : !stats.over;

  const status = notice
    ? notice
    : userPaused
      ? atTable
        ? "paused · click to resume"
        : "paused · P or click to resume"
      : atTable
        ? null
        : stats.over
          ? game.hasAction
            ? "game over · space to retry"
            : "game over"
          : !focused && open
            ? "paused · click to play"
            : null;

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Games"
      data-fork-games-panel=""
      onKeyDown={(event) => {
        // Fork: a parked table ignores keys, so Esc is heard here instead.
        if (userPaused && atTable && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          gamesPanel.hide();
        }
      }}
      style={{
        zIndex: LAYER.popover,
        right: MARGIN,
        bottom: FOOTER,
        ...(fullscreen
          ? { left: MARGIN, top: MARGIN }
          : { width: size.width, height: size.height }),
        display: open ? undefined : "none",
      }}
      className="fixed isolate flex flex-col overflow-hidden rounded-xl border border-content/10 text-content shadow-xl"
    >
      <GlassBackdrop />
      <header
        className="relative z-[1] flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-2 pb-1.5"
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Game">
          {[...GRID_GAMES, ...TABLE_GAMES].map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={item.id === gameId}
              className={`${CHIP} ${item.id === gameId ? CHIP_ON : CHIP_OFF}`}
              onClick={() => pickGame(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5" aria-label="Difficulty">
          {ARCADE_MODES.map((id) => (
            <button
              key={id}
              type="button"
              tabIndex={-1}
              aria-pressed={mode === id}
              className={`${CHIP} ${mode === id ? CHIP_ON : CHIP_OFF}`}
              onClick={() => pickMode(id)}
            >
              {id}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {canPause ? (
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={userPaused}
              data-fork-games-pause=""
              className={`${CHIP} ${userPaused ? CHIP_ON : CHIP_OFF}`}
              onClick={() => {
                if (userPaused) {
                  resume();
                  focusBoard();
                } else {
                  setUserPaused(true);
                }
              }}
            >
              {userPaused ? "Resume" : "Pause"}
            </button>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            className={`${CHIP} ${CHIP_OFF}`}
            onClick={newGame}
          >
            New game
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-pressed={fullscreen}
            data-fork-games-fullscreen=""
            className={`${CHIP} ${fullscreen ? CHIP_ON : CHIP_OFF}`}
            onClick={toggleFullscreen}
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={`${CHIP} ${CHIP_OFF}`}
            onClick={() => gamesPanel.hide()}
          >
            Hide
          </button>
        </div>
      </header>
      <div className="relative z-[1] flex shrink-0 items-center gap-3 px-3 pb-1.5 font-mono text-[11px] tabular-nums text-content/55">
        {atTable ? (
          <TableScore gameId={gameId} />
        ) : (
          <>
            <span data-fork-games-score={stats.score}>score {stats.score}</span>
            <span className="text-content/35">best {best[gameId] ?? 0}</span>
          </>
        )}
        {!atTable && game.lives ? (
          <span className="text-content/35" aria-label={`${stats.lives} lives`}>
            {"•".repeat(stats.lives)}
          </span>
        ) : null}
        <span className="ml-auto truncate text-content/35">
          {activityLabel(activity) || (atTable ? tableHint(gameId) : game.hint)}
        </span>
      </div>
      <div
        className={`relative z-[1] min-h-0 flex-1 ${atTable ? "" : "cursor-pointer"}`}
        onMouseDown={() => {
          resume();
          if (!atTable) {
            focusBoard();
          }
        }}
      >
        <div
          className="absolute inset-0"
          style={atTable ? { display: "none" } : undefined}
        >
          {/* Mounted with the panel, so it's only ever made once it's wanted. */}
          <TerminalGridBackground
            host={{
              gameId: gridId,
              mode,
              runId,
              paused,
              active: open && !atTable,
              onStats,
              onExit: () => gamesPanel.hide(),
              onFocusChange: setFocused,
              onInput: resume,
              onPauseKey: togglePause,
              onFullscreenKey: toggleFullscreen,
            }}
          />
        </div>
        {tableOpened.current ? (
          <TableGames
            gameId={gameId}
            mode={mode}
            runId={tableRun}
            open={open}
            paused={!open || userPaused}
            waiting={activity.waiting}
            onExit={() => gamesPanel.hide()}
            onInput={resume}
          />
        ) : null}
        {status ? (
          <div
            className={`absolute inset-0 z-30 grid place-items-center ${
              userPaused
                ? "pointer-events-auto cursor-pointer"
                : "pointer-events-none"
            }`}
            onMouseDown={
              userPaused
                ? (event) => {
                    // A click here resumes; it must not also reach the hand.
                    event.preventDefault();
                    event.stopPropagation();
                  }
                : undefined
            }
            onClick={
              userPaused
                ? () => {
                    resume();
                    focusBoard();
                  }
                : undefined
            }
          >
            <span
              role="status"
              className="bg-background-base/85 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-content/85"
            >
              {status}
            </span>
          </div>
        ) : null}
      </div>
      {fullscreen ? null : (
        <>
          <div
            aria-hidden="true"
            data-fork-games-resize-edge="left"
            className="absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-ew-resize touch-none"
            onPointerDown={startResize("x")}
            onPointerMove={resizeTo}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div
            aria-hidden="true"
            data-fork-games-resize-edge="top"
            className="absolute top-0 right-0 left-0 z-10 h-1.5 cursor-ns-resize touch-none"
            onPointerDown={startResize("y")}
            onPointerMove={resizeTo}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div
            role="separator"
            aria-label="Resize games"
            data-fork-games-resize=""
            tabIndex={-1}
            className="absolute top-0 left-0 z-20 grid h-3.5 w-3.5 cursor-nwse-resize touch-none place-items-center text-content/25 outline-none hover:text-content/50"
            onPointerDown={startResize("both")}
            onPointerMove={resizeTo}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              resetSize();
            }}
          >
            <span aria-hidden="true" className="grid grid-cols-2 gap-[3px]">
              {Array.from({ length: 4 }, (_, index) => (
                <span
                  key={index}
                  className="h-[2px] w-[2px] rounded-full bg-current"
                />
              ))}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
