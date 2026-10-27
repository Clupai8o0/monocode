import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readNotifyConfig,
  settledPush,
  startNotifications,
  waitingOn,
  waitingPush,
  writeNotifyConfig,
} from "./notify";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "monocode-notify-test-"));
  dirs.push(dir);
  return dir;
};

it("pushes how a turn ended", () => {
  const done = { cancelled: false, interrupted: false };
  expect(settledPush("Fix", done).title).toBe("Done: Fix");
  expect(settledPush("Fix", { ...done, cancelled: true }).title).toBe("Stopped: Fix");
  expect(settledPush("Fix", { ...done, error: "boom" })).toMatchObject({
    title: "Failed: Fix",
    message: "boom",
  });
  expect(settledPush("Fix", { ...done, interrupted: true }).title).toBe("Failed: Fix");
});

it("pushes each new thing a session waits on, and nothing on the first look", () => {
  expect(waitingPush(undefined, "r:approval:1", "Fix")).toBeNull();
  expect(waitingPush("", "r:approval:1", "Fix")?.title).toBe("Needs you: Fix");
  expect(waitingPush("r:approval:1", "r:approval:1", "Fix")).toBeNull();
  expect(waitingPush("r:approval:1", "r:approval:2", "Fix")?.title).toBe("Needs you: Fix");
  expect(waitingPush("r:approval:1", "", "Fix")).toBeNull();
});

it("names what a session waits on", () => {
  const session = (blocks: object[], pendingQuestion?: object) =>
    ({ runId: "r", session: { blocks, pendingQuestion } }) as never;
  expect(waitingOn(session([]))).toBe("");
  expect(
    waitingOn(session([{ approval: { requestId: 3, decided: false } }])),
  ).toBe("r:approval:3");
  expect(
    waitingOn(session([{ approval: { requestId: 3, decided: true } }], { requestId: 4 })),
  ).toBe("r:question:4");
});

it("keeps its server and a random topic, and refuses odd ones", () => {
  const dir = temp();
  expect(readNotifyConfig(dir)).toBeNull();
  const config = writeNotifyConfig(dir, "http://127.0.0.1:2586/");
  expect(config.server).toBe("http://127.0.0.1:2586");
  expect(config.topic).toMatch(/^monocode-[0-9a-f]{24}$/);
  expect(readNotifyConfig(dir)).toEqual(config);
  expect(() => writeNotifyConfig(dir, "ftp://x")).toThrow();
  expect(() => writeNotifyConfig(dir, "http://x", "a/b")).toThrow();
});

it("sends each ended turn and each new wait, only once set up", () => {
  const dir = temp();
  let summary = { id: "s1", title: "Fix the build", harness: "claude", needsInput: false };
  let blocks: object[] = [];
  const engine: { store: object; onSettled?: (value: never, outcome: never) => void } = {
    store: {
      projects: () => [{ id: "p" }],
      summaries: () => [summary],
      session: () => ({ runId: "r", session: { blocks } }),
    },
  };
  const send = vi.fn(async () => {});
  const watcher = startNotifications(engine as never, dir, send);
  const settle = () =>
    engine.onSettled!(
      { session: { title: "Fix the build", harness: "claude" } } as never,
      { cancelled: false, interrupted: false } as never,
    );
  try {
    settle();
    expect(send).not.toHaveBeenCalled();
    writeFileSync(
      join(dir, "notify.json"),
      JSON.stringify({ server: "http://127.0.0.1:2586", topic: "t1" }),
    );
    settle();
    expect(send).toHaveBeenLastCalledWith(
      { server: "http://127.0.0.1:2586", topic: "t1" },
      expect.objectContaining({ title: expect.stringMatching(/^Done: /) }),
    );
    summary = { ...summary, needsInput: true };
    blocks = [{ approval: { requestId: 1, decided: false } }];
    watcher.scan();
    expect(send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ title: expect.stringMatching(/^Needs you: /) }),
    );
    watcher.scan();
    expect(send).toHaveBeenCalledTimes(2);
    // The next approval, answered and asked again between two looks.
    blocks = [{ approval: { requestId: 2, decided: false } }];
    watcher.scan();
    expect(send).toHaveBeenCalledTimes(3);
    // A session started after the first look, already waiting when first seen.
    summary = { ...summary, id: "s2" };
    watcher.scan();
    expect(send).toHaveBeenCalledTimes(4);
  } finally {
    watcher.stop();
  }
  expect(engine.onSettled).toBeUndefined();
});
