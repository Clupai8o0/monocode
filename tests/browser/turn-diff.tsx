import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RestoreConfirm, TurnDiffDialog } from "../../src/fork/turnDiff/TurnDiffDialog";
import { TurnChipButton } from "../../src/fork/turnDiff/TurnChangeChip";
import type { TurnChanges } from "../../src/fork/turnDiff/turnDiff";
import "../../src/styles/index.css";

const changes: TurnChanges = {
  files: [
    { relative: "src/auth/login.ts", status: "modified", additions: 18, deletions: 6 },
    { relative: "src/auth/redirect.ts", status: "added", additions: 22, deletions: 0 },
    { relative: "tests/login.test.ts", status: "modified", additions: 2, deletions: 1 },
  ],
  additions: 42,
  deletions: 7,
};

const preview = {
  files: [
    { relative: "src/auth/login.ts", action: "restore", editedSince: false },
    { relative: "src/auth/redirect.ts", action: "remove", editedSince: false },
    { relative: "tests/login.test.ts", action: "restore", editedSince: true },
  ],
  blocked: null,
  headMoved: true,
};


Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => 0,
    invoke: async (command: string, args: { relative?: string }) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      if (command === "fork_turn_file_diff") {
        return {
          relative: args.relative,
          status: "modified",
          original: "export function next(url) {\n  return url;\n}\n",
          current: "export function next(url) {\n  return safeRedirect(url) ?? \"/\";\n}\n",
          binary: false,
          tooLarge: false,
        };
      }
      if (command === "fork_turn_restore_preview") return preview;
      if (command === "fork_turn_restore") {

        return { ...preview, files: [] };
      }
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
});
if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex w-[720px] flex-col gap-5 p-6 text-content">
      <div data-shot="turn" className="font-sans text-[14px] leading-relaxed">
        <p>Fixed. The redirect now keeps the page you came from, with a test for it.</p>
        <TurnChipButton changes={changes} onOpen={() => setOpen(true)} />
      </div>
      <div data-shot="blocked">
        <RestoreConfirm
          preview={{
            files: [],
            blocked: "Another session was working here during this turn, so restoring could undo its work.",
            headMoved: false,
          }}
          working={false}
          done={false}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </div>
      {open ? (
        <TurnDiffDialog
          sessionId="s1"
          turnId="t1"
          changes={changes}
          busy={false}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
