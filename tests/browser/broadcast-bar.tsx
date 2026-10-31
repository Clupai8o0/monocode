import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { BroadcastButton, BroadcastRow } from "../../src/fork/broadcast/BroadcastButton";
import { BROADCAST_EVENT, type BroadcastApp } from "../../src/fork/broadcast/broadcastModel";
import type { Session } from "../../src/features/sessions/model/session";

// Five sessions in /repo, one in /other, and the kinds that are left out.
// "refuses" won't take a message; what was sent lands on window.sent.
function session(id: string, title: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    title,
    harness: "claude",
    cwd: "/repo",
    blocks: [{ id: `${id}-u`, role: "user", text: "hi" }],
    ...extra,
  } as Session;
}

const sessions = [
  session("idle", "Fix the login bug"),
  session("busy", "Write the changelog", { busy: true }),
  session("refuses", "Refuses messages"),
  session("other", "Other project work", { cwd: "/other" }),
  session("draft", "Holds a saved draft", {
    blocks: [{ id: "d", role: "user", text: "later", draft: true }] as Session["blocks"],
  }),
  session("blank", "New tab", { blocks: [] }),
  session("worker", "A worker", { orchestrationLeadId: "lead" }),
];

const sent: { id: string; text: string }[] = [];
const page = window as unknown as { sent: typeof sent; hold?: Promise<void>; release?: () => void };
page.sent = sent;

window.addEventListener(BROADCAST_EVENT, (event) => {
  (event as CustomEvent<(app: BroadcastApp<Session>) => void>).detail({
    sessions: () => sessions,
    project: () => "/repo",
    submit: async (id, text) => {
      await page.hold;
      if (id === "refuses") {
        return false;
      }
      sent.push({ id, text });
      return true;
    },
  });
});

createRoot(document.getElementById("root")!).render(
  <div className="fixed inset-x-0 bottom-0 flex h-7 items-center justify-end px-3 text-[11px] text-content/55">
    <BroadcastRow />
    <BroadcastButton />
  </div>,
);
