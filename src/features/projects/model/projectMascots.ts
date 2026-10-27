/**
 * 8×8 pixel mascots used in place of a project's color dot.
 * '#' paints the project color, '.' stays transparent so the surface shows
 * through — eyes and gaps are holes, like the arcade sprites they borrow from.
 *
 * Each mascot has two frames: `rest`, and `talk` swapped in on a loop while the
 * project has a turn in flight — mouths chew, legs shuffle, flames flicker.
 */
import {
  PROJECT_BOT_NAMES,
  PROJECT_BOT_SPRITES,
} from "../../../fork/projectBots/projectBots";

const GRID = 8;

type MascotRows = readonly string[];

export type ProjectMascot = {
  name: string;
  rest: MascotRows;
  talk: MascotRows;
  /** SVG path data over an 8×8 viewBox, one per frame. */
  restPath: string;
  talkPath: string;
};

const REST: Record<string, MascotRows> = {
  invader: [
    "..#..#..",
    ".######.",
    "##.##.##",
    "########",
    ".######.",
    ".#.##.#.",
    "#.#..#.#",
    "........",
  ],
  ghost: [
    "..####..",
    ".######.",
    "##.##.##",
    "########",
    "########",
    "########",
    "########",
    "#.##.##.",
  ],
  robot: [
    "...#....",
    ".######.",
    ".#.##.#.",
    ".######.",
    ".#....#.",
    ".######.",
    "..#..#..",
    "........",
  ],
  cat: [
    ".#....#.",
    ".##..##.",
    "########",
    "#.####.#",
    "########",
    "###..###",
    ".######.",
    "..#..#..",
  ],
  skull: [
    ".######.",
    "########",
    "##.##.##",
    "########",
    ".##..##.",
    ".######.",
    ".#.##.#.",
    "........",
  ],
  crab: [
    "#......#",
    ".#....#.",
    ".######.",
    "##.##.##",
    "########",
    "#.####.#",
    "#......#",
    "........",
  ],
  mushroom: [
    "..####..",
    ".######.",
    "########",
    "##.##.##",
    "########",
    "...##...",
    "...##...",
    "..####..",
  ],
  rocket: [
    "...##...",
    "..####..",
    "..#..#..",
    "..####..",
    ".######.",
    ".######.",
    "##....##",
    "..####..",
  ],
  dino: [
    "...#####",
    "...##.##",
    "...#####",
    ".#######",
    "########",
    "#####...",
    ".##.##..",
    "..#..#..",
  ],
  frog: [
    "........",
    "##....##",
    "#.####.#",
    "########",
    "########",
    ".######.",
    "##....##",
    "........",
  ],
};

const TALK: Record<string, MascotRows> = {
  invader: [
    "..#..#..",
    ".######.",
    "##.##.##",
    "########",
    ".######.",
    "#.####.#",
    ".#....#.",
    "#......#",
  ],
  ghost: [
    "..####..",
    ".######.",
    "#.##.###",
    "########",
    "########",
    "########",
    "########",
    ".##.##.#",
  ],
  robot: [
    "....#...",
    ".######.",
    ".#.##.#.",
    ".######.",
    ".##..##.",
    ".######.",
    ".#....#.",
    "........",
  ],
  cat: [
    ".#....#.",
    ".##..##.",
    "########",
    "#.####.#",
    "########",
    "########",
    ".######.",
    ".#....#.",
  ],
  skull: [
    ".######.",
    "########",
    "##.##.##",
    "########",
    ".##..##.",
    ".######.",
    ".#....#.",
    "..####..",
  ],
  crab: [
    "#......#",
    "##....##",
    ".######.",
    "##.##.##",
    "########",
    ".######.",
    "#.#..#.#",
    "........",
  ],
  mushroom: [
    "........",
    "..####..",
    ".######.",
    "########",
    "##.##.##",
    "...##...",
    "...##...",
    "..####..",
  ],
  rocket: [
    "...##...",
    "..####..",
    "..#..#..",
    "..####..",
    ".######.",
    ".######.",
    "##....##",
    "...##...",
  ],
  dino: [
    "...#####",
    "...##.##",
    "...#####",
    ".#######",
    "########",
    "#####...",
    "..##.##.",
    "..#...#.",
  ],
  frog: [
    "##....##",
    "#.####.#",
    "########",
    "########",
    ".######.",
    "##....##",
    "#......#",
    "........",
  ],
};

/** Merges each row's filled runs into one rect so the path stays short. */
export function mascotPath(rows: MascotRows): string {
  let path = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x += 1;
        continue;
      }
      let run = 1;
      while (row[x + run] === "#") run += 1;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return path;
}

// Fork: each project's own bot joins the roster (src/fork/projectBots).
for (const [name, bot] of Object.entries(PROJECT_BOT_SPRITES)) {
  REST[name] = bot.rest;
  TALK[name] = bot.talk;
}

export const PROJECT_MASCOTS: readonly ProjectMascot[] = Object.entries(
  REST,
).map(([name, rest]) => ({
  name,
  rest,
  talk: TALK[name],
  restPath: mascotPath(rest),
  talkPath: mascotPath(TALK[name]),
}));

/** Fork: the hash spreads projects over the stock roster only. */
const HASHED_MASCOTS = PROJECT_MASCOTS.filter(
  (mascot) => !PROJECT_BOT_NAMES.has(mascot.name),
);

export const MASCOT_GRID = GRID;

/** Stable per-project pick — a different mix than the color hash so a project's
 *  mascot and color vary independently. An explicit `name` wins; an unknown one
 *  falls back to the hash. */
export function projectMascot(
  project: string,
  name?: string | null,
): ProjectMascot {
  const chosen = name
    ? PROJECT_MASCOTS.find((mascot) => mascot.name === name)
    : undefined;
  if (chosen) return chosen;

  let hash = 0;
  for (let i = 0; i < project.length; i++) {
    hash = (hash * 131 + project.charCodeAt(i)) >>> 0;
  }
  return HASHED_MASCOTS[hash % HASHED_MASCOTS.length];
}
