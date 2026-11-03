import { describe, expect, it } from "vitest";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import { projectRows } from "./projectsModel";

function agent(
  cwd: string,
  startedAt: number,
  extra: Partial<LiveAgent> = {},
): LiveAgent {
  return {
    id: cwd,
    cwd,
    title: cwd,
    harness: "codex",
    activity: "Working",
    startedAt,
    done: false,
    needsApproval: false,
    ...extra,
  };
}
const paths = ["/idle", "/old", "/new", "/waiting", "/done"];
const agents = [
  agent("/old", 100),
  agent("/new", 300),
  agent("/waiting", 500, { needsApproval: true }),
  agent("/done", 600, { done: true }),
];
describe("project run order", () => {
  it("raises genuinely running projects by latest run start and keeps other order", () => {
    expect(projectRows(paths, agents).map((row) => row.path)).toEqual([
      "/new",
      "/old",
      "/idle",
      "/waiting",
      "/done",
    ]);
  });
  it("uses the newest working run per project, excluding newer waiting/finished runs", () => {
    expect(
      projectRows(paths, [
        ...agents,
        agent("/old", 400, { id: "second" }),
        agent("/new", 900, { id: "finished", done: true }),
      ])[0].path,
    ).toBe("/old");
  });
  it("does not reorder from streaming activity, duration or other token updates", () => {
    expect(
      projectRows(
        paths,
        agents.map((a) => ({
          ...a,
          activity: "More streamed output",
          durationMs: 999999,
        })),
      ).map((row) => row.path),
    ).toEqual(projectRows(paths, agents).map((row) => row.path));
  });
  it("keeps input order for ties, unknown starts and idle projects", () => {
    expect(
      projectRows(paths, [agent("/old", 100), agent("/new", 100)]).map(
        (row) => row.path,
      ),
    ).toEqual(["/old", "/new", "/idle", "/waiting", "/done"]);
    expect(
      projectRows(paths, [], ["/new", "/old"]).map((row) => row.path),
    ).toEqual(["/old", "/new", "/idle", "/waiting", "/done"]);
  });
  it("does not turn a waiting project's busy-path flag into a running project", () => {
    const rows = projectRows(paths, agents, ["/waiting"]);
    expect(rows.find((row) => row.path === "/waiting")).toMatchObject({
      running: false,
      waiting: 1,
    });
  });
});

describe("recently used order", () => {
  const order = (
    agents: readonly LiveAgent[],
    options: Parameters<typeof projectRows>[3],
  ) =>
    projectRows(paths, agents, [], options).map((row) => row.path);
  const recents = [
    { path: "/idle", openedAt: 100 },
    { path: "/old", openedAt: 500 },
    { path: "/waiting", openedAt: 300 },
  ];

  it("sorts idle projects by when they were last opened", () => {
    expect(order([], { recents })).toEqual([
      "/old",
      "/waiting",
      "/idle",
      "/new",
      "/done",
    ]);
  });
  it("counts a run in a project that was opened long ago", () => {
    expect(order([], { recents, use: { "/idle": 900 } })[0]).toBe("/idle");
    expect(order([], { recents, use: { "/old": 200 } })[0]).toBe("/old");
  });
  it("puts the open project first, even above running ones", () => {
    expect(order(agents, { recents, current: "/idle" }).slice(0, 3)).toEqual([
      "/idle",
      "/new",
      "/old",
    ]);
  });
  it("puts running projects above recently used idle ones", () => {
    expect(
      order([agent("/new", 1)], { recents, use: { "/idle": 900 } })[0],
    ).toBe("/new");
  });
});
