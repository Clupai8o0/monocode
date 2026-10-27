// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_MASCOTS, projectMascot } from "../../features/projects/model/projectMascots";
import { loadTabGroupMascots, saveTabGroupMascot } from "../../features/workspace/model/tabGroups";
import { applyProjectBots } from "./applyProjectBots";
import { PROJECT_BOT_NAMES, projectBotFor } from "./projectBots";

const MORGUE = "/Users/sam/Documents/projects/morgue";
const PANOPTIC = "/Users/sam/Documents/projects/upwork/panoptic";

beforeEach(() => {
  localStorage.clear();
});

describe("project bots", () => {
  it("gives every listed project a different bot from the roster", () => {
    const names = PROJECT_MASCOTS.map((mascot) => mascot.name);
    for (const bot of PROJECT_BOT_NAMES) expect(names).toContain(bot);
    expect(projectBotFor(MORGUE)).toBe("tomb");
    expect(projectBotFor(`${PANOPTIC}/`)).toBe("eye");
    expect(projectBotFor("/Users/sam/Documents/projects/panoptic")).toBeNull();
    expect(projectBotFor("/Users/sam/notmorgue")).toBeNull();
  });

  it("keeps bots out of the hashed default", () => {
    for (const project of ["alpha", "beta", "gamma", "delta", "x/y", "zz"]) {
      expect(PROJECT_BOT_NAMES.has(projectMascot(project).name)).toBe(false);
    }
  });

  it("applies each bot once, replacing a stock pick, then keeps later picks", () => {
    saveTabGroupMascot(MORGUE, "ghost");
    expect(applyProjectBots([MORGUE, PANOPTIC, "/tmp/other"])).toEqual([
      MORGUE,
      PANOPTIC,
    ]);
    expect(loadTabGroupMascots()[MORGUE]).toBe("tomb");
    expect(loadTabGroupMascots()[PANOPTIC]).toBe("eye");
    expect(loadTabGroupMascots()["/tmp/other"]).toBeUndefined();

    saveTabGroupMascot(MORGUE, "ghost");
    expect(applyProjectBots([MORGUE, PANOPTIC])).toEqual([]);
    expect(loadTabGroupMascots()[MORGUE]).toBe("ghost");
  });
});
