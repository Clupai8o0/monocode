import type { GridArcade } from "./gridArcade";
import { createPacmanArcade } from "./pacmanArcade";
import { createSnakeArcade } from "./snakeArcade";
import { createBlocksArcade } from "../../../fork/games/blocksArcade"; // Fork
import { createPlatformerArcade } from "../../../fork/games/platformerArcade"; // Fork
import { createRunnerArcade } from "../../../fork/games/runnerArcade"; // Fork
import { createSandArcade } from "../../../fork/games/sandArcade"; // Fork
import { createStackArcade } from "../../../fork/games/stackArcade"; // Fork
import { createRainArcade } from "../../../fork/games/rainArcade"; // Fork
import { GRID_CATALOG, type GridGameMeta } from "../../../fork/games/catalog"; // Fork

/** How long an idle board stays up before the slider moves on. */
export const SLIDE_HOLD_MS = 16_000;

export type GridGame = GridGameMeta & {
  create: () => GridArcade;
};

const CREATORS: Record<string, () => GridArcade> = {
  pacman: createPacmanArcade,
  snake: createSnakeArcade,
  blocks: createBlocksArcade, // Fork
  runner: createRunnerArcade, // Fork
  platformer: createPlatformerArcade, // Fork
  stack: createStackArcade, // Fork
  sand: createSandArcade, // Fork
  rain: createRainArcade, // Fork
};

/**
 * Games the empty-session slider rotates through. Add another to the catalog
 * and to CREATORS: the track, dots, and take-control path all follow this list.
 */
export const GRID_GAMES: readonly GridGame[] = GRID_CATALOG.map((meta) => ({
  ...meta,
  create: CREATORS[meta.id]!,
}));

/**
 * Next stop on the idle slider. Walks to the end and back so a wrap never
 * has to jump the track the long way around.
 */
export function stepSlider(
  index: number,
  dir: 1 | -1,
  count: number,
): { index: number; dir: 1 | -1 } {
  if (count <= 1) return { index: 0, dir: 1 };
  const next = index + dir;
  if (next >= count) return { index: count - 2, dir: -1 };
  if (next < 0) return { index: 1, dir: 1 };
  return { index: next, dir };
}
