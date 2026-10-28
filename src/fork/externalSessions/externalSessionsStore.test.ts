import { describe, expect, it } from "vitest";
import type { ExternalSession } from "./externalSessionsModel";
import {
  groupByProject,
  isUnsupportedError,
  machineKey,
  ownSessionIds,
  withoutOwnSessions,
} from "./externalSessionsStore";

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
});
