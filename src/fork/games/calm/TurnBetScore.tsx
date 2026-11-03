import { useTurnBet } from "./turnBet";

export function TurnBetScore()
{
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
