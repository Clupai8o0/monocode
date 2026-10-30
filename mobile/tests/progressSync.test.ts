import { describe, expect, it, vi } from "vitest";

import type { LiveProgress } from "@/features/liveProgress/liveProgress";
import { createProgressSync } from "@/features/liveProgress/progressSync";

const progress = (step = "Working", sessionId = "a"): LiveProgress => ({
  sessionId,
  projectId: "p",
  title: "t",
  project: "p",
  status: "working",
  step,
  startedAt: 1,
  sprite: [],
  others: 0,
});

describe("createProgressSync", () => {
  it("clears a card left from before a restart, even when nothing runs", async () => {
    const show = vi.fn(async () => {});
    await createProgressSync(show, vi.fn()).set(null);
    expect(show).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("skips what's already shown, unless asked to refresh", async () => {
    const show = vi.fn(async () => {});
    const sync = createProgressSync(show, vi.fn());
    await sync.set(progress());
    await sync.set(progress());
    expect(show).toHaveBeenCalledTimes(1);
    await sync.set(progress(), true);
    expect(show).toHaveBeenCalledTimes(2);
    await sync.set(progress("Next"));
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("retries after a failure, instead of thinking it's shown", async () => {
    const show = vi
      .fn<(next: LiveProgress | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("native"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const sync = createProgressSync(show, onError);
    await sync.set(progress());
    expect(onError).toHaveBeenCalledTimes(1);
    await sync.set(progress());
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("runs one call at a time, and ends on the latest state", async () => {
    const release: (() => void)[] = [];
    let active = 0;
    let most = 0;
    const seen: (string | undefined)[] = [];
    const show = vi.fn((next: LiveProgress | null) => {
      active++;
      most = Math.max(most, active);
      seen.push(next?.sessionId);
      return new Promise<void>((resolve) => {
        release.push(() => {
          active--;
          resolve();
        });
      });
    });
    const sync = createProgressSync(show, vi.fn());
    const done = sync.set(progress("Working", "a"));
    void sync.set(progress("Working", "b"));
    void sync.set(null);
    release.shift()!();
    await vi.waitFor(() => expect(release.length).toBe(1));
    release.shift()!();
    await done;
    expect(most).toBe(1);
    // "b" was overtaken while "a" ran, so it never reaches the screen.
    expect(seen).toEqual(["a", undefined]);
  });
});
