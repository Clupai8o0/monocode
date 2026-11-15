import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import type { Session } from "../../features/sessions/model/session";
import {
  chatPhase,
  homeChats,
  needsItems,
  phaseIsActive,
  shortAge,
} from "./homeModel";
import { parsePlan } from "./planModel";

const PLAN = parsePlan(`| Phase | What | Done when | Status |
|---|---|---|---|
| 1 Daily writer | Notes | Works offline | In progress |
| 2 Search | Find notes | Search under 100 ms | |
| 3 Sync | Two devices | Both match | Done |
`)!;

function summary(id: string, title: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd: "/p/yap",
    harness: "claude",
    model: "opus",
    runtimeMode: "default",
    title,
    createdAt: 0,
    updatedAt,
    ...extra,
  } as SessionSummary;
}

function session(id: string, title: string, blocks: Partial<Session["blocks"][number]>[] = [], extra: Partial<Session> = {}): Session {
  return {
    id,
    cwd: "/p/yap",
    harness: "claude",
    model: "opus",
    modelSettings: {},
    runtimeMode: "default",
    title,
    blocks: blocks.map((block, i) => ({ id: `${id}-${i}`, role: "assistant", text: "", ...block })),
    ...extra,
  } as Session;
}

function agent(id: string, extra: Partial<LiveAgent> = {}): LiveAgent {
  return {
    id,
    cwd: "/p/yap",
    title: id,
    harness: "claude",
    activity: "Editing a file",
    needsApproval: false,
    done: false,
    ...extra,
  };
}

const checklist = (items: unknown[]) => ({
  role: "tool" as const,
  checklist: { action: "set", items },
  tool: { status: "done" },
});

describe("homeChats", () => {
  it("orders waiting, working, unseen, idle and puts chats on phases", () => {
    const chats = homeChats(
      "/p/yap",
      [
        summary("a", "Phase 2 search", 50),
        summary("b", "Fix build", 90),
        summary("c", "Daily writer polish", 10),
        summary("old", "Archived", 99, { archived: true }),
        summary("other", "Elsewhere", 99, { cwd: "/p/other" }),
      ],
      [session("c", "Daily writer polish", [{ text: "## Done\nAll **set**" }])],
      [agent("c", { needsApproval: true }), agent("a")],
      PLAN.phases,
      { b: "3" },
    );
    expect(chats.map((chat) => [chat.id, chat.state, chat.phaseId])).toEqual([
      ["c", "waiting", "1"],
      ["a", "working", "2"],
      ["b", "idle", "3"],
    ]);
    expect(chats[0].last).toBe("Done");
  });

  it("keeps a chat off every phase when the user unlinked it", () => {
    expect(chatPhase("a", "Phase 2 search", PLAN.phases, { a: "" })).toBeNull();
    expect(chatPhase("a", "Phase 2 search", PLAN.phases, {})).toBe("2");
  });
});

describe("needsItems", () => {
  it("lists questions and the person's open steps, oldest first", () => {
    const sessions = [
      session("q", "Search", [], { pendingQuestion: { title: "Which index?" } as Session["pendingQuestion"] }),
      session("s", "Writer", [
        checklist([
          { text: "Pick a name", done: false, who: "Sam" },
          { text: "Run tests", done: false, who: "Claude" },
          { text: "Old step", done: true },
        ]),
      ] as Partial<Session["blocks"][number]>[]),
      session("x", "Other project", [checklist(["Elsewhere"])] as Partial<Session["blocks"][number]>[], { cwd: "/p/other" }),
    ];
    const items = needsItems(
      "/p/yap",
      sessions,
      [agent("q", { needsApproval: true, activity: "Which index?" })],
      new Map([["q", 200], ["s", 100]]),
      (one) => (one.id === "q" ? "2" : null),
    );
    expect(items.map((item) => [item.kind, item.text, item.chatIdle, item.phaseId])).toEqual([
      ["Your step", "Pick a name", true, null],
      ["Question", "Which index?", false, "2"],
    ]);
    expect(needsItems(null, sessions, [], new Map(), () => null)).toHaveLength(2);
  });
});

describe("phaseIsActive", () => {
  it("shows a card for started phases and ones with a running chat or an ask", () => {
    const [one, two, three] = PLAN.phases;
    expect(phaseIsActive(one, [], [])).toBe(true);
    expect(phaseIsActive(two, [], [])).toBe(false);
    expect(phaseIsActive(three, [], [])).toBe(false);
    const working = { phaseId: "2", state: "working" } as Parameters<typeof phaseIsActive>[1][number];
    expect(phaseIsActive(two, [working], [])).toBe(true);
    const ask = { phaseId: "3" } as Parameters<typeof phaseIsActive>[2][number];
    expect(phaseIsActive(three, [], [ask])).toBe(true);
  });
});

describe("shortAge", () => {
  it("rounds to minutes, hours and days", () => {
    expect(shortAge(0, 30_000)).toBe("now");
    expect(shortAge(0, 5 * 60_000)).toBe("5m");
    expect(shortAge(0, 3 * 3_600_000)).toBe("3h");
    expect(shortAge(0, 50 * 3_600_000)).toBe("2d");
  });
});
