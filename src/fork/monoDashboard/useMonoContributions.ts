import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { firstDay, type MonoContributions } from "./dashboardModel";

/** How long loaded contributions are shown before they are read again. */
const FRESH_MS = 30_000;
/** How often opened pull requests are asked of GitHub for merging. */
const LANDED_EVERY_MS = 15 * 60_000;
/** The day before the calendar opens, so no time zone can cut its first day. */
const MARGIN_MS = 24 * 60 * 60 * 1000;

/** Last results by Mono, so switching back shows them at once. */
const loaded = new Map<string, MonoContributions>();
const landedCheckedAt = new Map<string, number>();

export type ContributionsState = {
  data?: MonoContributions;
  /** The last read failed and there is nothing older to show. */
  failed: boolean;
};

/** A Mono's contributions, read on open and then every 30 s while `active`. */
export function useMonoContributions(
  monoId: string,
  sessionIds: readonly string[],
  active: boolean,
): ContributionsState {
  const [data, setData] = useState(() => loaded.get(monoId));
  const [failed, setFailed] = useState(false);
  const idsKey = useMemo(
    () => JSON.stringify([...new Set(sessionIds)].sort()),
    [sessionIds],
  );

  useEffect(() => {
    if (!active) return;
    let live = true;
    let reading = false;
    const read = () => {
      if (reading || document.hidden) return;
      reading = true;
      const now = Date.now();
      const checkLanded =
        now - (landedCheckedAt.get(monoId) ?? 0) > LANDED_EVERY_MS;
      if (checkLanded) landedCheckedAt.set(monoId, now);
      void invoke<MonoContributions>("fork_mono_contributions", {
        sessionIds: JSON.parse(idsKey) as string[],
        sinceMs: Math.max(0, firstDay(now).getTime() - MARGIN_MS),
        checkLanded,
      })
        .then((next) => {
          loaded.set(monoId, next);
          if (!live) return;
          setData(next);
          setFailed(false);
        })
        .catch(() => {
          if (live) setFailed(true);
        })
        .finally(() => {
          reading = false;
        });
    };
    read();
    const timer = window.setInterval(read, FRESH_MS);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [monoId, idsKey, active]);

  return { data, failed: failed && !data };
}
