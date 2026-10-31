/**
 * Fork: a bot of its own for each of the owner's projects. The sprites join
 * the mascot roster (so every project menu can pick them), and each project
 * gets its own once; a later pick from the project menu wins.
 *
 * Same format as `projectMascots.ts`: 8×8 rows, '#' filled, '.' a hole, two
 * frames. `eyes` are holes in each frame, as `pixelMascots.ts` expects.
 */
type Rows = readonly string[];
type Cell = [x: number, y: number];

type Bot = {
  rest: Rows;
  talk: Rows;
  eyes: { rest: readonly Cell[]; talk: readonly Cell[] };
};

const same = (eyes: readonly Cell[]) => ({ rest: eyes, talk: eyes });

export const PROJECT_BOT_SPRITES: Record<string, Bot> = {
  // morgue: a tombstone that keeps what it is given.
  tomb: {
    rest: [
      "..####..",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".##..##.",
      ".######.",
      ".######.",
      "########",
    ],
    talk: [
      "..####..",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".#....#.",
      ".##..##.",
      ".######.",
      "########",
    ],
    eyes: same([
      [2, 2],
      [5, 2],
    ]),
  },
  // jobbird: the bird that goes job hunting.
  bird: {
    rest: [
      "...###..",
      "..####..",
      "..#.####",
      "######..",
      ".#####..",
      "..####..",
      "...#.#..",
      "........",
    ],
    talk: [
      "#..###..",
      "##.####.",
      ".##.####",
      "..#####.",
      ".#####..",
      "..####..",
      "..#..#..",
      "........",
    ],
    eyes: same([[3, 2]]),
  },
  // kairos: an hourglass for the planner.
  hourglass: {
    rest: [
      "########",
      ".######.",
      ".#.##.#.",
      "..####..",
      "...##...",
      "..#..#..",
      ".#.##.#.",
      "########",
    ],
    talk: [
      "########",
      ".######.",
      ".#.##.#.",
      "..#..#..",
      "...##...",
      "..#..#..",
      ".######.",
      "########",
    ],
    eyes: same([
      [2, 2],
      [5, 2],
    ]),
  },
  // samridhlimbu: the personal site gets a face with spiky hair.
  spiky: {
    rest: [
      "#.#.#.#.",
      "########",
      "########",
      "##.##.##",
      "########",
      "##....##",
      ".######.",
      "..####..",
    ],
    talk: [
      ".#.#.#.#",
      "########",
      "########",
      "##.##.##",
      "###..###",
      "##....##",
      ".##..##.",
      "..####..",
    ],
    eyes: same([
      [2, 3],
      [5, 3],
    ]),
  },
  // clupai-monorepo: a chip for the AI products.
  chip: {
    rest: [
      "..#..#..",
      ".######.",
      "##.##.##",
      ".######.",
      "###..###",
      ".######.",
      ".######.",
      "..#..#..",
    ],
    talk: [
      ".#....#.",
      ".######.",
      "##.##.##",
      ".######.",
      "##....##",
      ".######.",
      ".######.",
      ".#....#.",
    ],
    eyes: same([
      [2, 2],
      [5, 2],
    ]),
  },
  // hoddle: an owl for the mentors.
  owl: {
    rest: [
      "#......#",
      "##....##",
      "########",
      "##.##.##",
      "########",
      "#.#..#.#",
      ".######.",
      "..#..#..",
    ],
    talk: [
      "#......#",
      "##....##",
      "########",
      "##.##.##",
      "###..###",
      "########",
      "#.####.#",
      "..#..#..",
    ],
    eyes: same([
      [2, 3],
      [5, 3],
    ]),
  },
  // panoptic: one eye that sees everything; it glances aside while busy.
  eye: {
    rest: [
      "........",
      "..####..",
      ".######.",
      "###..###",
      "###..###",
      ".######.",
      "..####..",
      "........",
    ],
    talk: [
      "........",
      "..####..",
      ".######.",
      "##..####",
      "##..####",
      ".######.",
      "..####..",
      "........",
    ],
    eyes: {
      rest: [
        [3, 3],
        [4, 3],
        [3, 4],
        [4, 4],
      ],
      talk: [
        [2, 3],
        [3, 3],
        [2, 4],
        [3, 4],
      ],
    },
  },
  // monocode: one big eye, like the name.
  cyclops: {
    rest: [
      "...#....",
      "..####..",
      ".######.",
      ".##..##.",
      ".######.",
      ".######.",
      ".######.",
      ".#....#.",
    ],
    talk: [
      "....#...",
      "..####..",
      ".######.",
      ".##..##.",
      ".######.",
      ".##..##.",
      ".######.",
      "#......#",
    ],
    eyes: same([
      [3, 3],
      [4, 3],
    ]),
  },
  // ripple: a drop that splashes while it works.
  drop: {
    rest: [
      "...#....",
      "...##...",
      "..####..",
      ".######.",
      ".#.##.#.",
      "########",
      ".######.",
      "..####..",
    ],
    talk: [
      "........",
      "...##...",
      "..####..",
      ".######.",
      ".#.##.#.",
      "########",
      "#.####.#",
      ".#....#.",
    ],
    eyes: same([
      [2, 4],
      [5, 4],
    ]),
  },
  // The Stylist Mono (src/fork/stylist): a face under a tilted beret.
  beret: {
    rest: [
      "....#...",
      ".#####..",
      "#######.",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".##..##.",
      "..####..",
    ],
    talk: [
      "...#....",
      "..#####.",
      ".#######",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".#....#.",
      "..####..",
    ],
    eyes: same([
      [2, 4],
      [5, 4],
    ]),
  },
  // The Mono Maker (src/fork/starterMonos): a face on an anvil.
  anvil: {
    rest: [
      "########",
      ".######.",
      ".#.##.#.",
      ".######.",
      "..####..",
      "..####..",
      ".######.",
      "########",
    ],
    talk: [
      "########",
      ".######.",
      ".#.##.#.",
      ".######.",
      "..#..#..",
      "..####..",
      ".######.",
      "########",
    ],
    eyes: same([
      [2, 2],
      [5, 2],
    ]),
  },
  // Dojo (src/fork/starterMonos): a face wearing a headband.
  belt: {
    rest: [
      "########",
      "########",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".##..##.",
      ".######.",
      "..####..",
    ],
    talk: [
      "########",
      "########",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".#....#.",
      ".##..##.",
      "..####..",
    ],
    eyes: same([
      [2, 3],
      [5, 3],
    ]),
  },
  // Sweep (src/fork/starterMonos): a face on a broom head.
  broom: {
    rest: [
      "...##...",
      "...##...",
      ".######.",
      ".#.##.#.",
      ".######.",
      "########",
      "#.#..#.#",
      "#.#..#.#",
    ],
    talk: [
      "...##...",
      "...##...",
      ".######.",
      ".#.##.#.",
      ".##..##.",
      "########",
      "#.#..#.#",
      "#.#..#.#",
    ],
    eyes: same([
      [2, 3],
      [5, 3],
    ]),
  },
};

export const PROJECT_BOT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(PROJECT_BOT_SPRITES),
);

/** Project folder (the end of its path) → its bot. */
const BOT_FOR_PROJECT: Readonly<Record<string, string>> = {
  "projects/morgue": "tomb",
  "projects/jobbird": "bird",
  "projects/kairos": "hourglass",
  "projects/samridhlimbu": "spiky",
  "projects/clupai-monorepo": "chip",
  "projects/hoddle": "owl",
  "upwork/panoptic": "eye",
  "projects/monocode": "cyclops",
  "projects/ripple": "drop",
};

export function projectBotFor(path: string): string | null {
  const clean = path.replace(/\/+$/, "");
  for (const [suffix, bot] of Object.entries(BOT_FOR_PROJECT)) {
    if (clean === suffix || clean.endsWith(`/${suffix}`)) return bot;
  }
  return null;
}
