import type { RecentProject } from "../features/projects/model/recents";
import type { HarnessId } from "../features/sessions/model/session";

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

/**
 * Providers this fork does not use. They stay out of Settings, the model
 * picker and orchestration even if their CLI turns up on the PATH.
 */
export const HIDDEN_PROVIDERS: ReadonlySet<HarnessId> = new Set<HarnessId>(
  HIDE ? ["devin", "pi", "omp", "fx"] : [],
);
