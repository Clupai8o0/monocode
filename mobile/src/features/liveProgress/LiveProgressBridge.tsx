import { useEffect, useState } from "react";
import { Platform } from "react-native";

import { useConnection } from "@/features/connection/ConnectionProvider";
import { useNotificationPreferences } from "@/features/settings/notifications";

import { pickLiveProgress } from "./liveProgress";
import { showProgress } from "./presenter";
import { createProgressSync } from "./progressSync";

const TICK_MS = 60_000;

/** Keeps the lock screen card in step with the session list as the phone polls. */
export function LiveProgressBridge() {
  const connection = useConnection();
  const { enabled } = useNotificationPreferences();
  const on = enabled("liveProgress");
  const [sync] = useState(() =>
    createProgressSync(showProgress, (reason) =>
      console.warn("Could not update session progress", reason),
    ),
  );
  useEffect(() => {
    const wanted = () =>
      on && connection.connected
        ? pickLiveProgress(
            connection.catalog.sessions,
            connection.catalog.projects,
            Date.now(),
          )
        : null;
    void sync.set(wanted());
    // Retries a failed update, and refreshes Android's elapsed text, which
    // can't count by itself, even when the session list hasn't changed.
    const timer = setInterval(() => {
      void sync.set(wanted(), Platform.OS === "android");
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [connection.catalog, connection.connected, on, sync]);

  // Disconnecting unmounts this, and nothing else would take the card down.
  useEffect(() => () => void sync.set(null), [sync]);

  return null;
}
