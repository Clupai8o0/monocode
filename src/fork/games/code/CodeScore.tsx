import { useEffect, useState } from "react";
import { CODE_PROGRESS_EVENT, loadProgress, streakDays } from "./codeModel";

export function CodeScore()
{
  const [, setCodeRuns] = useState(0);
  useEffect(() => {
    const onRun = () => setCodeRuns((value) => value + 1);
    window.addEventListener(CODE_PROGRESS_EVENT, onRun);
    return () => window.removeEventListener(CODE_PROGRESS_EVENT, onRun);
  }, []);
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
