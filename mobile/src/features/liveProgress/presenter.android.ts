import * as Notifications from "expo-notifications";

import { ongoingNotificationText, type LiveProgress } from "./liveProgress";

export const PROGRESS_CHANNEL = "session-progress";
export const PROGRESS_ID = "session-progress";
let channelReady = false;

/** Same id, so each update replaces the card instead of adding another. */
export async function showProgress(progress: LiveProgress | null) {
  const now = Date.now();
  if (!progress) {
    await Notifications.dismissNotificationAsync(PROGRESS_ID);
    return;
  }
  if (!channelReady) {
    await Notifications.setNotificationChannelAsync(PROGRESS_CHANNEL, {
      name: "Session progress",
      // Quiet: it sits in the shade and on the lock screen, with no sound.
      importance: Notifications.AndroidImportance.LOW,
    });
    channelReady = true;
  }
  await Notifications.scheduleNotificationAsync({
    identifier: PROGRESS_ID,
    content: {
      ...ongoingNotificationText(progress, now),
      sticky: true,
      autoDismiss: false,
      data: { projectId: progress.projectId, sessionId: progress.sessionId },
    },
    trigger: { channelId: PROGRESS_CHANNEL },
  });
}
