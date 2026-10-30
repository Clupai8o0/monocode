import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FeatureCoachView } from "../../src/fork/featureCoach/FeatureCoachPage";
import { FollowUpCoachMark } from "../../src/fork/featureCoach/FollowUpCoachMark";
import type { CoachCounts } from "../../src/fork/featureCoach/featureCoach";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

// The owner's real month: little used yet, the palette and splits a bit.
const counts: CoachCounts = {
  worktrees: 0,
  queue: 2,
  pinned: 0,
  "quick-composer": 1,
  orchestration: 0,
  habits: 1,
  split: 4,
  palette: 12,
};
const pins = [
  { id: "a", cwd: "/repo/panoptic", title: "Reconcile the invoice export", additions: 1840 },
  { id: "b", cwd: "/repo/monocode", title: "Fix the login redirect", additions: 420 },
];

function Fixture() {
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="@container/settings mx-auto flex max-w-[860px] flex-col gap-6 px-6 py-6 text-content">
      <div data-shot="mark">
        <FollowUpCoachMark show />
      </div>
      <div data-shot="page">
        <FeatureCoachView
          counts={counts}
          pins={pins}
          addedPresets={added}
          busyPreset={null}
          onAddPreset={(id) => setAdded(new Set([...added, id]))}
          onPin={() => {}}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
