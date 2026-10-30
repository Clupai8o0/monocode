import { sameLiveProgress, type LiveProgress } from "./liveProgress";

type Show = (progress: LiveProgress | null) => Promise<void>;

/**
 * Brings the system card to the latest wanted state, one native call at a time.
 * What's on screen starts unknown, since a card can outlive the app, and only
 * counts as shown once the call succeeds, so a failure is retried on the next set.
 */
export function createProgressSync(show: Show, onError: (reason: unknown) => void) {
  // undefined: not known yet, so even "nothing" has to be applied once.
  let shown: LiveProgress | null | undefined;
  let wanted: LiveProgress | null = null;
  let force = false;
  let running: Promise<void> | null = null;

  const run = async () => {
    for (;;) {
      const target = wanted;
      const needed =
        force || shown === undefined || !sameLiveProgress(shown, target);
      if (!needed) return;
      force = false;
      try {
        await show(target);
        shown = target;
      } catch (reason) {
        shown = undefined;
        onError(reason);
        return;
      }
    }
  };

  return {
    /** `refresh` applies it even if unchanged, for text that goes stale. */
    set(next: LiveProgress | null, refresh = false): Promise<void> {
      wanted = next;
      force ||= refresh;
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
