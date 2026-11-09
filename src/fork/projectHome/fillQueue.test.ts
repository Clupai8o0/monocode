import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** Lets accepted launches settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("roadmap chat queue", () => {
  beforeEach(() => {
    // Only the clock is fake, so awaited launches still settle.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
  });

  afterEach(() => {
    setHomeLauncher(null);
    resetFillQueue();
    vi.useRealTimers();
  });

  it("starts a few at a time and the next as one finishes", async () => {
    const started: HomeLaunch[] = [];
    setHomeLauncher(async (launch) => {
      started.push(launch);
      return `s-${launch.cwd}`;
    });
    queueFillChats(launches(5), 0);
    await settle();
    expect(started).toHaveLength(FILL_AT_ONCE);
    expect(started.every((launch) => launch.reveal === false)).toBe(true);

    // Not seen running yet: still starting, nothing new.
    pumpFillQueue(() => null, 1_000);
    expect(started).toHaveLength(FILL_AT_ONCE);

    // All running, then the first one finishes.
    pumpFillQueue(() => true, 2_000);
    pumpFillQueue((id) => id !== "s-/p/0", 3_000);
    await settle();
    expect(started.map((launch) => launch.cwd)).toEqual(["/p/0", "/p/1", "/p/2", "/p/3"]);

    // One that never showed up is let go after the grace period.
    pumpFillQueue((id) => (id === "s-/p/3" ? null : true), 200_000);
    await settle();
    expect(started).toHaveLength(5);
  });

  it("frees the slot of a chat that could not start", async () => {
    const started: string[] = [];
    setHomeLauncher(async (launch) => {
      started.push(launch.cwd);
      return launch.cwd === "/p/0" ? null : launch.cwd;
    });
    queueFillChats(launches(4), 0);
    await settle();
    await settle();
    expect(started).toEqual(["/p/0", "/p/1", "/p/2", "/p/3"]);
  });

  it("waits for the launcher and does not queue a project twice", async () => {
    queueFillChats(launches(2), 0);
    queueFillChats(launches(2), 0);
    const started: string[] = [];
    setHomeLauncher(async (launch) => {
      started.push(launch.cwd);
      return launch.cwd;
    });
    await settle();
    expect(started).toEqual(["/p/0", "/p/1"]);
  });

  it("gives up on a launch that never answers, and ignores its late answer", async () => {
    const started: string[] = [];
    let answerFirst: (id: string | null) => void = () => {};
    setHomeLauncher((launch) => {
      started.push(launch.cwd);
      if (launch.cwd === "/p/0") {
        return new Promise((resolve) => {
          answerFirst = resolve;
        });
      }
      return Promise.resolve(launch.cwd);
    });
    queueFillChats(launches(5), 0);
    await settle();
    pumpFillQueue(() => true, 60_000);
    await settle();
    expect(started).toHaveLength(FILL_AT_ONCE);

    // Two minutes without an answer: the slot goes to the next project.
    pumpFillQueue(() => true, 130_000);
    await settle();
    expect(started).toEqual(["/p/0", "/p/1", "/p/2", "/p/3"]);

    // The late answer does not take a slot back.
    answerFirst("/p/0");
    await settle();
    pumpFillQueue(() => true, 131_000);
    await settle();
    expect(started).toHaveLength(4);
  });

  it("times the start-up grace from when a launch was accepted", async () => {
    const started: string[] = [];
    const answers: Array<() => void> = [];
    setHomeLauncher((launch) => {
      started.push(launch.cwd);
      return new Promise((resolve) => {
        answers.push(() => resolve(launch.cwd));
      });
    });
    queueFillChats(launches(4), 0);
    await settle();

    // Accepted after 100 s, then not seen running yet 50 s later: still starting.
    vi.setSystemTime(100_000);
    for (const answer of answers) {
      answer();
    }
    await settle();
    pumpFillQueue(() => null, 150_000);
    await settle();
    expect(started).toHaveLength(FILL_AT_ONCE);

    // Past the grace from acceptance: let go.
    pumpFillQueue((id) => (id === "/p/0" ? null : true), 200_000);
    await settle();
    expect(started).toHaveLength(4);
  });
});
