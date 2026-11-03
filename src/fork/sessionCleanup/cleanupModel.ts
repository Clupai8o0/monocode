import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import { isMonoSession } from "../../features/monos/model/mono";
import { isHabitRun } from "../../features/monos/model/monoHabits";
import type { CloseKind } from "../closeBadges/closeState";

/**
 * Fork feature: the rules behind the "Clean up sessions" panel, which archives
 * sessions from every project at once. Kept apart from the panel so the safety
 * rules can be tested on their own.
 */

export type CleanupFilter = "safe" | "handover" | "idle" | "all";

export const CLEANUP_FILTERS: readonly { id: CleanupFilter; label: string }[] =
  [
    { id: "safe", label: "Safe to close" },
    { id: "handover", label: "Handover" },
    { id: "idle", label: "Idle 7+ days" },
    { id: "all", label: "Everything" },
  ];

export const IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type CleanupHeld = {
  activeSessionId?: string;
  busy: ReadonlySet<string>;
  approval: ReadonlySet<string>;
};

/**
 * Whether a session is working, waiting on the user, or in focus. A session in
 * another split pane is not held: it counts as open, so it starts unticked.
 */
export function isHeld(sessionId: string, held: CleanupHeld): boolean {
  return (
    sessionId === held.activeSessionId ||
    held.busy.has(sessionId) ||
    held.approval.has(sessionId)
  );
}

/**
 * The sessions the panel may offer. Pinned ones were kept on purpose, drafts
 * hold unsent text, and Monos, habit runs and hidden launches never show in a
 * session list, so nobody would see them go.
 */
export function cleanupCandidates(
  rows: readonly SessionSummary[],
  held: CleanupHeld,
): SessionSummary[] {
  return rows.filter(
    (row) =>
      !row.archived &&
      !row.pinned &&
      !row.draft &&
      !row.sidebarHidden &&
      !row.orchestrationLeadId &&
      !isMonoSession(row.id) &&
      !isHabitRun(row.id) &&
      !isHeld(row.id, held),
  );
}

export function inCleanupFilter(
  updatedAt: number,
  kind: CloseKind | undefined,
  filter: CleanupFilter,
  now: number,
): boolean {
  switch (filter) {
    case "safe":
      return kind === "safe";
    case "handover":
      return kind === "handover";
    case "idle":
      return now - updatedAt >= IDLE_AFTER_MS;
    case "all":
      return true;
  }
}

/**
 * What starts ticked. "Everything" is a browsing view, so nothing; a session
 * open in a tab or that said it is not safe waits for a deliberate tick. So
 * does one not read yet, which may turn out not safe (`checked` is false).
 */
export function tickedByDefault(
  kind: CloseKind | undefined,
  filter: CleanupFilter,
  open: boolean,
  checked: boolean,
): boolean {
  return checked && filter !== "all" && !open && kind !== "unsafe";
}

export type CleanupGroup<T> = { cwd: string; rows: T[] };

/** Rows by project, in the order the projects were first seen. */
export function groupByProject<T extends { cwd: string }>(
  rows: readonly T[],
): CleanupGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.cwd);
    if (group) {
      group.push(row);
    } else {
      groups.set(row.cwd, [row]);
    }
  }
  return [...groups].map(([cwd, grouped]) => ({ cwd, rows: grouped }));
}

/** A row's age in one short unit: 12m, 5h, 3d. */
export function cleanupAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function cleanupResult(archived: number, kept: number): string {
  const done = `Archived ${archived}.`;
  if (kept === 0) {
    return done;
  }
  return `${done} Kept ${kept}: changed, in use or could not be archived.`;
}
