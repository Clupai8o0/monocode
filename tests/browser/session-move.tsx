import { createRoot } from "react-dom/client";
import { ExplorerMenu } from "../../src/features/files/ui/ExplorerMenu";
import { MovedCardView, MoveLineView } from "../../src/fork/sessionMove/SessionMoveUi";
import { moveAvailability, stepText, type MoveFacts } from "../../src/fork/sessionMove/sessionMoveModel";
import "../../src/styles/index.css";

if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const noop = () => {};
const facts: MoveFacts = {
  harness: "claude",
  cwd: "/Users/me/Documents/projects/app",
  isMono: false,
  isOrchestration: false,
  hasConversation: true,
  needsInput: false,
  moved: false,
  moving: false,
  target: { online: true, known: true, capabilities: ["session.move.v1"], name: "Vivobook" },
};
const item = (id: string, over: Partial<MoveFacts>) => {
  const availability = moveAvailability({ ...facts, ...over });
  const disabled = availability.show ? availability.disabled : "hidden";
  return { kind: "item" as const, id, label: "Move to Vivobook", disabled: Boolean(disabled), description: disabled };
};
const at = new Date(2026, 9, 31, 10, 42).getTime();

createRoot(document.getElementById("root")!).render(
  <div className="flex w-[780px] flex-col gap-4 p-6 text-content">
    <div data-shot="line" className="flex flex-col gap-1">
      <MoveLineView text={stepText("wait", "Vivobook")} onCancel={noop} />
      <MoveLineView text={stepText("code", "Vivobook", { percent: 42 })} />
      <MoveLineView text={stepText("confirm", "Vivobook", { queued: true })} />
      <MoveLineView failure="This repository is not on that machine" onDismiss={noop} />
    </div>
    <div data-shot="card" className="flex flex-col gap-2">
      <MovedCardView
        onOpen={noop}
        record={{
          sessionId: "s1",
          providerSessionId: "p1",
          toName: "Vivobook",
          at,
          live: { kind: "host", machineId: "m", name: "fix-login", cwd: "/w", source: "claude" },
          cwd: "/w",
          branch: "moved/fix-login",
          leftBehind: [".env", "node_modules/"],
          leftBehindMore: 2,
        }}
      />
      <MovedCardView
        onOpen={noop}
        record={{
          sessionId: "s2",
          providerSessionId: "p2",
          toName: "this Mac",
          at,
          live: { kind: "tab", sessionId: "t" },
          cwd: "/w",
          branch: "moved/fix-login",
          leftBehind: [],
          leftBehindMore: 0,
        }}
      />
    </div>
    <ExplorerMenu
      x={40}
      y={330}
      ariaLabel="Session actions"
      onPick={noop}
      onClose={noop}
      items={[
        item("ready", {}),
        item("offline", { target: { ...facts.target, online: false } }),
        item("old", { target: { ...facts.target, capabilities: [] } }),
        item("asks", { needsInput: true }),
      ]}
    />
  </div>,
);
