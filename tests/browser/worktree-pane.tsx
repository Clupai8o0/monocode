import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SessionPane,
  type SessionPaneProps,
} from "../../src/features/sessions/ui/SessionPane";
import {
  TranscriptPool,
  TranscriptPoolOutlet,
} from "../../src/features/sessions/ui/TranscriptPool";
import type { Block } from "../../src/features/sessions/model/session";
import { saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

// The real session pane for a session in a worktree. Only native IPC is fake.
// Git's answers are what a branch three commits ahead of `mine` would give.
const BRANCH = "mc/fix-the-login-redirect-a1b2c3";
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
      if (command === "control_load") return null;
      if (command === "session_checkpoint_status") return { files: [] };
      if (command === "fork_worktree_merge_status") {
        return {
          branch: BRANCH,
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
      }
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
});
saveTranscriptLayout("chat");
if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const noop = () => {};
const blocks = [
  { id: "u1", role: "user", text: "Fix the login redirect after sign-in." },
  {
    id: "a1",
    role: "assistant",
    text: "Fixed. The redirect now keeps the page you came from, and I committed the change with a test.",
  },
] as Block[];

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  return (
    <>
      <SessionPane
        {...({
          onFocus: noop,
          onClose: noop,
          onCwdChange: noop,
          onBranchChange: noop,
          onWorkspaceModeChange: noop,
          onWorktreeBaseChange: noop,
          onWorktreeChange: async () => {},
          onModelChange: noop,
          onModelSettingsChange: noop,
          onRuntimeModeChange: noop,
          onSubmit: noop,
          onSaveDraft: noop,
          onRemoveDraft: noop,
          onStop: noop,
          onCompactContext: () => false,
          onPlaceSessionInFolder: noop,
          onDeleteQueuedMessage: noop,
          onEditQueuedMessage: noop,
          onQueuedMessageEditingChange: noop,
          onSteerQueuedMessage: noop,
          onResumeQueue: noop,
          onUsageLimitResume: noop,
          onUsageLimitResumeAtReset: noop,
          onUsageLimitDismiss: noop,
          onApproval: noop,
          onQuestionReply: noop,
          onOpenFile: noop,
          onOpenDiff: noop,
          onOpenPlan: noop,
          onBuildPlan: noop,
          onNewTerminal: noop,
        } as Partial<SessionPaneProps> as SessionPaneProps)}
        session={{
          id: "wt",
          title: "Fix the login redirect",
          cwd: "/repo",
          worktreeCwd: "/repo-worktrees/mc-fix-the-login-redirect-a1b2c3",
          branch: BRANCH,
          harness: "claude",
          model: "claude:opus",
          modelSettings: {},
          runtimeMode: "supervised",
          blocks,
          busy: false,
        }}
        visible
        focused
        composerFocused
        inSplit={false}
        recents={[]}
        transcriptPool={pool}
      />
      <TranscriptPoolOutlet pool={pool} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
