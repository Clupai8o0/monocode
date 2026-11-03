import type { ComponentType } from "react";
import type { TableProps } from "./table/PokerTable";
import { loadGridGame } from "../../features/terminal/arcade/gridGames";

type TableModule = { default: ComponentType<TableProps> };

function tableLoader(load: () => Promise<TableModule>)
{
  let pending: Promise<TableModule> | undefined;
  return () => {
    pending ??= load().catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

export const tableLoaders = {
  poker: tableLoader(() => import("./table/PokerTable").then((m) => ({ default: m.PokerTable }))),
  blackjack: tableLoader(() => import("./table/BlackjackTable").then((m) => ({ default: m.BlackjackTable }))),
  chess: tableLoader(() => import("./table/ChessTable").then((m) => ({ default: m.ChessTable }))),
  code: tableLoader(() => import("./code/CodeTable").then((m) => ({ default: m.CodeTable }))),
  garden: tableLoader(() => import("./calm/GardenTable").then((m) => ({ default: m.GardenTable }))),
  solitaire: tableLoader(() => import("./calm/SolitaireTable").then((m) => ({ default: m.SolitaireTable }))),
  sort: tableLoader(() => import("./calm/SortTable").then((m) => ({ default: m.SortTable }))),
  sudoku: tableLoader(() => import("./calm/SudokuTable").then((m) => ({ default: m.SudokuTable }))),
  pipeline: tableLoader(() => import("./calm/PipelineTable").then((m) => ({ default: m.PipelineTable }))),
  merge: tableLoader(() => import("./calm/MergeTable").then((m) => ({ default: m.MergeTable }))),
  race: tableLoader(() => import("./calm/RaceTable").then((m) => ({ default: m.RaceTable }))),
  turnbet: tableLoader(() => import("./calm/TurnBetTable").then((m) => ({ default: m.TurnBetTable }))),
};

/** Warm the selected game's code without creating its board or touching saves. */
export function preloadGame(id: string)
{
  if (Object.prototype.hasOwnProperty.call(tableLoaders, id)) {
    void tableLoaders[id as keyof typeof tableLoaders]().catch(() => {});
  } else {
    void loadGridGame(id).catch(() => {});
  }
}
