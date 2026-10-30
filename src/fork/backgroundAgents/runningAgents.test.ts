import { describe, expect, it } from "vitest";
import type { Block } from "../../features/sessions/model/session";
import {
  agentActivity,
  publishRunningWork,
  runningLabel,
  runningWork,
} from "./runningAgents";

let n = 0;
function block(partial: Partial<Block>): Block {
  n += 1;
  return { id: `b${n}`, role: "tool", text: "", ...partial } as Block;
}
const user = () => block({ role: "user", text: "go" });
const agent = (status: string) =>
  block({ text: "Agent", tool: { kind: "agent", title: "Agent", status } });
const command = (status: string, background = true) =>
  block({
    text: "npm test",
    tool: { kind: "execute", title: "npm test", status, background },
  });

describe("runningWork", () => {
  it("finds running agents and background commands in the current turn", () => {
    const work = runningWork({
      busy: true,
      blocks: [
        user(),
        agent("in_progress"),
        agent("completed"),
        command("in_progress"),
        command("in_progress", false),
      ],
    });
    expect(work.agents).toHaveLength(1);
    expect(work.commands).toHaveLength(1);
    expect(runningLabel(work)).toBe("1 agent, 1 command running");
  });

  it("ignores earlier turns and idle sessions", () => {
    const blocks = [user(), agent("in_progress"), user()];
    expect(runningWork({ busy: true, blocks }).agents).toHaveLength(0);
    expect(
      runningWork({ busy: false, blocks: [user(), agent("in_progress")] })
        .agents,
    ).toHaveLength(0);
  });

  it("keeps work started before a steered or queued message", () => {
    const steered = block({ role: "user", text: "also", sentAt: 1 });
    const queuedBlock = block({ role: "user", text: "later" });
    const work = runningWork({
      busy: true,
      blocks: [user(), agent("in_progress"), steered, queuedBlock],
      queuedMessages: [{ blockId: queuedBlock.id } as never],
    });
    expect(work.agents).toHaveLength(1);
  });

  it("labels plurals", () => {
    const work = runningWork({
      busy: true,
      blocks: [user(), agent("running"), agent("running")],
    });
    expect(runningLabel(work)).toBe("2 agents running");
  });
});

describe("publishRunningWork", () => {
  it("accepts sessions without running work", () => {
    expect(() =>
      publishRunningWork([{ id: "s1", busy: false, blocks: [] }]),
    ).not.toThrow();
  });
});

describe("agentActivity", () => {
  const session = (partial: object) => ({
    busy: false,
    blocks: [] as Block[],
    ...partial,
  });

  it("counts busy sessions as working and blocked ones as waiting", () => {
    const pending = block({
      approval: { decided: false },
    } as unknown as Partial<Block>);
    expect(
      agentActivity([
        session({ busy: true }),
        session({ busy: true, blocks: [pending] }),
        session({ pendingQuestion: { id: "q" } }),
        session({}),
      ]),
    ).toEqual({ working: 1, waiting: 2 });
  });

  it("ignores a session whose worktree is gone", () => {
    expect(
      agentActivity([
        session({
          busy: true,
          pendingQuestion: { id: "q" },
          worktreeRemoved: true,
        }),
      ]),
    ).toEqual({ working: 0, waiting: 0 });
  });
});
