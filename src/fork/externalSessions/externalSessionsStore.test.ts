import { describe, expect, it, vi } from "vitest";
import { listSessionsByProject } from "../../features/sessions/data/sessionStore";
import type { ExternalSession } from "./externalSessionsModel";
import {
  groupByProject,
  isUnsupportedError,
  liveSessions,
  machineKey,
  matchProjects,
  ownSessionIds,
  storedSessionIds,
  unfiledRows,
  withoutOwnSessions,
} from "./externalSessionsStore";

vi.mock("../../features/sessions/data/sessionStore", () => ({
  listSessionsByProject: vi.fn(),
}));

const row = (id: string, projectId: string): ExternalSession => ({
  id,
  projectId,
  source: "claude",
  cwd: "/p",
  state: "running",
  hasTranscript: false,
});

describe("external sessions store", () => {
  it("groups rows by project, keeping order", () => {
    const groups = groupByProject([row("a", "p1"), row("b", "p2"), row("c", "p1")]);
    expect(groups.get("p1")?.map((r) => r.id)).toEqual(["a", "c"]);
    expect(groups.get("p2")?.map((r) => r.id)).toEqual(["b"]);
    expect(groups.get("p3")).toBeUndefined();
  });

  it("drops sessions MonoCode runs itself", () => {
    const own = ownSessionIds([
      { providerSessionId: "mine" },
      {},
      { providerSessionId: undefined },
    ]);
    expect([...own]).toEqual(["mine"]);
    const rows = withoutOwnSessions([row("mine", "p"), row("theirs", "p")], own);
    expect(rows.map((r) => r.id)).toEqual(["theirs"]);
  });

  it("spots a host that lacks the methods", () => {
    expect(isUnsupportedError(new Error("Unsupported remote operation"))).toBe(true);
    expect(isUnsupportedError("Unknown method: externalSessions.list")).toBe(true);
    expect(isUnsupportedError("Method not found")).toBe(true);
    expect(isUnsupportedError(new Error("Session not found"))).toBe(false);
    expect(isUnsupportedError("connection refused")).toBe(false);
    expect(isUnsupportedError(undefined)).toBe(false);
  });

  it("keys one poller per machine", () => {
    expect(machineKey({ kind: "local", projectId: "a", cwd: "/a" })).toBe(
      machineKey({ kind: "local", projectId: "b", cwd: "/b" }),
    );
    expect(machineKey({ kind: "remote", machineId: "m", projectId: "a" })).toBe("remote:m");
  });

  it("passes every known local folder so nested projects match deepest", () => {
    const projects = matchProjects(
      [{ projectId: "/a", cwd: "/a" }],
      ["/a", "/a/b", "~", "", "remote://m/x", "/a/b"],
    );
    expect(projects).toEqual([
      { projectId: "/a", cwd: "/a" },
      { projectId: "/a/b", cwd: "/a/b" },
    ]);
    expect(
      matchProjects([{ projectId: "id-a", cwd: "/a" }], ["/c"], (path) => `id${path}`),
    ).toEqual([
      { projectId: "id-a", cwd: "/a" },
      { projectId: "id/c", cwd: "/c" },
    ]);
  });

  it("reads sessions other windows started from the shared store", async () => {
    vi.mocked(listSessionsByProject).mockImplementation(async (cwd) =>
      cwd === "/a"
        ? ([{ providerSessionId: "w2" }, {}] as never)
        : ([{ providerSessionId: "w3" }] as never),
    );
    const ids = await storedSessionIds(["/a", "/b", "/a"]);
    expect([...ids].sort()).toEqual(["w2", "w3"]);
    expect(listSessionsByProject).toHaveBeenCalledTimes(2);
  });
});

describe("liveSessions", () => {
  const row = (name: string, state: ExternalSession["state"]): ExternalSession => ({
    id: name,
    name,
    projectId: "p",
    source: "claude",
    cwd: "/x",
    state,
    hasTranscript: true,
  });

  it("drops handed-over sessions and puts the working ones first", () => {
    expect(
      liveSessions([
        row("b-idle", "idle"),
        row("gone", "handed-over"),
        row("c-run", "running"),
        row("a-idle", "idle"),
      ]).map((session) => session.name),
    ).toEqual(["c-run", "a-idle", "b-idle"]);
  });
});

describe("unfiledRows", () => {
  it("gives sessions in no project an empty project id, and copes with old hosts", () => {
    expect(unfiledRows(undefined)).toEqual([]);
    expect(
      unfiledRows([{ id: "s", source: "claude", cwd: "/home/me", state: "idle", hasTranscript: true }]),
    ).toEqual([{ id: "s", projectId: "", source: "claude", cwd: "/home/me", state: "idle", hasTranscript: true }]);
  });
});
