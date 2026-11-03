import { lazy, Suspense, useEffect, useState } from "react";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { tableLoaders } from "../gameLoaders";
import { isTableGame } from "../catalog";

const PokerTable = lazy(tableLoaders.poker);
const BlackjackTable = lazy(tableLoaders.blackjack);
const ChessTable = lazy(tableLoaders.chess);
const CodeTable = lazy(tableLoaders.code);
const GardenTable = lazy(tableLoaders.garden);
const SolitaireTable = lazy(tableLoaders.solitaire);
const SortTable = lazy(tableLoaders.sort);
const SudokuTable = lazy(tableLoaders.sudoku);
const MergeTable = lazy(tableLoaders.merge);
const RaceTable = lazy(tableLoaders.race);
const PipelineTable = lazy(tableLoaders.pipeline);
const TurnBetTable = lazy(tableLoaders.turnbet);

/**
 * Fork: poker, blackjack and chess in the games panel. Each table stays mounted
 * once it's been opened, so a hand or a game is still there when you come back.
 */
export function TableGames({
  gameId,
  mode,
  runId,
  open,
  paused,
  waiting,
  onExit,
  onInput,
}: {
  gameId: string;
  mode: ArcadeMode;
  runId: number;
  open: boolean;
  paused: boolean;
  waiting: number;
  onExit: () => void;
  onInput: () => void;
}) {
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([gameId]));
  useEffect(() => {
    if (isTableGame(gameId)) {
      setVisited((seen) => (seen.has(gameId) ? seen : new Set([...seen, gameId])));
    }
  }, [gameId]);

  const tableProps = (id: string) => ({
    mode,
    runId,
    active: open && gameId === id && !(paused && id !== "code"),
    waiting,
    onExit,
    onInput,
  });
  const shown = (id: string) => ({
    style: gameId === id ? undefined : { display: "none" as const },
    "data-table-active": gameId === id ? "" : undefined,
  });

  return (
    <>
      {visited.has("poker") ? (
        <div className="absolute inset-0" {...shown("poker")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <PokerTable {...tableProps("poker")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("blackjack") ? (
        <div className="absolute inset-0" {...shown("blackjack")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <BlackjackTable {...tableProps("blackjack")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("chess") ? (
        <div className="absolute inset-0" {...shown("chess")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <ChessTable {...tableProps("chess")} />
          </Suspense>
        </div>
      ) : null}
      {/* Fork: the Code tab stays mounted like the tables, code and all. */}
      {visited.has("code") ? (
        <div className="absolute inset-0" {...shown("code")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <CodeTable {...tableProps("code")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("garden") ? (
        <div className="absolute inset-0" {...shown("garden")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <GardenTable {...tableProps("garden")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("solitaire") ? (
        <div className="absolute inset-0" {...shown("solitaire")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <SolitaireTable {...tableProps("solitaire")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("sort") ? (
        <div className="absolute inset-0" {...shown("sort")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <SortTable {...tableProps("sort")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("sudoku") ? (
        <div className="absolute inset-0" {...shown("sudoku")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <SudokuTable {...tableProps("sudoku")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("pipeline") ? (
        <div className="absolute inset-0" {...shown("pipeline")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <PipelineTable {...tableProps("pipeline")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("merge") ? (
        <div className="absolute inset-0" {...shown("merge")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <MergeTable {...tableProps("merge")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("race") ? (
        <div className="absolute inset-0" {...shown("race")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <RaceTable {...tableProps("race")} />
          </Suspense>
        </div>
      ) : null}
      {visited.has("turnbet") ? (
        <div className="absolute inset-0" {...shown("turnbet")}>
          <Suspense fallback={<div className="absolute inset-0" />}>
            <TurnBetTable {...tableProps("turnbet")} />
          </Suspense>
        </div>
      ) : null}
    </>
  );
}
