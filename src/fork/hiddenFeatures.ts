import type { RecentProject } from "../features/projects/model/recents";

// Upstream's own tests cover these features, and fork/update.sh rolls back on
// a red suite, so the hiding stays off under test.
const HIDE = import.meta.env.MODE !== "test";

/**
 * Fork feature: upstream surfaces this fork does not use. They are hidden,
 * not deleted, so upstream merges stay clean. Set one to false to bring it
 * back.
 */
export const HIDDEN: Readonly<
  Record<"inbox" | "notes" | "automations", boolean>
> = {
  inbox: HIDE,
  notes: HIDE,
  automations: HIDE,
};

/** Stable empty project list: the inbox poller does nothing without projects. */
export const NO_PROJECTS: RecentProject[] = [];
