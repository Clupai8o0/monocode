import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import {
  ProjectAgentBadge,
  ProjectAgentStatusProvider,
  projectAgentStatus,
} from "./ProjectAgentStatus";

function agent(cwd: string, state: "working" | "waiting" | "done"): LiveAgent {
  return {
    id: `${cwd}:${state}:${Math.random()}`,
    cwd,
    title: "chat",
    harness: "claude",
    activity: state,
    needsApproval: state === "waiting",
    done: state === "done",
  };
}

function badge(agents: LiveAgent[], path: string): string {
  return renderToStaticMarkup(
    createElement(
      ProjectAgentStatusProvider,
      { agents },
      createElement(ProjectAgentBadge, { path }),
    ),
  );
}

describe("projectAgentStatus", () => {
  it("counts only this project's agents, by state", () => {
    const agents = [
      agent("/p/a", "working"),
      agent("/p/a", "done"),
      agent("/p/a", "waiting"),
      agent("/p/b", "done"),
    ];
    expect(projectAgentStatus(agents, "/p/a")).toEqual({
      working: 1,
      waiting: 1,
      done: 1,
    });
    expect(projectAgentStatus(agents, "/p/c")).toEqual({
      working: 0,
      waiting: 0,
      done: 0,
    });
  });
});

describe("ProjectAgentBadge", () => {
  it("shows nothing for a quiet project or one still working", () => {
    expect(badge([], "/p/a")).toBe("");
    expect(badge([agent("/p/a", "working"), agent("/p/a", "done")], "/p/a")).toBe("");
  });

  it("shows done once every agent in the project has finished", () => {
    expect(badge([agent("/p/a", "done")], "/p/a")).toContain('aria-label="Agent done"');
    expect(
      badge([agent("/p/a", "done"), agent("/p/a", "done")], "/p/a"),
    ).toContain('aria-label="2 agents done"');
  });

  it("puts an agent waiting on you ahead of everything else", () => {
    const html = badge(
      [agent("/p/a", "working"), agent("/p/a", "waiting"), agent("/p/a", "done")],
      "/p/a",
    );
    expect(html).toContain('data-fork-agent-status="waiting"');
    expect(html).toContain('aria-label="Agent needs you"');
  });
});
