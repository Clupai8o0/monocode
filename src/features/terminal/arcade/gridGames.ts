import type { GridArcade } from "./gridArcade";
import { GRID_CATALOG, type GridGameMeta } from "../../../fork/games/catalog"; // Fork

/** How long an idle board stays up before the slider moves on. */
export const SLIDE_HOLD_MS = 16_000;

// Fork: metadata stays synchronous; each game's factory has its own chunk.
type ArcadeFactory = () => GridArcade;
const LOADERS: Record<string, () => Promise<ArcadeFactory>> = {
  pacman: () => import("./pacmanArcade").then((m) => m.createPacmanArcade),
  snake: () => import("./snakeArcade").then((m) => m.createSnakeArcade),
  blocks: () => import("../../../fork/games/blocksArcade").then((m) => m.createBlocksArcade),
  runner: () => import("../../../fork/games/runnerArcade").then((m) => m.createRunnerArcade),
  platformer: () => import("../../../fork/games/platformerArcade").then((m) => m.createPlatformerArcade),
  stack: () => import("../../../fork/games/stackArcade").then((m) => m.createStackArcade),
  sand: () => import("../../../fork/games/sandArcade").then((m) => m.createSandArcade),
  rain: () => import("../../../fork/games/rainArcade").then((m) => m.createRainArcade),
};
const pending = new Map<string, Promise<ArcadeFactory>>();

export function loadGridGame(id: string): Promise<ArcadeFactory | undefined>
{
  if (!Object.prototype.hasOwnProperty.call(LOADERS, id)) {
    return Promise.resolve(undefined);
  }
  let load = pending.get(id);
  if (!load) {
    load = LOADERS[id]!().catch((error) => {
      pending.delete(id);
      throw error;
    });
    pending.set(id, load);
  }
  return load;
}

export type GridGame = GridGameMeta & {
  load: () => Promise<ArcadeFactory | undefined>;
};

/**
 * Games the empty-session slider rotates through. Add another to the catalog
 * and to LOADERS: the track, dots, and take-control path all follow this list.
 */
export const GRID_GAMES: readonly GridGame[] = GRID_CATALOG.map((meta) => ({
  ...meta,
  load: () => loadGridGame(meta.id), // Fork
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
