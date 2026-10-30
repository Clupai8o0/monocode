import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { ComposerRunner } from "../../src/features/sessions/ui/ComposerRunner";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

// A fake composer with the runner on its top edge. ?chevron=1 adds the
// jump-to-latest chevron; `window.__endTurn()` ends the turn.
function Fixture() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(true);
  const [live, setLive] = useState(true);
  const [behindClicks, setBehindClicks] = useState(0);
  (window as unknown as { __endTurn: () => void }).__endTurn = () => setBusy(false);
  return (
    <div
      data-session-drop
      className="relative flex h-screen flex-col justify-end p-6 text-content"
    >
      <button
        data-behind
        className="absolute top-6 left-6 rounded border border-content/20 px-3 py-1 text-[12px]"
        onClick={() => setBehindClicks((n) => n + 1)}
      >
        Clicked {behindClicks}
      </button>
      {params.get("chevron") ? (
        <button
          data-jump-to-bottom
          aria-label="Jump to latest"
          className="absolute bottom-[116px] left-1/2 size-7 rounded-full bg-content/20"
        />
      ) : null}
      <div data-composer>
        <div
          ref={boxRef}
          className="rounded-lg border border-content/15 bg-background-elevated-primary p-3"
        >
          <textarea
            aria-label="Message"
            className="h-16 w-full resize-none bg-transparent text-[13px] outline-none"
            placeholder="Message"
          />
        </div>
      </div>
      <div data-exited>{live ? "running" : "exited"}</div>
      {live ? (
        <ComposerRunner
          boxRef={boxRef}
          cwd="/tmp/fixture-project"
          busy={busy}
          onExited={() => setLive(false)}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
