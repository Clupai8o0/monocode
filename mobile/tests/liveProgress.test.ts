import { describe, expect, it } from "vitest";

import {
  formatElapsed,
  liveProgressLink,
  ongoingNotificationText,
  pickLiveProgress,
  sameLiveProgress,
} from "@/features/liveProgress/liveProgress";
import type { SessionSummary } from "@/features/workspace/types";

const NOW = 1_800_000_000_000;
const session = (over: Partial<SessionSummary>) =>
  ({
    id: "s",
    projectId: "p",
    title: "Fix the login",
    harness: "claude",
    model: "opus",
    branch: "",
    updatedAt: NOW - 1000,
    ...over,
  }) as SessionSummary;
const projects = [{ id: "p", name: "panoptic" }];

describe("pickLiveProgress", () => {
  it("has nothing to show when nothing runs", () => {
    expect(pickLiveProgress([session({})], projects, NOW)).toBeNull();
  });

  it("shows the step and start time the desktop sent", () => {
    const progress = pickLiveProgress(
      [session({ busy: true, step: "Running tests", busySince: NOW - 90_000 })],
      projects,
      NOW,
    )!;
    expect(progress.step).toBe("Running tests");
    expect(progress.startedAt).toBe(NOW - 90_000);
    expect(progress.project).toBe("panoptic");
    expect(progress.sprite).toHaveLength(8);
  });

  it("works with an older desktop that sends neither", () => {
    const progress = pickLiveProgress([session({ busy: true })], projects, NOW)!;
    expect(progress.step).toBe("Working");
    expect(progress.startedAt).toBe(NOW - 1000);
  });

  it("puts what needs the person first, and counts the rest", () => {
    const progress = pickLiveProgress(
      [
        session({ id: "new", busy: true, busySince: NOW }),
        session({ id: "waits", busy: true, waiting: "approval", busySince: NOW - 9000 }),
      ],
      projects,
      NOW,
    )!;
    expect(progress.sessionId).toBe("waits");
    expect(progress.status).toBe("approval");
    expect(progress.step).toBe("Needs your approval");
    expect(progress.others).toBe(1);
  });

  it("otherwise picks the most recently started", () => {
    expect(
      pickLiveProgress(
        [
          session({ id: "old", busy: true, busySince: NOW - 9000 }),
          session({ id: "new", busy: true, busySince: NOW }),
        ],
        projects,
        NOW,
      )?.sessionId,
    ).toBe("new");
  });
});

describe("sameLiveProgress", () => {
  const base = pickLiveProgress([session({ busy: true })], projects, NOW)!;

  it("treats a new step as a change, and nothing else as one", () => {
    expect(sameLiveProgress(base, { ...base })).toBe(true);
    expect(sameLiveProgress(base, { ...base, step: "Other" })).toBe(false);
    expect(sameLiveProgress(base, null)).toBe(false);
    expect(sameLiveProgress(null, null)).toBe(true);
  });
});

describe("the text", () => {
  const base = pickLiveProgress([session({ busy: true, busySince: NOW - 180_000 })], projects, NOW)!;

  it("formats elapsed time plainly", () => {
    expect(formatElapsed(20_000)).toBe("just started");
    expect(formatElapsed(180_000)).toBe("3m");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
    expect(formatElapsed(-5)).toBe("just started");
  });

  it("builds Android's card", () => {
    expect(ongoingNotificationText(base, NOW)).toEqual({
      title: "Fix the login",
      subtitle: "panoptic",
      body: "Working · 3m",
    });
    expect(ongoingNotificationText({ ...base, others: 2 }, NOW).body).toBe(
      "Working · 3m, 2 more running",
    );
  });

  it("links to the session, escaping paths", () => {
    expect(liveProgressLink({ ...base, projectId: "/a b", sessionId: "s1" })).toBe(
      "monocode://project/%2Fa%20b/session/s1",
    );
  });
});
