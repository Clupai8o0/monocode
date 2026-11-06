// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_MASCOTS, projectMascot } from "../../features/projects/model/projectMascots";
import { loadTabGroupMascots, saveTabGroupMascot } from "../../features/workspace/model/tabGroups";
import { applyProjectBots } from "./applyProjectBots";
import { PROJECT_BOT_NAMES, PROJECT_BOT_SPRITES, projectBotFor } from "./projectBots";

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

  it("offers the flower as a pick in the roster, as an 8×8 two-frame sprite", () => {
    const flower = PROJECT_MASCOTS.find((mascot) => mascot.name === "flower");
    expect(flower).toBeDefined();
    for (const rows of [flower!.rest, flower!.talk]) {
      expect(rows).toHaveLength(8);
      for (const row of rows) expect(row).toMatch(/^[#.]{8}$/);
    }
    expect(flower!.talk).not.toEqual(flower!.rest);
    const { eyes } = PROJECT_BOT_SPRITES.flower;
    for (const [x, y] of eyes.rest) expect(flower!.rest[y][x]).toBe(".");
    for (const [x, y] of eyes.talk) expect(flower!.talk[y][x]).toBe(".");
    // The stem runs straight down the bloom's middle column, with one leaf.
    for (const rows of [flower!.rest, flower!.talk]) {
      expect(rows.slice(5)).toEqual(["...#....", "..##....", "...#...."]);
    }
    // Talking opens a mouth under the eyes and changes nothing else.
    expect(flower!.rest[3][3]).toBe("#");
    expect(flower!.talk[3][3]).toBe(".");
    expect(flower!.talk.filter((row, y) => row !== flower!.rest[y])).toHaveLength(1);
    expect(projectBotFor("/Users/sam/Documents/projects/yap")).toBeNull();
  });

  it("offers the pig as a pick in the roster, with its one eye on a hole", () => {
    const pig = PROJECT_MASCOTS.find((mascot) => mascot.name === "pig");
    expect(pig).toBeDefined();
    for (const rows of [pig!.rest, pig!.talk]) {
      expect(rows).toHaveLength(8);
      for (const row of rows) expect(row).toMatch(/^[#.]{8}$/);
    }
    const { eyes } = PROJECT_BOT_SPRITES.pig;
    expect(eyes.rest).toEqual([[5, 3]]);
    expect(eyes.talk).toEqual([[5, 3]]);
    expect(pig!.rest[3][5]).toBe(".");
    expect(pig!.talk[3][5]).toBe(".");
    // Talking only opens the snout: its bottom pixel goes and nothing else moves.
    expect(pig!.rest[4]).toBe(".#######");
    expect(pig!.talk[4]).toBe(".######.");
    expect(pig!.talk.filter((row, y) => y !== 4)).toEqual(pig!.rest.filter((row, y) => y !== 4));
    expect(projectBotFor("/Users/sam/Documents/projects/coin-jar")).toBeNull();
  });

  it("offers the couple as a pick in the roster, with no eyes", () => {
    const couple = PROJECT_MASCOTS.find((mascot) => mascot.name === "couple");
    expect(couple).toBeDefined();
    for (const rows of [couple!.rest, couple!.talk]) {
      expect(rows).toHaveLength(8);
      for (const row of rows) expect(row).toMatch(/^[#.]{8}$/);
      // Two 2x2 heads and the joined hands.
      expect(rows.slice(0, 2)).toEqual([".##..##.", ".##..##."]);
      expect(rows[3]).toBe("########");
    }
    expect(PROJECT_BOT_SPRITES.couple.eyes).toEqual({ rest: [], talk: [] });
    // Talking only kicks the legs out: row 7 changes and nothing else moves.
    expect(couple!.rest[7]).toBe(".#....#.");
    expect(couple!.talk[7]).toBe("#......#");
    expect(couple!.talk.filter((row, y) => y !== 7)).toEqual(couple!.rest.filter((row, y) => y !== 7));
    expect(projectBotFor("/Users/sam/Documents/projects/glow-up")).toBeNull();
  });

  it("no longer offers the jar", () => {
    expect(PROJECT_MASCOTS.map((mascot) => mascot.name)).not.toContain("jar");
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
