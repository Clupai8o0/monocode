import { type ComponentType, lazy, Suspense, useSyncExternalStore } from "react";
import { AGENT_IDS, AGENT_NAMES } from "./agentNames";
import { formatTokens, rivalLine, tokenStore } from "./tokens";

// A score row that fails to load just isn't there; the game still plays.
const noScore = () => ({ default: () => null });
const CodeScore = lazy<ComponentType>(() => import("../code/CodeScore").then((m) => ({ default: m.CodeScore })).catch(noScore));
const GardenScore = lazy<ComponentType>(() => import("../calm/GardenScore").then((m) => ({ default: m.GardenScore })).catch(noScore));
const TurnBetScore = lazy<ComponentType>(() => import("../calm/TurnBetScore").then((m) => ({ default: m.TurnBetScore })).catch(noScore));

/** The panel's score row for a table: tokens and peak, or your chess record. */
export function TableScore({ gameId }: { gameId: string }) {
  const bankroll = useSyncExternalStore(tokenStore.subscribe, tokenStore.bankroll);
  const rivals = useSyncExternalStore(tokenStore.subscribe, tokenStore.rivals);
  if (gameId === "code") {
    return <Suspense fallback={null}><CodeScore /></Suspense>;
  }
  if (gameId === "garden") {
    return <Suspense fallback={null}><GardenScore /></Suspense>;
  }
  if (gameId === "turnbet") {
    return <Suspense fallback={null}><TurnBetScore /></Suspense>;
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
          {rivalLine(AGENT_NAMES[top.id], top.net)}
        </span>
      ) : null}
    </>
  );
}
