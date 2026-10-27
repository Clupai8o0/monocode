import {
  bindClaudeSession,
  cancelClaudeTurn,
  compactClaudeContext,
  forgetClaudeSession,
  respondClaudeApproval,
  respondClaudeQuestion,
  restoreClaudeTaskLists,
  sendClaudeTurn,
  setClaudeVivobookThread,
  steerClaudeTurn,
  stopClaudeSession,
} from "../../integrations/harness/providers/claude/claude";
import { refreshClaudeCatalog } from "../../integrations/harness/providers/claude/claudeCatalog";
import { generateClaudeSessionTitle } from "../../integrations/harness/providers/claude/claudeTitle";
import {
  registerHarness,
  type HarnessAdapter,
} from "../../integrations/harness/core/registry";
import type {
  CompactContextInput,
  SendTurnInput,
} from "../../integrations/harness/core/types";
import { modelsFor, setHarnessModels } from "../../features/sessions/model/models";

/**
 * Claude Code on the Vivobook. Every call is Claude's own; only the launch
 * differs: `vivobook-agent` checks Tailscale and SSH (and runs a local fixer
 * when they fail) before it hands stdio to `claude` on the Vivobook.
 */
function remote<T extends { sessionId: string }>(input: T): T {
  setClaudeVivobookThread(input.sessionId, true);
  return input;
}

/** Same models as local Claude, under the Vivobook's own ids. */
async function refreshVivobookCatalog(): Promise<void> {
  await refreshClaudeCatalog().catch(() => undefined);
  setHarnessModels(
    "vivobook",
    modelsFor("claude").map((model) => ({
      ...model,
      id: model.id.replace(/^claude:/, "vivobook:"),
      harness: "vivobook",
    })),
  );
}

export const vivobookAdapter: HarnessAdapter = {
  id: "vivobook",
  live: true,
  sendTurn: (input: SendTurnInput) => sendClaudeTurn(remote(input)),
  compactContext: (input: CompactContextInput) =>
    compactClaudeContext(remote(input)),
  steerTurn: steerClaudeTurn,
  cancelTurn: cancelClaudeTurn,
  respondApproval: respondClaudeApproval,
  respondQuestion: respondClaudeQuestion,
  stopSession: stopClaudeSession,
  forgetSession: (sessionId) => {
    // Cleared before the await: callers may not wait before reusing the thread.
    setClaudeVivobookThread(sessionId, false);
    return forgetClaudeSession(sessionId);
  },
  bindSession: (threadId, providerSessionId, cwd, providerAccountId) => {
    setClaudeVivobookThread(threadId, true);
    bindClaudeSession(threadId, providerSessionId, cwd, providerAccountId);
  },
  restoreTaskLists: restoreClaudeTaskLists,
  refreshCatalog: refreshVivobookCatalog,
  // Titles are a short local Claude call; the session itself stays remote.
  generateTitle: generateClaudeSessionTitle,
};

let registered = false;

export function ensureVivobookRegistered(): void {
  if (registered) return;
  registerHarness(vivobookAdapter);
  registered = true;
}
