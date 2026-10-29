import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { MessagesWindow } from "../../src/fork/messageLog/MessagesWindow";
import type { WindowChoice } from "../../src/fork/messageLog/messageLogView";
import { fakeView } from "./fixtures/messageLogView";

// The Messages window on a fake view (fixtures/messageLogView.ts): this Mac
// and Vivobook, a held, a failed and a dropped message, the relay off on
// Vivobook. ?theme=light for the light theme.
if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const calls: string[] = [];
(window as unknown as { calls: string[] }).calls = calls;

function Harness() {
  const [window, setWindow] = useState<WindowChoice>("24h");
  return (
    <MessagesWindow
      view={fakeView({ window })}
      onClose={() => calls.push("close")}
      onWindowChange={setWindow}
      onOpenSession={(id) => calls.push(`open:${id}`)}
      onOpenHomeLab={() => calls.push("lab")}
      formatTime={(at) => new Date(at).toISOString().slice(11, 16)}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
