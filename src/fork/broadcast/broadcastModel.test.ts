import { describe, expect, it, vi } from "vitest";
import {
  broadcastProjects,
  leftOutLine,
  planBroadcast,
  sendBroadcast,
  sendLabel,
  type BroadcastFacts,
  type BroadcastSession,
} from "./broadcastModel";

const started = [{ role: "user" }];

function session(id: string, extra: Partial<BroadcastSession> = {}): BroadcastSession {
  return { id, cwd: "/p", blocks: started, ...extra };
}

function facts(extra: Partial<BroadcastFacts> = {}): BroadcastFacts {
  return {
    scope: "all",
    project: "/p",
    sameProject: (a, b) => a === b,
    isMono: () => false,
    isOrchestrationLead: () => false,
    needsInput: () => false,
    composerDraft: () => undefined,
    isRemote: () => false,
    remoteReachable: () => true,
    ...extra,
  };
}

describe("planBroadcast", () => {
  it("reaches idle sessions now and busy ones after their turn", () => {
    const plan = planBroadcast([session("a"), session("b", { busy: true })], facts());
    expect(plan.targets).toEqual([
      { id: "a", when: "now" },
      { id: "b", when: "after this turn" },
    ]);
    expect(plan.leftOut).toEqual({});
  });

  it("keeps to the project on screen, unless asked for all", () => {
    const sessions = [session("a"), session("b", { cwd: "/q" })];
    expect(planBroadcast(sessions, facts({ scope: "project" })).targets.map((t) => t.id)).toEqual(["a"]);
    expect(planBroadcast(sessions, facts({ scope: "all" })).targets.map((t) => t.id)).toEqual(["a", "b"]);
    expect(planBroadcast(sessions, facts({ scope: "project", project: undefined })).targets).toEqual([]);
  });

  it("keeps to one picked project, whichever is on screen, with the same exclusions", () => {
    const sessions = [
      session("a"),
      session("b", { cwd: "/q" }),
      session("c", { cwd: "/q", busy: true }),
      session("d", { cwd: "/q", blocks: [] }),
    ];
    const plan = planBroadcast(sessions, facts({ scope: { path: "/q" } }));
    expect(plan.targets).toEqual([
      { id: "b", when: "now" },
      { id: "c", when: "after this turn" },
    ]);
    expect(plan.leftOut).toEqual({ "not started": 1 });
    expect(planBroadcast(sessions, facts({ scope: { path: "/none" } })).targets).toEqual([]);
  });

  it("lists each open project once to pick from, without Monos or hidden sessions", () => {
    const paths = broadcastProjects(
      [
        session("a"),
        session("b", { cwd: "/q" }),
        session("c", { cwd: "/q/" }),
        session("mono", { cwd: "/mono" }),
        session("gone", { cwd: "/archived", archived: true }),
      ],
      {
        sameProject: (a, b) => a.replace(/\/$/, "") === b.replace(/\/$/, ""),
        isMono: (id) => id === "mono",
      },
    );
    expect(paths).toEqual(["/p", "/q"]);
  });

  it("leaves out each kind, and counts why", () => {
    const plan = planBroadcast(
      [
        session("mono"),
        session("sweep"),
        session("worker", { orchestrationLeadId: "lead" }),
        session("lead"),
        session("asking"),
        session("saved", { blocks: [{ role: "user", draft: true }] }),
        session("typing"),
        session("blank", { blocks: [] }),
        session("ok"),
      ],
      facts({
        isMono: (id) => id === "mono" || id === "sweep",
        isOrchestrationLead: (s) => s.id === "lead",
        needsInput: (s) => s.id === "asking",
        composerDraft: (id) => (id === "typing" ? "half a thought" : undefined),
      }),
    );
    expect(plan.targets.map((t) => t.id)).toEqual(["ok"]);
    expect(plan.leftOut).toEqual({
      mono: 2,
      orchestration: 2,
      "needs input": 1,
      draft: 2,
      "not started": 1,
    });
  });

  it("hides what is not really open, without counting it", () => {
    const plan = planBroadcast(
      [
        session("a", { archived: true }),
        session("b", { sidebarHidden: true }),
        session("c", { inboxAsk: {} }),
        session("d", { worktreeRemoved: true }),
      ],
      facts(),
    );
    expect(plan).toEqual({ targets: [], leftOut: {} });
  });

  it("ignores a composer holding only spaces", () => {
    const plan = planBroadcast([session("a")], facts({ composerDraft: () => "  \n" }));
    expect(plan.targets).toHaveLength(1);
  });

  it("blocks a remote session it can't reach, and says why", () => {
    const remote = facts({ isRemote: () => true, remoteReachable: (id) => id !== "closed" });
    const plan = planBroadcast(
      [session("idle"), session("busy", { busy: true }), session("closed")],
      remote,
    );
    expect(plan.targets[0].blocked).toBeUndefined();
    expect(plan.targets[1].blocked).toMatch(/can't queue/);
    expect(plan.targets[2].blocked).toMatch(/connect/);
  });
});

describe("leftOutLine and sendLabel", () => {
  it("reads as plain words", () => {
    expect(leftOutLine({})).toBe("");
    expect(leftOutLine({ "needs input": 2, draft: 1, mono: 1 })).toBe(
      "Left out: 1 Mono, 2 need your input, 1 holds a draft",
    );
    expect(sendLabel(7)).toBe("Send to 7 sessions");
    expect(sendLabel(1)).toBe("Send to 1 session");
  });
});

describe("sendBroadcast", () => {
  const plan = planBroadcast(
    [session("idle"), session("busy", { busy: true }), session("refuses")],
    facts(),
  );

  it("says what became of each, and only sends what was chosen", async () => {
    const submit = vi.fn((id: string) => id !== "refuses");
    const results = await sendBroadcast(new Set(["idle", "busy", "refuses"]), plan, "go", submit);
    expect(results).toEqual([
      { id: "idle", outcome: "sent" },
      { id: "busy", outcome: "queued" },
      { id: "refuses", outcome: "failed", why: "It did not accept the message" },
    ]);
    expect(await sendBroadcast(new Set(["idle"]), plan, "go", submit)).toHaveLength(1);
    expect(submit).toHaveBeenCalledWith("idle", "go");
    expect(submit).toHaveBeenCalledTimes(4);
  });

  it("waits for a late answer, and reports a late refusal or rejection as failed", async () => {
    const results = await sendBroadcast(new Set(["idle", "busy", "refuses"]), plan, "go", async (id) => {
      if (id === "refuses") {
        throw new Error("sync failed");
      }
      return id === "idle";
    });
    expect(results).toEqual([
      { id: "idle", outcome: "sent" },
      { id: "busy", outcome: "failed", why: "It did not accept the message" },
      { id: "refuses", outcome: "failed", why: "Error: sync failed" },
    ]);
  });

  it("does not send to one that stopped being fit since the plan on screen", async () => {
    const submit = vi.fn(() => true);
    const results = await sendBroadcast(new Set(["gone"]), plan, "go", submit);
    expect(results).toEqual([{ id: "gone", outcome: "failed", why: "It can't take this now" }]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not send to a blocked one, and survives a throw", async () => {
    const blocked = { targets: [{ id: "r", when: "now" as const, blocked: "No link" }], leftOut: {} };
    expect(await sendBroadcast(new Set(["r"]), blocked, "go", () => true)).toEqual([
      { id: "r", outcome: "failed", why: "No link" },
    ]);
    const results = await sendBroadcast(new Set(["idle"]), plan, "go", () => {
      throw new Error("boom");
    });
    expect(results).toEqual([{ id: "idle", outcome: "failed", why: "Error: boom" }]);
  });
});
