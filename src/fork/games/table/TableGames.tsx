import { type ComponentType, useEffect, useState } from "react";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { tableLoaders } from "../gameLoaders";
import { isTableGame } from "../catalog";
import type { TableProps } from "./PokerTable";

type TableId = keyof typeof tableLoaders;
const TABLE_IDS = Object.keys(tableLoaders) as TableId[];

/**
 * Loads one table's code. Not React.lazy: that remembers a failed load for good
 * and, with no boundary above it, takes the whole panel down with it.
 */
function LoadedTable({ id, ...props }: TableProps & { id: TableId })
{
  const [Table, setTable] = useState<ComponentType<TableProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    tableLoaders[id]().then(
      (module) => {
        if (live) {
          setTable(() => module.default);
        }
      },
      (error) => {
        console.error("Could not load game", error);
        if (live) {
          setFailed(true);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  if (Table) {
    return <Table {...props} />;
  }
  if (!failed) {
    return null;
  }
  return (
    <div
      data-fork-games-load-failed=""
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[12px] text-content/55"
    >
      This game didn't load.
      <button
        type="button"
        className="games-action games-action-primary"
        onClick={() => {
          setFailed(false);
          setAttempt((was) => was + 1);
        }}
      >
        Try again
      </button>
    </div>
  );
}

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
      {TABLE_IDS.filter((id) => visited.has(id)).map((id) => (
        <div key={id} className="absolute inset-0" {...shown(id)}>
          <LoadedTable id={id} {...tableProps(id)} />
        </div>
      ))}
    </>
  );
}
