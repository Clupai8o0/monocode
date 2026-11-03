import { useEffect, useState } from "react";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { BlackjackTable } from "./BlackjackTable";
import { ChessTable } from "./ChessTable";
import { PokerTable } from "./PokerTable";
// Fork: coding drills share the panel's table slot (src/fork/games/code).
import { CodeTable } from "../code/CodeTable";
// Fork: calm games (src/fork/games/calm).
import { GardenTable } from "../calm/GardenTable";
import { SolitaireTable } from "../calm/SolitaireTable";
import { SortTable } from "../calm/SortTable";
import { SudokuTable } from "../calm/SudokuTable";
import { MergeTable } from "../calm/MergeTable";
import { RaceTable } from "../calm/RaceTable";
import { PipelineTable } from "../calm/PipelineTable";
import { TurnBetTable } from "../calm/TurnBetTable";
import { isTableGame } from "../catalog";

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
          <PokerTable {...tableProps("poker")} />
        </div>
      ) : null}
      {visited.has("blackjack") ? (
        <div className="absolute inset-0" {...shown("blackjack")}>
          <BlackjackTable {...tableProps("blackjack")} />
        </div>
      ) : null}
      {visited.has("chess") ? (
        <div className="absolute inset-0" {...shown("chess")}>
          <ChessTable {...tableProps("chess")} />
        </div>
      ) : null}
      {/* Fork: the Code tab stays mounted like the tables, code and all. */}
      {visited.has("code") ? (
        <div className="absolute inset-0" {...shown("code")}>
          <CodeTable {...tableProps("code")} />
        </div>
      ) : null}
      {visited.has("garden") ? (
        <div className="absolute inset-0" {...shown("garden")}>
          <GardenTable {...tableProps("garden")} />
        </div>
      ) : null}
      {visited.has("solitaire") ? (
        <div className="absolute inset-0" {...shown("solitaire")}>
          <SolitaireTable {...tableProps("solitaire")} />
        </div>
      ) : null}
      {visited.has("sort") ? (
        <div className="absolute inset-0" {...shown("sort")}>
          <SortTable {...tableProps("sort")} />
        </div>
      ) : null}
      {visited.has("sudoku") ? (
        <div className="absolute inset-0" {...shown("sudoku")}>
          <SudokuTable {...tableProps("sudoku")} />
        </div>
      ) : null}
      {visited.has("pipeline") ? (
        <div className="absolute inset-0" {...shown("pipeline")}>
          <PipelineTable {...tableProps("pipeline")} />
        </div>
      ) : null}
      {visited.has("merge") ? (
        <div className="absolute inset-0" {...shown("merge")}>
          <MergeTable {...tableProps("merge")} />
        </div>
      ) : null}
      {visited.has("race") ? (
        <div className="absolute inset-0" {...shown("race")}>
          <RaceTable {...tableProps("race")} />
        </div>
      ) : null}
      {visited.has("turnbet") ? (
        <div className="absolute inset-0" {...shown("turnbet")}>
          <TurnBetTable {...tableProps("turnbet")} />
        </div>
      ) : null}
    </>
  );
}
