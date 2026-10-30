import type { Session } from "../../features/sessions/model/session";
import {
  sessionDraftBlock,
  sessionNeedsInput,
} from "../../features/sessions/model/session";
import { shouldPersistSession } from "../../features/sessions/data/sessionStore";
import { isMonoSession } from "../../features/monos/model/mono";
import { closeStateOfBlocks } from "../closeBadges/closeState";
import {
  closeLeaf,
  leafIds,
  type WorkspaceTab,
} from "../../features/workspace/model/layout";
import {
  planWorkspaceTabClose,
  type WorkspaceTabCloseScope,
} from "../../features/workspace/model/workspaceTabGroups";

/**
 * Fork feature: close a conversation to free memory. Its tab or pane closes,
 * its agent CLI (a few hundred MB) stops and its transcript leaves the
 * window. It stays in the list, and the next message resumes it.
 */

/** Sessions with work in flight, or that only make sense on screen, stay. */
export function canCloseForMemory(
  session: Session,
  busyIds: ReadonlySet<string>,
): boolean {
  return (
    shouldPersistSession(session) &&
    !session.busy &&
    !busyIds.has(session.id) &&
    !session.orchestrationLeadId &&
    !session.inboxAsk &&
    !session.queuedMessages?.length &&
    // Its limit and any armed resume live only in memory, as does a
    // provider switch still waiting to hand the conversation over.
    !session.usageLimit &&
    !session.pendingSwitch &&
    !isMonoSession(session.id) &&
    !sessionNeedsInput(session) &&
    !sessionDraftBlock(session)
  );
}

/**
 * True when the last reply says "Safe to close: nothing left to do" and nothing
 * has happened since. A handover still has follow-ups, so it does not count.
 */
export function offersSafeClose(
  session: Session,
  busyIds: ReadonlySet<string>,
): boolean {
  return (
    !session.backgroundTasks?.length &&
    // A by-the-way answer still running would be cut off.
    !session.blocks.some((block) =>
      block.btwThreads?.some((thread) => thread.status === "running"),
    ) &&
    canCloseForMemory(session, busyIds) &&
    closeStateOfBlocks(session.blocks)?.kind === "safe"
  );
}

/** Sessions an open plan, agent transcript or changes tab still reads. */
export function referencedSessionIds(
  tabs: readonly WorkspaceTab[],
): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    for (const pane of [...tab.editorPanes, ...(tab.terminalPanes ?? [])]) {
      for (const file of pane.files) {
        const id =
          file.plan?.sessionId ??
          file.agent?.sessionId ??
          file.sessionChanges?.sessionId;
        if (id) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

/** `busyIds` plus the leads of orchestration runs still active or paused,
 * whose workers report back to them. */
export function withRunningLeads(
  busyIds: ReadonlySet<string>,
  runs: readonly { leadId: string; status: string }[],
): ReadonlySet<string> {
  const leads = runs
    .filter((run) => run.status === "active" || run.status === "paused")
    .map((run) => run.leadId);
  if (leads.length === 0) {
    return busyIds;
  }
  return new Set([...busyIds, ...leads]);
}

export type SessionClosePlan = {
  /** The sessions that close: their panes are gone from `tabs`. */
  closed: string[];
  tabs: WorkspaceTab[];
  /** Tabs that had nothing else and must stay, to be given a blank session. */
  blankTabIds: string[];
  activeTabId: string;
};

/**
 * Works out the tabs once `ids` close. A pane in a split closes on its own;
 * a tab left empty closes, unless it is the last one in its scope, which
 * stays for a blank session like a closed last tab does. A file or
 * terminal pane beside the session stays, as when the pane is closed by hand;
 * a tab whose files are not panes of its layout keeps its session open rather
 * than asking about them.
 */
export function planSessionClose({
  tabs,
  sessions,
  ids,
  busyIds,
  activeTabId,
  scope,
  worktreeOf,
}: {
  tabs: readonly WorkspaceTab[];
  sessions: readonly Session[];
  ids: readonly string[];
  busyIds: ReadonlySet<string>;
  activeTabId: string;
  scope: WorkspaceTabCloseScope;
  worktreeOf?: (tab: WorkspaceTab) => string | null;
}): SessionClosePlan {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const referenced = referencedSessionIds(tabs);
  const wanted = new Set(
    ids.filter((id) => {
      const session = byId.get(id);
      return (
        !!session &&
        !referenced.has(id) &&
        canCloseForMemory(session, busyIds)
      );
    }),
  );
  const kept = new Set<string>();
  const emptied: WorkspaceTab[] = [];
  let next: WorkspaceTab[] = [];
  for (const tab of tabs) {
    const closing = leafIds(tab.layout).filter((id) => wanted.has(id));
    if (closing.length === 0) {
      next.push(tab);
      continue;
    }
    let remaining: WorkspaceTab | null = tab;
    for (const id of closing) {
      remaining = remaining && closeLeaf(remaining, id);
    }
    if (remaining) {
      next.push(remaining);
      continue;
    }
    const hasFiles =
      tab.editorPanes.some((pane) => pane.files.length > 0) ||
      (tab.terminalPanes ?? []).some((pane) => pane.files.length > 0);
    if (hasFiles) {
      for (const id of closing) {
        kept.add(id);
      }
      next.push(tab);
      continue;
    }
    emptied.push(tab);
    next.push(tab);
  }

  // Close emptied tabs one at a time, so each one's last-in-scope check sees
  // the tabs still left.
  const blankTabIds: string[] = [];
  let nextActive = activeTabId;
  for (const tab of emptied) {
    const plan = planWorkspaceTabClose({
      tabs: next,
      sessions: [...sessions],
      closingTabId: tab.id,
      scope,
      worktreeOf,
    });
    if (plan.action === "keep") {
      blankTabIds.push(tab.id);
      continue;
    }
    next = next.filter((entry) => entry.id !== tab.id);
    if (tab.id === nextActive) {
      nextActive = plan.nextActiveTabId ?? next[0]?.id ?? nextActive;
    }
  }

  return {
    closed: [...wanted].filter((id) => !kept.has(id)),
    tabs: next,
    blankTabIds,
    activeTabId: nextActive,
  };
}
