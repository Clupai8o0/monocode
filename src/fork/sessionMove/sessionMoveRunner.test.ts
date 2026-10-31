import { describe, expect, it } from "vitest";
import { createCancel, recoverMove, runMove, type MoveDeps, type MovePlan, type MoveProgress } from "./sessionMoveRunner";

const PLAN: MovePlan = {
  moveId: "move-1234",
  sessionId: "tab-1",
  providerSessionId: "conv-1",
  name: "my-session",
  cwd: "/Users/me/Documents/projects/app",
};

const MANIFEST = {
  version: 1,
  sessionId: "conv-1",
  head: "a".repeat(40),
  sourcePath: PLAN.cwd,
  files: [
    { path: "changes.patch", size: 4, sha256: "0".repeat(64) },
    { path: "empty", size: 0, sha256: "0".repeat(64) },
  ],
  links: [],
  ignored: [".env"],
  ignoredMore: 0,
};

type Fail = Partial<Record<string, string>>;

function harness(over: Partial<MoveDeps> = {}, fail: Fail = {}) {
  const log: string[] = [];
  const op = (side: string) =>
    (async (name: string, params: Record<string, unknown>) => {
      log.push(`${side}:${name}`);
      if (fail[`${side}:${name}`]) throw new Error(fail[`${side}:${name}`]);
      switch (name) {
        case "inspect":
          return { repoRoot: PLAN.cwd, remotes: [{ name: "origin", url: "u" }], hasTranscript: true, account: "cx" };
        case "check":
          return { ok: true, repo: "/r", remoteName: "origin", matchedUrl: "u" };
        case "pack":
          return MANIFEST;
        case "read":
          return { data: "eHh4eA==" };
        case "unpackCode":
          expect(params.name).toBe("my-session");
          return { repo: "/r", cwd: "/r/.claude/worktrees/moved-my-session", branch: "moved/my-session" };
        case "unpackConversation":
          expect(params.account).toBe("cx");
          return { account: "cx" };
        default:
          return {};
      }
    }) as MoveDeps["source"];
  let time = 0;
  const deps: MoveDeps = {
    source: op("source"),
    target: op("target"),
    sourceState: async () => "idle",
    stopSource: async () => {
      log.push("stop");
      if (fail.stop) throw new Error(fail.stop);
      return true;
    },
    resumeSource: async () => {
      log.push("resume");
      if (fail.resume) throw new Error(fail.resume);
    },
    startTarget: async () => {
      log.push("start");
      if (fail.start) throw new Error(fail.start);
      return { name: "my-session" };
    },
    confirmTarget: async () => {
      log.push("confirm");
      if (fail.confirm) return { state: "failed", detail: fail.confirm };
      return { state: "up" };
    },
    finishSource: async () => {
      log.push("card");
      if (fail.card) throw new Error(fail.card);
    },
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
    ...over,
  };
  return { deps, log };
}

const nothing = { cancelled: false };

describe("runMove", () => {
  it("goes through the steps in order, and only then makes the card", async () => {
    const { deps, log } = harness();
    const steps: string[] = [];
    const outcome = await runMove(PLAN, deps, (p) => steps.push(p.step), nothing);
    expect(outcome.kind).toBe("moved");
    expect(log).toEqual([
      "source:inspect",
      "target:check",
      "stop",
      "source:pack",
      "source:read",
      "target:write",
      "target:write",
      "target:unpackCode",
      "target:unpackConversation",
      "start",
      "confirm",
      "card",
      "target:done",
      "source:done",
    ]);
    expect(steps.filter((step, i) => steps[i - 1] !== step)).toEqual([
      "check", "stop", "code", "conversation", "start", "confirm", "finish",
    ]);
    if (outcome.kind === "moved") {
      expect(outcome.result.leftBehind).toEqual([".env"]);
      expect(outcome.result.name).toBe("my-session");
    }
  });

  it("before the stop, a refusal only says why", async () => {
    for (const fail of [{ "source:inspect": "Client work stays on the Mac" }, { "target:check": "offline" }]) {
      const { deps, log } = harness({}, fail);
      const outcome = await runMove(PLAN, deps, () => {}, nothing);
      expect(outcome).toMatchObject({ kind: "failed", reason: Object.values(fail)[0] });
      expect(log).not.toContain("stop");
      expect(log).not.toContain("resume");
      expect(log).not.toContain("target:undo");
    }
    const { deps, log } = harness({
      target: (async () => ({ ok: false, reason: "This repository is not on that machine" })) as never,
    });
    expect(await runMove(PLAN, deps, () => {}, nothing)).toEqual({
      kind: "failed",
      reason: "This repository is not on that machine",
    });
    expect(log).not.toContain("stop");
  });

  it("refuses without a conversation or a remote", async () => {
    const source = (result: object) => (async () => result) as never;
    const none = harness({ source: source({ repoRoot: "/", remotes: [{ name: "o", url: "u" }], hasTranscript: false, account: "main" }) });
    expect((await runMove(PLAN, none.deps, () => {}, nothing)).kind).toBe("failed");
    const lone = harness({ source: source({ repoRoot: "/", remotes: [], hasTranscript: true, account: "main" }) });
    expect(await runMove(PLAN, lone.deps, () => {}, nothing)).toMatchObject({
      reason: "This repository has no remote to match on the other machine",
    });
  });

  // One failure at each step after the stop: removed from the target, resumed
  // here, one line of why, and no card.
  for (const [where, fail] of [
    ["stopping", { stop: "stuck" }],
    ["packing", { "source:pack": "boom" }],
    ["reading a piece", { "source:read": "boom" }],
    ["writing a piece", { "target:write": "boom" }],
    ["unpacking the code", { "target:unpackCode": "boom" }],
    ["unpacking the conversation", { "target:unpackConversation": "boom" }],
    ["starting", { start: "boom" }],
    ["confirming", { confirm: "boom" }],
    ["making the card", { card: "boom" }],
  ] as Array<[string, Fail]>) {
    it(`rolls back after a failure ${where}`, async () => {
      const { deps, log } = harness({}, fail);
      const outcome = await runMove(PLAN, deps, () => {}, nothing);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe(Object.values(fail)[0]);
        expect(outcome.rollbackProblem).toBeUndefined();
      }
      expect(log).toContain("target:undo");
      expect(log.indexOf("resume")).toBeGreaterThan(log.indexOf("target:undo"));
      if (where !== "making the card") expect(log).not.toContain("card");
    });
  }

  it("says so when the rollback itself goes wrong", async () => {
    const { deps } = harness({}, { "target:unpackCode": "boom", "target:undo": "no link", resume: "no tab" });
    const outcome = await runMove(PLAN, deps, () => {}, nothing);
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "boom",
      rollbackProblem: "Could not clean up the other machine: no link; Could not resume it here: no tab",
    });
  });

  it("a busy session waits, a new turn keeps it waiting, and Cancel works until the stop", async () => {
    const states = ["busy", "busy", "idle", "busy", "idle"] as const;
    let at = 0;
    const stops = [false, true];
    const { deps, log } = harness({
      sourceState: async () => states[at++],
      stopSource: async () => {
        log.push("stop");
        return stops.shift() as boolean;
      },
    });
    const progress: MoveProgress[] = [];
    const outcome = await runMove(PLAN, deps, (p) => progress.push(p), nothing);
    expect(outcome.kind).toBe("moved");
    expect(log.filter((entry) => entry === "stop")).toHaveLength(2);
    expect(progress.find((p) => p.step === "wait")?.cancellable).toBe(true);
    expect(progress.find((p) => p.step === "stop")?.cancellable).toBe(false);
    expect(progress.find((p) => p.step === "code")?.cancellable).toBe(false);

    const cancel = createCancel();
    const busy = harness({
      sourceState: async () => {
        cancel.cancel();
        return "busy";
      },
    });
    expect(await runMove(PLAN, busy.deps, () => {}, cancel)).toEqual({ kind: "cancelled" });
    expect(busy.log).not.toContain("stop");
    expect(busy.log).not.toContain("resume");
  });

  it("stops if the session ends or asks a question while it waits", async () => {
    const asks = harness({ sourceState: async () => "waiting" });
    expect(await runMove(PLAN, asks.deps, () => {}, nothing)).toEqual({
      kind: "failed",
      reason: "It is waiting for your answer",
    });
    expect(asks.log).not.toContain("stop");
    const gone = harness({ sourceState: async () => "gone" });
    expect((await runMove(PLAN, gone.deps, () => {}, nothing)).kind).toBe("failed");
  });

  it("a full machine queues and says so, then rolls back if it never comes up", async () => {
    const answers = ["queued", "queued", "starting", "up"] as const;
    let at = 0;
    const queued = harness({ confirmTarget: async () => ({ state: answers[at++] }) });
    const seen: Array<boolean | undefined> = [];
    const outcome = await runMove(PLAN, queued.deps, (p) => {
      if (p.step === "confirm") seen.push(p.queued);
    }, nothing);
    expect(outcome.kind).toBe("moved");
    expect(seen).toContain(true);

    const never = harness({ confirmTarget: async () => ({ state: "starting" }) });
    const stuck = await runMove(PLAN, never.deps, () => {}, nothing);
    expect(stuck).toMatchObject({ kind: "failed", reason: "It did not come up on the other machine" });
    expect(never.log).toContain("target:undo");
    expect(never.log).toContain("resume");

    const line = harness({ confirmTarget: async () => ({ state: "queued" }) });
    expect(await runMove(PLAN, line.deps, () => {}, nothing)).toMatchObject({
      reason: "The other machine stayed full for 15 minutes",
    });
  });

  it("keeps a journal from the stop until the end, and clears it on failure too", async () => {
    for (const fail of [{}, { "target:unpackCode": "boom" }] as Fail[]) {
      const events: string[] = [];
      const { deps, log } = harness({ journal: { begin: () => events.push(`begin@${log.length}`), end: () => events.push("end") } }, fail);
      await runMove(PLAN, deps, () => {}, nothing);
      expect(events[0]).toBe(`begin@${log.indexOf("stop")}`);
      expect(events[events.length - 1]).toBe("end");
    }
  });

  it("undoes a move the app closed in the middle of", async () => {
    const journal = { plan: PLAN, machineId: "m", direction: "to-host" as const };
    const { deps, log } = harness();
    expect(await recoverMove(journal, deps)).toBe(true);
    expect(log).toEqual(["target:undo", "source:done", "resume"]);
    const stuck = harness({}, { "target:undo": "offline" });
    expect(await recoverMove(journal, stuck.deps)).toBe(false);
    expect(stuck.log).not.toContain("resume");
  });
});
