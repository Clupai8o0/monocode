import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ARCADE_MODES,
  type ArcadeMode,
} from "../../features/terminal/arcade/gridArcade";
import { GRID_GAMES } from "../../features/terminal/arcade/gridGames";
import {
  TerminalGridBackground,
  type GridGameHost,
} from "../../features/terminal/ui/TerminalGridBackground";
import { LAYER } from "../../shared/lib/layers";
import {
  Maximize2,
  Minus,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
} from "../../shared/ui/icons";
import {
  useAgentActivity,
  waitingSessionId,
} from "../backgroundAgents/runningAgents";
import { openOwnSession } from "../sessionRefs/sessionRefs";
// Fork: finished agent work grows the garden, open or not.
import { noteAgentActivity } from "./calm/garden";
import {
  clampDockWidth,
  loadDockWidth,
  saveDockWidth,
  DEFAULT_GAME,
  DEFAULT_SIZES,
  activityLabel,
  activityNotice,
  gamePopups,
  gamesPanel,
  loadFullscreen,
  loadLastGame,
  loadSizes,
  saveFullscreen,
  saveLastGame,
  saveSizes,
  type PanelKind,
  type PanelSize,
  type PanelSizes,
} from "./gamesPanelStore";
import { ChipSelect, IconButton } from "./ChipSelect";
// Fork: poker, blackjack and chess share the panel with the grid games.
import { TableGames } from "./table/TableGames";
import { TableScore } from "./table/TableScore";
import { ALL_GAMES, gameEntry, isTableGame } from "./catalog";
import { GamePicker } from "./GamePicker";
import {
  flushBest,
  liveScore,
  reportScore,
  subscribeLiveScore,
} from "./liveScore";
import "./games.css";

/**
 * Fork: a floating panel that plays the grid games. It isn't modal, so the chat
 * underneath keeps working; the game simply pauses whenever the board doesn't
 * have the keyboard. Hiding is display:none, which parks the board's draw loop
 * and keeps the game where it was.
 *
 * Nothing that changes while you play re-renders this: the score goes straight
 * to its readout, and a drag writes the size to the DOM until it ends. The board
 * and the tables only hear about what they use.
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

const GAME_IDS = ALL_GAMES.map((entry) => entry.id);
const MODE_OPTIONS = ARCADE_MODES.map((id) => ({ id, label: id }));

type ResizeAxis = "both" | "x" | "y";

type ResizeSession = {
  axis: ResizeAxis;
  /** Side by side, only the width changes, and it is the dock's. */
  docked: boolean;
  kind: PanelKind;
  pointerId: number;
  startX: number;
  startY: number;
  startSize: PanelSize;
  size: PanelSize;
  /** Where the pointer is now; drawn once a frame, however fast it reports. */
  x: number;
  y: number;
  frame: number | null;
};

const MemoGrid = memo(TerminalGridBackground);
const MemoTables = memo(TableGames);

/** Jumps to a session from a panel that may be in a window without one. */
async function goToSession(id: string) {
  try {
    await openOwnSession(id);
  } catch {
    // Outside the app there's no session to open.
  }
}

/** The one thing here that changes many times a second. */
function GridScore({ gameId, showLives }: { gameId: string; showLives: boolean }) {
  const { score, lives, best } = useSyncExternalStore(
    subscribeLiveScore,
    liveScore,
    liveScore,
  );
  return (
    <>
      <span data-fork-games-score={score}>score {score}</span>
      <span className="text-content/35">best {best[gameId] ?? 0}</span>
      {showLives ? (
        <span className="text-content/35" aria-label={`${lives} lives`}>
          {"•".repeat(lives)}
        </span>
      ) : null}
    </>
  );
}

export function GamesPanel() {
  const open = useSyncExternalStore(gamesPanel.subscribe, gamesPanel.isOpen);
  const docked = useSyncExternalStore(gamesPanel.subscribe, gamesPanel.isDocked);
  const activity = useAgentActivity();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [gameId, setGameId] = useState(() =>
    loadLastGame(GAME_IDS),
  );
  const [mode, setMode] = useState<ArcadeMode>("mid");
  const [runId, setRunId] = useState(0);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Fork: a pause you asked for, which hiding the panel keeps.
  const [userPaused, setUserPaused] = useState(false);
  const [over, setOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Fork: grid games and tables are sized apart, and full screen is a choice.
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const [bounds, setBounds] = useState(room);
  const [fullscreen, setFullscreen] = useState(loadFullscreen);
  const resizing = useRef<ResizeSession | null>(null);
  // Fork: side by side with the app (Ask Dojo docks it there).
  const [dockWanted, setDockWanted] = useState(
    () => loadDockWidth() ?? Math.round(window.innerWidth * 0.45),
  );
  const dockWidth = clampDockWidth(dockWanted, bounds.width, MIN_WIDTH);

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
  const entry = gameEntry(gameId);

  // A smaller window takes room back from a panel made for a bigger one.
  useEffect(() => {
    const fit = () => setBounds(room());
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Side by side, the app narrows to the space left of the panel, so
  // neither covers the other. Hiding gives the app its width back.
  useEffect(() => {
    const appRoot = document.getElementById("root");
    if (!appRoot || !open || !docked) {
      return;
    }
    appRoot.style.width = `calc(100% - ${dockWidth + MARGIN * 2}px)`;
    return () => {
      appRoot.style.width = "";
    };
  }, [open, docked, dockWidth]);

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
    noteAgentActivity(activity, Date.now());
  }, [activity]);
  useEffect(() => {
    const message = activityNotice(seen.current, activity);
    seen.current = activity;
    if (message && gamesPanel.isOpen()) {
      setNotice(message);
    }
  }, [activity]);

  // A best waiting on its timer goes to disk once the run or the panel is done.
  useEffect(() => {
    if (over || !open) {
      flushBest();
    }
  }, [over, open]);

  const resume = useCallback(() => {
    setNotice(null);
    setUserPaused(false);
  }, []);

  // Esc on a dropdown is the dropdown's; the board hears it first.
  const hideFromKey = useCallback(() => {
    if (!gamePopups.anyOpen()) {
      gamesPanel.hide();
    }
  }, []);

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

  // What the board's stable callbacks read when they fire.
  const latest = useRef({ userPaused, notice, over, gridId });
  latest.current = { userPaused, notice, over, gridId };

  // Fork: P parks a grid game where it is, and brings it back.
  const togglePause = useCallback(() => {
    const now = latest.current;
    if (now.userPaused || now.notice) {
      resume();
      return;
    }
    if (!now.over) {
      setUserPaused(true);
    }
  }, [resume]);

  // Fork: fills the window, but never the footer. Not the OS's own full screen.
  const toggleFullscreen = useCallback(() => {
    // Side by side has no full screen; F waits until the panel floats again.
    if (gamesPanel.isDocked()) {
      return;
    }
    setFullscreen((current) => {
      const next = !current;
      saveFullscreen(next);
      return next;
    });
  }, []);

  const onStats = useCallback((score: number, lives: number, ended: boolean) => {
    reportScore(latest.current.gridId, score, lives);
    setOver(ended);
  }, []);

  const hostActive = open && !atTable;
  const host = useMemo<GridGameHost>(
    () => ({
      gameId: gridId,
      mode,
      runId,
      paused,
      active: hostActive,
      onStats,
      onExit: hideFromKey,
      onFocusChange: setFocused,
      onInput: resume,
      onPauseKey: togglePause,
      onFullscreenKey: toggleFullscreen,
    }),
    [
      gridId,
      mode,
      runId,
      paused,
      hostActive,
      onStats,
      hideFromKey,
      resume,
      togglePause,
      toggleFullscreen,
    ],
  );

  /** Takes you to whoever is waiting. Docked, the app is already beside the game. */
  const openWaiting = () => {
    const id = waitingSessionId();
    setNotice(null);
    if (!id) {
      return;
    }
    if (!gamesPanel.isDocked()) {
      gamesPanel.hide();
    }
    void goToSession(id);
  };

  const startResize =
    (axis: ResizeAxis) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (fullscreen && !docked)) {
        return;
      }
      // This press is the grip's, not the header's or the board's.
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const start = docked
        ? { width: dockWidth, height: 0 }
        : clampSize(sizesRef.current[kind], room());
      resizing.current = {
        axis: docked ? "x" : axis,
        docked,
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startSize: start,
        size: start,
        x: event.clientX,
        y: event.clientY,
        frame: null,
      };
    };

  /** Draws a drag straight to the DOM, so the panel and the app don't re-render for it. */
  const drawResize = (session: ResizeSession) => {
    const panel = root.current;
    if (session.docked) {
      const width = clampDockWidth(
        session.startSize.width + session.startX - session.x,
        // The margins come out first, so the app keeps its full minimum.
        window.innerWidth - MARGIN * 2,
        MIN_WIDTH,
      );
      session.size = { width, height: 0 };
      if (panel) {
        panel.style.width = `${width}px`;
      }
      return;
    }
    const next = clampSize(
      {
        width:
          session.axis === "y"
            ? session.startSize.width
            : session.startSize.width + session.startX - session.x,
        height:
          session.axis === "x"
            ? session.startSize.height
            : session.startSize.height + session.startY - session.y,
      },
      room(),
    );
    session.size = next;
    if (panel) {
      panel.style.width = `${next.width}px`;
      panel.style.height = `${next.height}px`;
    }
  };

  const resizeTo = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizing.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    session.x = event.clientX;
    session.y = event.clientY;
    session.frame ??= requestAnimationFrame(() => {
      session.frame = null;
      drawResize(session);
    });
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
    if (session.frame !== null) {
      cancelAnimationFrame(session.frame);
      session.frame = null;
    }
    session.x = event.clientX;
    session.y = event.clientY;
    drawResize(session);
    // State, the app beside a docked panel and the disk all hear once, at the end.
    if (session.docked) {
      setDockWanted(session.size.width);
      saveDockWidth(session.size.width);
      return;
    }
    const updated = withSize(sizesRef.current, session.kind, session.size);
    sizesRef.current = updated;
    setSizes(updated);
    saveSizes(updated);
  };

  const resetSize = () => {
    const next = withSize(sizesRef.current, kind, DEFAULT_SIZES[kind]);
    sizesRef.current = next;
    setSizes(next);
    saveSizes(next);
  };

  // Fork: a drill has no clock, and a finished grid game has nothing to pause.
  const canPause = atTable ? gameId !== "code" : !over;

  const status = notice
    ? notice
    : userPaused
      ? atTable
        ? "paused · click to resume"
        : "paused · P or click to resume"
      : atTable
        ? null
        : over
          ? game.hasAction
            ? "game over · space to retry"
            : "game over"
          : !focused && open
            ? "paused · click to play"
            : null;
  const label = activityLabel(activity);

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Games"
      data-fork-games-panel=""
      data-docked={docked ? "" : undefined}
      onKeyDown={(event) => {
        // Fork: a parked table ignores keys, so Esc is heard here instead.
        if (userPaused && atTable && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          hideFromKey();
        }
      }}
      style={{
        zIndex: LAYER.popover,
        right: MARGIN,
        // Side by side, the footer sits in the narrowed app, not under this.
        bottom: docked ? MARGIN : FOOTER,
        ...(docked
          ? { top: MARGIN, width: dockWidth }
          : fullscreen
            ? { left: MARGIN, top: MARGIN }
            : { width: size.width, height: size.height }),
        display: open ? undefined : "none",
      }}
      className={`fixed isolate flex flex-col overflow-hidden rounded-xl border border-content/10 text-content ${
        docked ? "" : "shadow-xl"
      }`}
    >
      <header
        className="flex h-10 shrink-0 items-center gap-1.5 pr-2 pl-3"
        onMouseDown={(event) => event.preventDefault()}
      >
        <GamePicker
          value={gameId}
          onPick={pickGame}
          onOpenChange={setPickerOpen}
        />
        {entry?.usesMode === false ? null : (
          <ChipSelect
            label="Difficulty"
            value={mode}
            options={MODE_OPTIONS}
            onChange={pickMode}
            width={110}
          />
        )}
        <div className="ml-1.5 flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap font-mono text-[11px] tabular-nums text-content/55">
          {atTable ? (
            <TableScore gameId={gameId} />
          ) : (
            <GridScore gameId={gameId} showLives={game.lives} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {canPause ? (
            <IconButton
              icon={userPaused ? Play : Pause}
              label={userPaused ? "Resume" : "Pause"}
              pressed={userPaused}
              data-fork-games-pause=""
              onClick={() => {
                if (userPaused) {
                  resume();
                  focusBoard();
                } else {
                  setUserPaused(true);
                }
              }}
            />
          ) : null}
          <IconButton icon={RotateCcw} label="New game" onClick={newGame} />
          <IconButton
            icon={PanelRight}
            label="Side by side"
            pressed={docked}
            data-fork-games-dock=""
            onClick={() => gamesPanel.dock(!docked)}
          />
          {docked ? null : (
            <IconButton
              icon={Maximize2}
              label={fullscreen ? "Exit full screen" : "Full screen"}
              pressed={fullscreen}
              data-fork-games-fullscreen=""
              onClick={toggleFullscreen}
            />
          )}
          <IconButton icon={Minus} label="Hide" onClick={() => gamesPanel.hide()} />
        </div>
      </header>
      <div
        className={`relative isolate min-h-0 flex-1 ${atTable ? "" : "cursor-pointer"}`}
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
          <MemoGrid host={host} />
        </div>
        {tableOpened.current ? (
          <MemoTables
            gameId={gameId}
            mode={mode}
            runId={tableRun}
            open={open}
            paused={!open || userPaused}
            waiting={activity.waiting}
            onExit={hideFromKey}
            onInput={resume}
          />
        ) : null}
        <div key={gameId} aria-hidden="true" className="games-swap" />
        {status && !pickerOpen ? (
          <div
            data-fork-games-status=""
            className={`absolute inset-0 z-30 grid justify-items-center ${
              notice ? "items-start pt-3" : "items-center"
            } ${userPaused ? "pointer-events-auto cursor-pointer" : "pointer-events-none"}`}
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
            <div className="games-card">
              {notice === "An agent needs you" ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-amber-400"
                />
              ) : null}
              <span
                role="status"
                className="min-w-0 truncate font-mono text-[11px] tracking-[0.04em] text-content/85"
              >
                {status}
              </span>
              {notice ? (
                <span className="flex shrink-0 items-center gap-1">
                  {notice === "An agent needs you" ? (
                    <button
                      type="button"
                      data-fork-games-open-session=""
                      className="games-action games-action-primary"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        openWaiting();
                      }}
                    >
                      Open session
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="games-action"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      resume();
                      focusBoard();
                    }}
                  >
                    Keep playing
                  </button>
                </span>
              ) : over && !atTable && !userPaused ? (
                <button
                  type="button"
                  data-fork-games-again=""
                  className="games-action games-action-primary"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={newGame}
                >
                  Play again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <div
        data-fork-games-foot=""
        className="flex h-6 shrink-0 items-center gap-3 px-3 font-mono text-[11px] text-content/40"
        onMouseDown={(event) => event.preventDefault()}
      >
        <span className="min-w-0 truncate">{entry?.hint}</span>
        {label ? (
          activity.waiting ? (
            <button
              type="button"
              tabIndex={-1}
              title="Open the session that needs you"
              className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1 text-content/70 transition-colors duration-100 hover:bg-content/10 hover:text-content"
              onClick={openWaiting}
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-400" />
              {label}
            </button>
          ) : (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-content/25" />
              {label}
            </span>
          )
        ) : null}
      </div>
      {docked ? (
        <div
          aria-hidden="true"
          data-fork-games-resize-edge="left"
          className="absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-ew-resize touch-none"
          onPointerDown={startResize("x")}
          onPointerMove={resizeTo}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ) : fullscreen ? null : (
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
            className="absolute top-0 left-0 z-20 grid h-3 w-3 cursor-nwse-resize touch-none place-items-center text-content/50 opacity-0 outline-none transition-opacity duration-100 hover:opacity-100"
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
