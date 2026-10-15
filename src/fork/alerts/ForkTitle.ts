import { useSyncExternalStore } from "react";
import { needsCount, subscribeNeedsCount, titleWithNeeds } from "./needsCount";
import {
  subscribeWorkspaceName,
  titleWithWorkspace,
  workspaceName,
} from "../workspaces/workspaces";

/** Fork: the window title with the workspace name and "needs you" count in front. */
export function useForkTitle(title: string): string {
  const n = useSyncExternalStore(subscribeNeedsCount, needsCount, needsCount);
  const workspace = useSyncExternalStore(
    subscribeWorkspaceName,
    workspaceName,
    workspaceName,
  );
  return titleWithWorkspace(titleWithNeeds(title, n), workspace);
}
