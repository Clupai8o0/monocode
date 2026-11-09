import { afterEach, describe, expect, it } from "vitest";
import {
  FILL_AT_ONCE,
  pumpFillQueue,
  queueFillChats,
  resetFillQueue,
  setHomeLauncher,
  type HomeLaunch,
} from "./homeStore";

function launches(count: number): HomeLaunch[] {
  return Array.from({ length: count }, (_, i) => ({
    cwd: `/p/${i}`,
    prompt: "fill",
    title: "Fill the roadmap",
    reveal: true,
  }));
}

describe("roadmap chat queue", () => {
  afterEach(() => {
    setHomeLauncher(null);
    resetFillQueue();
  });

  it("starts a few at a time and the next as one finishes", () => {
    const started: HomeLaunch[] = [];
    setHomeLauncher((launch) => {
      started.push(launch);
      return `s-${launch.cwd}`;
    });
    queueFillChats(launches(5), 0);
    expect(started).toHaveLength(FILL_AT_ONCE);
    expect(started.every((launch) => launch.reveal === false)).toBe(true);

    // Not seen running yet: still starting, nothing new.
    pumpFillQueue(() => null, 1_000);
    expect(started).toHaveLength(FILL_AT_ONCE);

    // All running, then the first one finishes.
    pumpFillQueue(() => true, 2_000);
    pumpFillQueue((id) => id !== "s-/p/0", 3_000);
    expect(started.map((launch) => launch.cwd)).toEqual(["/p/0", "/p/1", "/p/2", "/p/3"]);

    // One that never showed up is let go after the grace period.
    pumpFillQueue((id) => (id === "s-/p/3" ? null : true), 200_000);
    expect(started).toHaveLength(5);
  });

  it("waits for the launcher and does not queue a project twice", () => {
    queueFillChats(launches(2), 0);
    queueFillChats(launches(2), 0);
    const started: string[] = [];
    setHomeLauncher((launch) => {
      started.push(launch.cwd);
      return launch.cwd;
    });
    expect(started).toEqual(["/p/0", "/p/1"]);
  });
});
