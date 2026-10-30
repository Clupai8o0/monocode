import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { setHarnessModels } from "../../src/features/sessions/model/models";
import type { Session } from "../../src/features/sessions/model/session";
import { EffortMeter } from "../../src/fork/effortAsk/EffortMeter";
import { useEffortAsks } from "../../src/fork/effortAsk/effortAsk";

// A Claude session driven the way the app drives it: the real hook reads the
// real Effort line when the turn ends.
setHarnessModels("claude", [
  {
    id: "claude:opus-5-5",
    harness: "claude",
    name: "Claude Opus 5.5",
    nativeId: "claude-opus-5-5",
    settings: [
      {
        id: "effort",
        label: "Reasoning",
        kind: "select",
        value: "high",
        options: ["max", "xhigh", "high", "medium", "low"].map((value) => ({
          value,
          label: value,
        })),
      },
      {
        id: "ultracode",
        label: "Ultracode",
        kind: "toggle",
        value: "false",
      } as never,
    ],
  },
]);

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const start = {
  id: "s1",
  harness: "claude",
  model: "claude:opus-5-5",
  modelSettings: {
    effort: "high",
    ...(params.has("ultracode") ? { ultracode: "true" } : {}),
  },
  blocks: [],
} as unknown as Session;

declare global {
  interface Window {
    startTurn: () => void;
    endTurn: (needed: string) => void;
    pickerClicks: number;
  }
}
window.pickerClicks = 0;

function Fixture() {
  const [sessions, setSessions] = useState<Session[]>([start]);
  useEffortAsks(sessions, setSessions);
  const session = sessions[0];
  window.startTurn = () =>
    setSessions(([s]) => [
      {
        ...s,
        busy: true,
        blocks: [
          ...s.blocks,
          { id: crypto.randomUUID(), role: "user", text: "go" },
        ],
      },
    ]);
  window.endTurn = (needed) =>
    setSessions(([s]) => [
      {
        ...s,
        busy: false,
        blocks: [
          ...s.blocks,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: `Effort: ${s.modelSettings.effort} now, ${needed} needed (test)`,
          },
        ],
      },
    ]);
  return (
    <div style={{ padding: 24 }}>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-fork-effort-target=""
          className="text-content"
          onClick={() => {
            window.pickerClicks += 1;
          }}
        >
          Opus 5.5
        </button>
        <EffortMeter
          sessionId={session.id}
          harness={session.harness}
          model={session.model}
          values={session.modelSettings}
          busy={session.busy}
        />
      </div>
      <ul data-notes="" className="text-content" style={{ marginTop: 24 }}>
        {session.blocks
          .filter((block) => block.role === "system")
          .map((block) => (
            <li key={block.id}>{block.text}</li>
          ))}
      </ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
