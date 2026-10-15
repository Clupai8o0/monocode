import { invoke } from "@tauri-apps/api/core";
import { sessionNeedsInput, type Session } from "../../sessions/model/session";
import { setNeedsCount } from "../../../fork/alerts/needsCount";

let lastCount = -1;

/** Push the pending-approval count to the macOS Dock badge. */
export function syncDockBadge(sessions: Session[]): void {
  let count = 0;
  for (const session of sessions) {
    if (sessionNeedsInput(session)) count++;
  }
  setNeedsCount(count); // Fork: count in the window title
  if (count === lastCount) return;
  lastCount = count;
  void invoke("set_dock_badge", { count }).catch(() => {});
}
