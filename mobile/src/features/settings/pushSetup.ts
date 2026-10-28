import { useEffect, useState } from "react";
import { Linking } from "react-native";

import { useConnection } from "@/features/connection/ConnectionProvider";
import type { PushConfig } from "./ntfyLink";

/**
 * The host's push setup, through ntfy: Done, Failed, Stopped and Needs you,
 * delivered while the app is closed. Undefined while asked; null when the host
 * has none set up, or is a desktop or an older host that can't say.
 */
export function usePushConfig() {
  const { command } = useConnection();
  const [config, setConfig] = useState<PushConfig | null | undefined>();
  useEffect(() => {
    let disposed = false;
    command<{ config: PushConfig | null }>("notify.config", {})
      .then((value) => {
        if (!disposed) setConfig(value.config ?? null);
      })
      .catch(() => {
        if (!disposed) setConfig(null);
      });
    return () => {
      disposed = true;
    };
  }, [command]);
  return config;
}

/**
 * Opens the first of `urls` that opens; false when none did. Tried rather than
 * checked with `canOpenURL`, which on Android 11+ needs a manifest query.
 */
export async function openFirst(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // Nothing on this phone handles it; try the next.
    }
  }
  return false;
}
