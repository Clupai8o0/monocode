import { describe, expect, it } from "vitest";
import { shortStatus } from "./messagesFilter";
import type { FeedRow, Party } from "./messageLogView";
import { partyProject, projectsByName } from "./partyProject";

function party(overrides: Partial<Party> = {}): Party {
  return {
    key: "name:test",
    label: "test",
    live: true,
    ...overrides,
  };
}

function feedRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    id: "r1",
    at: 0,
    from: party(),
    to: party({ key: "name:other", label: "other" }),
    route: "local",
    status: "waiting",
    statusText: "",
    trail: [],
    preview: "",
    problem: false,
    crossMachine: false,
    ...overrides,
  };
}

describe("projectsByName", () => {
  it("keeps the first listed path when the folder name repeats", () => {
    const byName = projectsByName(["/first/panoptic", "/second/panoptic"]);
    expect(byName.get("panoptic")).toBe("/first/panoptic");
  });

  it("skips empty paths and tilde", () => {
    const byName = projectsByName(["", "~", "/real/foo"]);
    expect(byName.size).toBe(1);
    expect(byName.get("foo")).toBe("/real/foo");
  });
});

describe("partyProject", () => {
  const known = [
    "/Users/me/a",
    "/Users/me/a/b",
    "/y/monocode",
    "/Users/me/panoptic",
    "/Users/me/spaceapps",
    "/Users/me/spaceapps-melbourne-2026",
  ];

  it("returns the known project when cwd is inside it", () => {
    expect(partyProject(party({ cwd: "/Users/me/a/b/c" }), known)).toBe("/Users/me/a/b");
  });

  it("prefers the deepest matching known root when nested", () => {
    expect(partyProject(party({ cwd: "/Users/me/a/b/c/d" }), known)).toBe("/Users/me/a/b");
    expect(partyProject(party({ cwd: "/Users/me/a/x" }), known)).toBe("/Users/me/a");
  });

  it("maps a monocode-worktrees checkout to the known monocode project", () => {
    expect(partyProject(party({ cwd: "/x/monocode-worktrees/mc-foo" }), known)).toBe("/y/monocode");
  });

  it("maps cwd on another machine by folder name", () => {
    expect(partyProject(party({ cwd: "/home/sam/panoptic" }), known)).toBe("/Users/me/panoptic");
  });

  it("maps party.project to a known path", () => {
    expect(partyProject(party({ project: "panoptic" }), known)).toBe("/Users/me/panoptic");
  });

  it("maps label with branch suffix to the longest matching project name", () => {
    expect(partyProject(party({ label: "spaceapps-melbourne-2026-ba" }), known)).toBe(
      "/Users/me/spaceapps-melbourne-2026",
    );
  });

  it("maps panoptic-ee label to panoptic", () => {
    expect(partyProject(party({ label: "panoptic-ee" }), known)).toBe("/Users/me/panoptic");
  });

  it("does not match label when the key starts with unknown:", () => {
    expect(
      partyProject(party({ key: "unknown:?", label: "panoptic-ee" }), known),
    ).toBeNull();
  });

  it("returns the cwd when it is not a known project", () => {
    expect(partyProject(party({ cwd: "/tmp/nowhere" }), known)).toBe("/tmp/nowhere");
  });

  it("returns null when there is nothing to resolve", () => {
    expect(partyProject(party({ label: "orphan" }), known)).toBeNull();
  });

  it("does not treat panopticx as panoptic", () => {
    expect(partyProject(party({ label: "panopticx" }), known)).toBeNull();
  });
});

describe("shortStatus", () => {
  it("shortens unreachable-agent failures", () => {
    expect(
      shortStatus(
        feedRow({
          status: "failed",
          statusText: "No agent named 'x' is reachable. Did you mean y?",
        }),
      ),
    ).toBe("No session by that name");
  });

  it("keeps the clause before the colon for dropped rows", () => {
    expect(
      shortStatus(
        feedRow({
          status: "dropped",
          statusText: "Lost by the relay on Vivobook: not picked up",
        }),
      ),
    ).toBe("Lost by the relay on Vivobook");
  });

  it("labels held and expired rows", () => {
    expect(shortStatus(feedRow({ status: "held", statusText: "Held" }))).toBe("Needs approval");
    expect(shortStatus(feedRow({ status: "expired", statusText: "Expired" }))).toBe("Not approved in time");
  });

  it("shortens common waiting status lines", () => {
    expect(
      shortStatus(
        feedRow({
          status: "waiting",
          statusText: "Sent 08:40; not seen by foo yet",
        }),
      ),
    ).toBe("Not seen yet");
    expect(
      shortStatus(
        feedRow({
          status: "waiting",
          statusText: "Sent 08:40; foo will see it after this turn",
        }),
      ),
    ).toBe("Sees it after this turn");
    expect(
      shortStatus(
        feedRow({
          status: "waiting",
          statusText: "Sent 08:40; can't see Vivobook to check",
        }),
      ),
    ).toBe("Can't check Vivobook");
  });

  it("truncates long unknown failure text to 60 characters", () => {
    const long = "A".repeat(80);
    const result = shortStatus(feedRow({ status: "failed", statusText: long }));
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("…")).toBe(true);
  });
});
describe("shortStatus on settled failures", () => {
  it("says the session ended only when the failure says so", () => {
    const row = (statusText: string): FeedRow => ({
      id: "r",
      at: 0,
      from: { key: "name:a", label: "a", live: true },
      to: { key: "name:b", label: "b", live: true },
      route: "local",
      status: "failed",
      statusText,
      trail: [],
      preview: "",
      problem: false,
      settled: true,
      crossMachine: false,
    });
    expect(shortStatus(row("Not sent: that session has ended"))).toBe("That session has ended");
    // Dismissed or resent failures are settled too, while the target may still run.
    expect(shortStatus(row("No agent named 'b' is reachable."))).toBe("No session by that name");
  });
});
