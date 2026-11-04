import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import {
  LIVE_FOLD_QUIET_MS,
  liveActivityFingerprint,
  liveFoldStatusText,
  liveQuietLabel,
} from "./liveFoldStatus";

const user: Block = { id: "u", role: "user", text: "go" };
const shell = (id: string, status = "in_progress"): Block => ({
  id,
  role: "tool",
  text: "npm test",
  tool: { kind: "shell", status, title: "npm test" },
});

describe("liveFoldStatusText", () => {
  it("names the model, what it is doing, and how long", () => {
    expect(
      liveFoldStatusText({
        elapsedMs: 8 * 60_000 + 37_000,
        modelName: "Opus 5.5",
        blocks: [user],
        paused: false,
      }),
    ).toBe("Opus 5.5 · Thinking… · 8m 37s");
  });

  it("names a running tool instead of thinking", () => {
    expect(
      liveFoldStatusText({
        elapsedMs: 130_000,
        modelName: "Opus 5.5",
        blocks: [user, shell("c1")],
        paused: false,
      }),
    ).toBe("Opus 5.5 · Running command… · 2m 10s");
  });

  it("keeps the waiting label while paused", () => {
    expect(
      liveFoldStatusText({
        elapsedMs: 5_000,
        modelName: "Opus 5.5",
        blocks: [user],
        paused: true,
        waitingLabel: "Waiting for answers",
      }),
    ).toBe("Waiting for answers");
  });

  it("appends background work and a quiet hint", () => {
    expect(
      liveFoldStatusText({
        elapsedMs: 600_000,
        modelName: "Opus 5.5",
        blocks: [user, shell("c1")],
        paused: false,
        backgroundTasks: ["npm test"],
        quietMs: LIVE_FOLD_QUIET_MS,
      }),
    ).toBe(
      "Opus 5.5 · Running command… · 10m · running in background · nothing new for 1m",
    );
  });
});

describe("liveActivityFingerprint", () => {
  it("changes when streamed text grows or a tool arrives", () => {
    const thinking: Block = {
      id: "r",
      role: "reasoning",
      text: "hmm",
      streaming: true,
    };
    const first = liveActivityFingerprint([user, thinking]);
    const grown = liveActivityFingerprint([
      user,
      { ...thinking, text: "hmm more" },
    ]);
    const withTool = liveActivityFingerprint([user, thinking, shell("c1")]);
    expect(grown).not.toBe(first);
    expect(withTool).not.toBe(grown);
  });
});

describe("liveQuietLabel", () => {
  it("speaks in minutes once the quiet threshold is meaningful", () => {
    expect(liveQuietLabel(90_000)).toBe("nothing new for 1m");
    expect(liveQuietLabel(3_900_000)).toBe("nothing new for 1h 5m");
  });
});
