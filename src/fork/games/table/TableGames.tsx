import { useEffect, useState } from "react";
import type { ArcadeMode } from "../../../features/terminal/arcade/gridArcade";
import { BlackjackTable } from "./BlackjackTable";
import { ChessTable } from "./ChessTable";
import { useBankroll, useRivals } from "./kit";
import { AGENTS, AGENT_IDS } from "./agents";
import { PokerTable } from "./PokerTable";
import { formatTokens, rivalLine } from "./tokens";
// Fork: coding drills share the panel's table slot (src/fork/games/code).
import { CodeTable } from "../code/CodeTable";
import {
  CODE_PROGRESS_EVENT,
  loadProgress,
  streakDays,
} from "../code/codeModel";

/**
 * Fork: poker, blackjack and chess in the games panel. Each table stays mounted
 * once it's been opened, so a hand or a game is still there when you come back.
 * Off under vitest, like the panel itself.
 */
export const FORK_TABLE_GAMES = import.meta.env.MODE !== "test";

export const TABLE_GAMES = FORK_TABLE_GAMES
  ? ([
      { id: "poker", label: "poker", hint: "F fold · C call · R raise · A all in" },
      { id: "blackjack", label: "blackjack", hint: "H hit · S stand · D double · P split" },
      { id: "chess", label: "chess", hint: "click or drag to move" },
      // Fork: the Code tab's drills, run by fork_code_run.
      { id: "code", label: "code", hint: "write code · Cmd+Enter to run" },
    ] as const)
  : [];

export function isTableGame(id: string) {
  return TABLE_GAMES.some((game) => game.id === id);
}

export function tableHint(id: string) {
  return TABLE_GAMES.find((game) => game.id === id)?.hint;
}

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
    </>
  );
}

/** The panel's score row for a table: tokens and peak, or your chess record. */
export function TableScore({ gameId }: { gameId: string }) {
  const bankroll = useBankroll();
  const rivals = useRivals();
  // Fork: the Code tab's points change under this row, so listen for a run.
  const [, setCodeRuns] = useState(0);
  useEffect(() => {
    const onRun = () => setCodeRuns((value) => value + 1);
    window.addEventListener(CODE_PROGRESS_EVENT, onRun);
    return () => window.removeEventListener(CODE_PROGRESS_EVENT, onRun);
  }, []);
  if (gameId === "code") {
    const progress = loadProgress();
    return (
      <>
        <span data-fork-games-score={progress.totalPoints}>
          points {progress.totalPoints}
        </span>
        <span className="text-content/35">
          streak {streakDays(progress, Date.now())}
        </span>
      </>
    );
  }
  if (gameId === "chess") {
    const played = AGENT_IDS.flatMap((id) => {
      const rival = rivals[id];
      return rival && rival.wins + rival.losses + rival.draws > 0
        ? [{ id, ...rival }]
        : [];
    });
    const wins = played.reduce((sum, rival) => sum + rival.wins, 0);
    const losses = played.reduce((sum, rival) => sum + rival.losses, 0);
    const draws = played.reduce((sum, rival) => sum + rival.draws, 0);
    return (
      <span data-fork-games-score={wins}>
        record {wins}-{losses}-{draws}
      </span>
    );
  }
  // Whoever you've gone furthest up or down on.
  const top = AGENT_IDS.map((id) => ({ id, net: rivals[id]?.net ?? 0 }))
    .filter((rival) => rival.net !== 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))[0];
  return (
    <>
      <span data-fork-games-score={bankroll.tokens}>
        tokens {formatTokens(bankroll.tokens)}
      </span>
      <span className="text-content/35">best {formatTokens(bankroll.peak)}</span>
      {top ? (
        <span className="truncate text-content/35" data-rival-line="">
          {rivalLine(AGENTS[top.id].name, top.net)}
        </span>
      ) : null}
    </>
  );
}
