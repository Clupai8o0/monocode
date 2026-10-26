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
