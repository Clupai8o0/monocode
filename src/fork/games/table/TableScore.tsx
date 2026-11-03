import { useEffect, useState } from "react";
import { useBankroll, useRivals } from "./kit";
import { AGENTS, AGENT_IDS } from "./agents";
import { formatTokens, rivalLine } from "./tokens";
import { GardenScore } from "../calm/GardenTable";
import { useTurnBet } from "../calm/turnBet";
import {
  CODE_PROGRESS_EVENT,
  loadProgress,
  streakDays,
} from "../code/codeModel";

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
  if (gameId === "garden") {
    return <GardenScore />;
  }
  if (gameId === "turnbet") {
    return <TurnBetScore />;
  }
  if (gameId === "solitaire" || gameId === "sort" || gameId === "sudoku" || gameId === "pipeline" || gameId === "merge" || gameId === "race") {
    return null;
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

function TurnBetScore() {
  const { record, live } = useTurnBet();
  return (
    <>
      <span data-fork-games-score={record.points}>points {record.points}</span>
      <span className="text-content/35">
        {live.length} {live.length === 1 ? "turn" : "turns"} running
      </span>
    </>
  );
}
