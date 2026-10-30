import { useState } from "react";
import { X } from "../../shared/ui/icons";
import { loadFollowUpBehavior } from "../../features/settings/model/settings";
import { followUpMarkSeen, markFollowUpSeen } from "./featureCoach";

/** Fork: shown once, the first time someone types while the agent runs. */
export function FollowUpCoachMark({ show }: { show: boolean }) {
  const [dismissed, setDismissed] = useState(followUpMarkSeen);
  if (!show || dismissed) return null;
  const queued = loadFollowUpBehavior() === "queue";
  const dismiss = () => {
    markFollowUpSeen();
    setDismissed(true);
  };
  return (
    <div
      data-fork-followup-coach
      className="mb-1.5 flex min-w-0 items-start gap-2 rounded-lg bg-accent/10 px-2.5 py-1.5 font-sans text-[12px] leading-relaxed text-content/75"
    >
      <p className="min-w-0 flex-1 [text-wrap:pretty]">
        {queued ? (
          <>
            <span className="font-medium text-content">Send to queue this.</span>{" "}
            It goes in when the agent finishes. To interrupt instead, press Steer on the queued message.
          </>
        ) : (
          <>
            <span className="font-medium text-content">Send to steer the agent now.</span>{" "}
            It reads this mid-task. You can make follow-ups wait instead in Settings.
          </>
        )}
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="grid size-5 shrink-0 place-items-center rounded text-content/45 transition-colors duration-150 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
