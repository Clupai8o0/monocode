import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentStep,
  Block,
} from "../../features/sessions/model/session";
import {
  agentNowText,
  agentStatusText,
  axisPercent,
  boardAxis,
  boardCounts,
  boardLabel,
  boardTurn,
  boardVisible,
  quietForMs,
  quietLabel,
  recordBoardTimings,
  runsOverlap,
  runTiming,
  trackedRunCount,
  type RunTiming,
} from "./agentBoard";

let n = 0;
function block(partial: Partial<Block>): Block {
  n += 1;
  return { id: `b${n}`, role: "tool", text: "", ...partial } as Block;
}
const user = () => block({ role: "user", text: "go" });
const toolStep = (id: string, text = "Read a.ts", status?: string): AgentStep => ({
  id,
  kind: "tool",
  text,
  status,
});
const agent = (status: string, steps: AgentStep[] = []) =>
  block({
    text: "Agent",
    tool: { kind: "agent", title: "Agent", status },
    agentRun: { name: "Reviewer", steps },
  });
const command = (status: string) =>
  block({
    text: "npm test",
    tool: { kind: "execute", title: "npm test", status, background: true },
  });

const timing = (partial: Partial<RunTiming>): RunTiming => ({
  start: 0,
  end: null,
  lastStepAt: null,
  steps: new Map(),
  ...partial,
});

beforeEach(() => {
  recordBoardTimings([], 0);
});

describe("boardTurn", () => {
  it("keeps finished agents, in spawn order, but only running commands", () => {
    const first = agent("completed");
    const second = agent("in_progress");
    const turn = boardTurn({
      busy: true,
      blocks: [user(), first, second, command("in_progress"), command("completed")],
    });
    expect(turn.agents).toEqual([first, second]);
    expect(turn.commands).toHaveLength(1);
  });

  it("ignores earlier turns and idle sessions", () => {
    const blocks = [user(), agent("in_progress"), user()];
    expect(boardTurn({ busy: true, blocks }).agents).toHaveLength(0);
    expect(boardTurn({ busy: false, blocks: [agent("in_progress")] }).agents).toHaveLength(0);
  });

  it("does not take a message steered into the turn as a new turn", () => {
    const turn = boardTurn({
      busy: true,
      blocks: [
        user(),
        agent("in_progress"),
        block({ role: "user", text: "also", sentAt: 1 }),
      ],
    });
    expect(turn.agents).toHaveLength(1);
  });
});

describe("boardVisible", () => {
  it("stays up for two finished agents but not for one", () => {
    const done = () => agent("completed");
    expect(boardVisible({ agents: [done(), done()], commands: [] })).toBe(true);
    expect(boardVisible({ agents: [done()], commands: [] })).toBe(false);
    expect(boardVisible({ agents: [agent("in_progress")], commands: [] })).toBe(true);
    expect(boardVisible({ agents: [], commands: [command("in_progress")] })).toBe(true);
  });
});

describe("boardLabel", () => {
  it("counts finished agents out of all of them", () => {
    const agents = [
      agent("completed"),
      agent("failed"),
      agent("completed"),
      agent("in_progress"),
      agent("in_progress"),
    ];
    expect(boardLabel({ agents, commands: [] })).toBe("3 of 5 agents done");
    expect(boardCounts(agents)).toEqual({ done: 3, failed: 1, running: 2 });
  });

  it("names running commands alongside", () => {
    const agents = [agent("completed"), agent("in_progress")];
    expect(boardLabel({ agents, commands: [command("in_progress")] })).toBe(
      "1 of 2 agents done, 1 command running",
    );
  });

  it("keeps the tray's wording for a single agent", () => {
    expect(boardLabel({ agents: [agent("in_progress")], commands: [] })).toBe(
      "1 agent running",
    );
    expect(
      boardLabel({ agents: [agent("completed")], commands: [command("in_progress")] }),
    ).toBe("1 command running");
  });
});

describe("runsOverlap", () => {
  it("sees two runs going at once", () => {
    expect(
      runsOverlap([
        { start: 0, end: 10 },
        { start: 5, end: 20 },
      ]),
    ).toBe(true);
  });

  it("is strict: one ending as the next starts is sequential", () => {
    expect(
      runsOverlap([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBe(false);
  });

  it("treats a run with no end as still going, whatever the order", () => {
    expect(
      runsOverlap([
        { start: 5, end: null },
        { start: 0, end: null },
      ]),
    ).toBe(true);
    expect(runsOverlap([{ start: 0, end: 5 }, { start: 6, end: null }])).toBe(false);
  });

  it("finds overlap with an earlier long run, not just the neighbour", () => {
    expect(
      runsOverlap([
        { start: 0, end: 100 },
        { start: 1, end: 2 },
      ]),
    ).toBe(true);
    expect(
      runsOverlap([
        { start: 0, end: 100 },
        { start: 3, end: 4 },
        { start: 50, end: 60 },
      ]),
    ).toBe(true);
  });

  it("needs two runs", () => {
    expect(runsOverlap([])).toBe(false);
    expect(runsOverlap([{ start: 0, end: null }])).toBe(false);
  });
});

describe("status text", () => {
  it("puts the newest step on one line", () => {
    expect(
      agentNowText([toolStep("1", "old"), toolStep("2", "  Run\n  npm   test ")]),
    ).toBe("Run npm test");
    expect(agentNowText([toolStep("1", "old"), toolStep("2", "  ")])).toBe("old");
  });

  it("covers each state", () => {
    expect(agentStatusText(agent("in_progress"))).toBe("Starting…");
    expect(agentStatusText(agent("in_progress", [toolStep("1", "Read a.ts")]))).toBe(
      "Read a.ts",
    );
    expect(agentStatusText(agent("completed", [toolStep("1"), toolStep("2")]))).toBe(
      "Done · 2 steps",
    );
    expect(agentStatusText(agent("completed"))).toBe("Done");
    expect(agentStatusText(agent("failed", [toolStep("1")]))).toBe("Failed");
  });
});

describe("quiet", () => {
  it("only speaks up after two minutes without a new step", () => {
    const run = timing({ start: 0, lastStepAt: 60_000 });
    expect(quietForMs(run, 60_000 + 119_999)).toBeNull();
    expect(quietForMs(run, 60_000 + 120_000)).toBe(120_000);
    expect(quietLabel(180_000)).toBe("No new step for 3m");
    expect(quietLabel(3_900_000)).toBe("No new step for 1h 5m");
  });

  it("counts from the start with no steps, and never for a finished run", () => {
    expect(quietForMs(timing({ start: 0 }), 120_000)).toBe(120_000);
    expect(quietForMs(timing({ start: 0, end: 5 }), 999_999)).toBeNull();
  });
});

describe("axis", () => {
  it("spans the earliest start to the latest end, or now", () => {
    const axis = boardAxis(
      [
        { start: 10, end: 20 },
        { start: 15, end: null },
      ],
      110,
    );
    expect(axis).toEqual({ start: 10, end: 110 });
    expect(axisPercent(axis, 60)).toBe(50);
  });

  it("stops at the last end once nothing runs", () => {
    expect(boardAxis([{ start: 0, end: 20 }], 999)).toEqual({ start: 0, end: 20 });
  });

  it("clamps, and copes with an empty span", () => {
    const axis = { start: 10, end: 20 };
    expect(axisPercent(axis, 5)).toBe(0);
    expect(axisPercent(axis, 25)).toBe(100);
    expect(axisPercent({ start: 5, end: 5 }, 5)).toBe(0);
  });
});

describe("timing store", () => {
  it("records a run's start, first-seen steps and end", () => {
    const steps = [toolStep("s1")];
    const run = agent("in_progress", steps);
    const session = { busy: true, blocks: [user(), run] };
    recordBoardTimings([session], 100);
    expect(runTiming(run.id)).toMatchObject({ start: 100, end: null, lastStepAt: 100 });

    // A later publish does not move a step already seen.
    run.agentRun = { ...run.agentRun!, steps: [...steps, toolStep("s2")] };
    recordBoardTimings([session], 200);
    const later = runTiming(run.id)!;
    expect(later.steps.get("s1")).toBe(100);
    expect(later.steps.get("s2")).toBe(200);
    expect(later.lastStepAt).toBe(200);

    run.tool = { ...run.tool!, status: "completed" };
    recordBoardTimings([session], 300);
    expect(runTiming(run.id)).toMatchObject({ start: 100, end: 300 });
    recordBoardTimings([session], 400);
    expect(runTiming(run.id)?.end).toBe(300);
  });

  it("forgets steps that fall off a capped trail", () => {
    const run = agent("in_progress", [toolStep("s1"), toolStep("s2")]);
    const session = { busy: true, blocks: [user(), run] };
    recordBoardTimings([session], 100);
    run.agentRun = { ...run.agentRun!, steps: [toolStep("s2"), toolStep("s3")] };
    recordBoardTimings([session], 200);
    expect([...runTiming(run.id)!.steps.keys()]).toEqual(["s2", "s3"]);
  });

  it("drops runs no longer on a live board", () => {
    const running = agent("in_progress");
    const finished = command("in_progress");
    const session = { busy: true, blocks: [user(), running, finished] };
    recordBoardTimings([session], 100);
    expect(trackedRunCount()).toBe(2);

    finished.tool = { ...finished.tool!, status: "completed" };
    recordBoardTimings([session], 200);
    expect(runTiming(finished.id)).toBeUndefined();
    expect(trackedRunCount()).toBe(1);

    recordBoardTimings([{ ...session, busy: false }], 300);
    expect(trackedRunCount()).toBe(0);
  });

  it("does not disturb the clock for an unchanged publish", () => {
    const run = agent("in_progress", [toolStep("s1")]);
    recordBoardTimings([{ busy: true, blocks: [user(), run] }], 500);
    recordBoardTimings([{ busy: true, blocks: [user(), run] }], 900);
    expect(runTiming(run.id)).toMatchObject({ start: 500, lastStepAt: 500 });
  });
});
