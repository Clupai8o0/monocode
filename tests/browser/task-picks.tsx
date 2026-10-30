import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentMarkdown } from "../../src/features/sessions/ui/AgentMarkdown";
import { ADD_TO_CHAT_EVENT } from "../../src/features/sessions/model/quoteDraft";
import { TaskPicksReply } from "../../src/fork/taskPicks/TaskPicks";
import "../../src/styles/index.css";

const REPLY = `**Recap**

- **Done:** Track B port.
- **Decisions for you:** once Track A's verdict is in:
  - [ ] Apply at A's line (recommended if A passes the bar): run the steps in \`B-READY.md\`, then Track C's copy.
  - [ ] Hold: if A fails, nothing on TFM-114 ships.
- **Close:** not safe to close.`;

function Fixture() {
  const [composer, setComposer] = useState("");
  useEffect(() => {
    const onAdd = (event: Event) => setComposer((event as CustomEvent).detail.text);
    window.addEventListener(ADD_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TO_CHAT_EVENT, onAdd);
  }, []);
  return (
    <div style={{ width: 760, padding: 24 }}>
      <TaskPicksReply blockId="fixture-reply" streaming={false}>
        <AgentMarkdown text={REPLY} />
      </TaskPicksReply>
      <pre data-fixture-composer className="mt-6 text-xs text-content/60">
        {composer}
      </pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
