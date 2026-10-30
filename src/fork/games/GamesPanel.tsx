import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
  activityLabel,
  activityNotice,
  gamesPanel,
  loadBest,
  loadLastGame,
  saveBest,
  saveLastGame,
  type BestScores,
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

const WIDTH = 600;
// Fork: 520 plus the second header row all the tabs now need at this width,
// so a grid game's board stays the size it was.
const HEIGHT = 548;
const TABLE_WIDTH = 720;
const TABLE_HEIGHT = 560;
/** Clear of the footer and the window's edge. */
const MARGIN = 10;
const FOOTER = 34;

const CHIP =
  "h-6 cursor-pointer whitespace-nowrap rounded px-1.5 text-[11px] leading-none";
const CHIP_ON = "bg-content/10 text-content";
const CHIP_OFF = "text-content/50 hover:bg-content/10 hover:text-content";

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
  const [stats, setStats] = useState({ score: 0, lives: 0, over: false });
  const [best, setBest] = useState<BestScores>(loadBest);

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
  const paused = !open || !focused || notice !== null || atTable;

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

  const resume = () => setNotice(null);

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

  const status = notice
    ? notice
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
      style={{
        zIndex: LAYER.popover,
        right: MARGIN,
        bottom: FOOTER,
        width: `min(${atTable ? TABLE_WIDTH : WIDTH}px, calc(100vw - ${MARGIN * 2}px))`,
        height: `min(${atTable ? TABLE_HEIGHT : HEIGHT}px, calc(100vh - ${FOOTER + MARGIN}px))`,
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
            }}
          />
        </div>
        {tableOpened.current ? (
          <TableGames
            gameId={gameId}
            mode={mode}
            runId={tableRun}
            open={open}
            waiting={activity.waiting}
            onExit={() => gamesPanel.hide()}
            onInput={resume}
          />
        ) : null}
        {status ? (
          <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
            <span
              role="status"
              className="bg-background-base/85 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-content/85"
            >
              {status}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
