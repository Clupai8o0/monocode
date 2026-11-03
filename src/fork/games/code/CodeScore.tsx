import { useEffect, useState } from "react";
import {
  CODE_PROGRESS_EVENT,
  loadProgress,
  solvedTodayCount,
  streakDays,
} from "./codeModel";

export function CodeScore()
{
  const [, setCodeRuns] = useState(0);
  useEffect(() => {
    const onRun = () => setCodeRuns((value) => value + 1);
    window.addEventListener(CODE_PROGRESS_EVENT, onRun);
    return () => window.removeEventListener(CODE_PROGRESS_EVENT, onRun);
  }, []);
  const progress = loadProgress();
  const now = Date.now();
  const streak = streakDays(progress, now);
  return (
    <span data-fork-code-stats="" className="flex min-w-0 items-center gap-3">
      <span
        data-fork-games-score={progress.totalPoints}
        data-fork-code-points={progress.totalPoints}
      >
        points {progress.totalPoints}
      </span>
      <span className="text-content/35">
        streak {streak} {streak === 1 ? "day" : "days"}
      </span>
      <span className="text-content/35">
        solved today {solvedTodayCount(progress, now)}
      </span>
    </span>
  );
}
