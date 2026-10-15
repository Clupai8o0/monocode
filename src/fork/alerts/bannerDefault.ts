import {
  requestNotificationPermission,
  type NotificationPermission,
} from "../../features/notifications/model/notifications";

/** Upstream's key for the banners setting. */
const KEY = "monocode.notifications";

/**
 * Fork: banners are on by default here, but macOS only shows them once asked.
 * Upstream asks when the user flips the setting on; with the default on and
 * the setting never touched, ask once at launch instead.
 */
export function askBannersOnce(permission: NotificationPermission) {
  if (permission !== "prompt") {
    return;
  }
  try {
    if (localStorage.getItem(KEY) != null) {
      return;
    }
  } catch {
    return;
  }
  void requestNotificationPermission();
}
