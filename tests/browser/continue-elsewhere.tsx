import { createRoot } from "react-dom/client";
import {
  ContinuedFromView,
  ContinueElsewhereButton,
} from "../../src/fork/continueElsewhere/ContinueElsewhere";
import { UsageLimitNotice } from "../../src/features/sessions/ui/UsageLimitNotice";
import "../../src/styles/index.css";

if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const noop = () => {};
createRoot(document.getElementById("root")!).render(
  <div className="flex w-[760px] flex-col gap-6 p-6 text-content">
    <div data-shot="limit">
      <UsageLimitNotice
        limit={{ message: "Claude usage limit reached", resetsAt: Date.now() + 3 * 3_600_000 } as never}
        onResume={noop}
        onResumeAtReset={noop}
        onDismiss={noop}
        modelPicker={<ContinueElsewhereButton sessionId="s1" harness="claude" />}
      />
    </div>
    <div data-shot="card" className="h-20">
      <ContinuedFromView
        origin={{
          sessionId: "s1",
          from: "claude",
          to: "codex",
          title: "Fix the login redirect",
          files: 3,
        }}
        onOpen={noop}
        onDismiss={noop}
      />
    </div>
  </div>,
);
