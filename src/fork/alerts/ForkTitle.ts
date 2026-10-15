import { useSyncExternalStore } from "react";
import { needsCount, subscribeNeedsCount, titleWithNeeds } from "./needsCount";

/** Fork: the window title with the "needs you" count in front. */
export function useForkTitle(title: string): string {
  const n = useSyncExternalStore(subscribeNeedsCount, needsCount, needsCount);
  return titleWithNeeds(title, n);
}
