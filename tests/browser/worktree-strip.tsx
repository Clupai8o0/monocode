import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AutoWorktreeSetting } from "../../src/fork/autoWorktree/AutoWorktreeSetting";
import {
  AutoPickNote,
  MergePanel,
  WorktreeCoachCard,
  WorktreeStrip,
} from "../../src/fork/autoWorktree/WorktreeStrip";
import { BranchChip } from "../../src/fork/autoWorktree/BranchChip";
import type { MergeStatus } from "../../src/fork/autoWorktree/mergeBack";
import "../../src/styles/index.css";

const ready: MergeStatus = {
  branch: "mc/fix-the-login-redirect-a1b2c3",
  base: "mine",
  baseCheckout: "/repo",
  baseBusy: false,
  ahead: 3,
  behind: 0,
  additions: 142,
  deletions: 37,
  files: 6,
  uncommitted: 0,
  conflicts: [],
};

// The live strip asks the fake native layer, and merging sticks.
let merged = false;
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      if (command === "fork_worktree_merge_status") {
        return merged ? { ...ready, ahead: 0, additions: 0, deletions: 0 } : ready;
      }
      if (command === "fork_worktree_merge_back") {
        merged = true;
        return { kind: "fast-forward", conflicts: [] };
      }
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
});

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const COLOR = "#e0883c";
const noop = () => {};

function Shot({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div data-shot={id} className="w-[680px] p-3 text-content">
      {children}
    </div>
  );
}

function Fixture() {
  const [, tick] = useState(0);
  useEffect(() => tick(1), []);
  return (
    <div className="flex flex-col gap-2 py-4">
      <Shot id="setting">
        <AutoWorktreeSetting />
      </Shot>
      <Shot id="note">
        <AutoPickNote reason="busy" onStay={noop} />
      </Shot>
      <Shot id="coach">
        <WorktreeCoachCard
          reason="busy"
          branch={ready.branch}
          base="mine"
          color={COLOR}
          onDismiss={noop}
          onOpenSettings={noop}
        />
      </Shot>
      <Shot id="live">
        <WorktreeStrip
          sessionId="s1"
          cwd="/repo"
          worktreeCwd="/repo-worktrees/mc-fix"
          branch={ready.branch}
          busy={false}
          draft={false}
          onStayInCheckout={noop}
          onAskAgent={noop}
        />
      </Shot>
      <Shot id="chip">
        <BranchChip cwd="/repo" branch={ready.branch} />
      </Shot>
      {(
        [
          ["fast-forward", ready, false],
          ["merge", { ...ready, behind: 2 }, false],
          ["uncommitted", { ...ready, uncommitted: 4 }, false],
          [
            "conflict",
            { ...ready, behind: 2, conflicts: ["src/auth/login.ts", "src/auth/session.ts"] },
            false,
          ],
          ["merged", { ...ready, ahead: 0 }, true],
        ] as const
      ).map(([id, status, done]) => (
        <Shot key={id} id={`panel-${id}`}>
          <MergePanel
            status={status as MergeStatus}
            color={COLOR}
            merged={done}
            working={false}
            onMerge={noop}
            onRemove={noop}
            onAskAgent={noop}
          />
        </Shot>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
