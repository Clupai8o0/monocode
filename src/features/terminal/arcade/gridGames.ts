import type { GridArcade } from "./gridArcade";
import { createPacmanArcade } from "./pacmanArcade";
import { createSnakeArcade } from "./snakeArcade";
import { createBlocksArcade } from "../../../fork/games/blocksArcade"; // Fork
import { createPlatformerArcade } from "../../../fork/games/platformerArcade"; // Fork
import { createRunnerArcade } from "../../../fork/games/runnerArcade"; // Fork
import { createSandArcade } from "../../../fork/games/sandArcade"; // Fork
import { createStackArcade } from "../../../fork/games/stackArcade"; // Fork

/** How long an idle board stays up before the slider moves on. */
export const SLIDE_HOLD_MS = 16_000;

export type GridGame = {
  id: string;
  label: string;
  playLabel: string;
  /**
   * Idle-band brightness vs a full game. Maze games fill the grid, so they
   * run quieter than a sparse one like snake.
   */
  idleDim: number;
  /** Whether the HUD should show lives. */
  lives: boolean;
  /** Fork: the controls, one short line for the games panel. */
  hint?: string;
  /** Fork: Space does something, and retries once the game is over. */
  hasAction?: boolean;
  create: () => GridArcade;
};

/**
 * Games the empty-session slider rotates through. Push another entry to add
 * one — the track, dots, and take-control path all follow this list.
 */
export const GRID_GAMES: readonly GridGame[] = [
  {
    id: "pacman",
    label: "pac-man",
    playLabel: "Pac-man. Arrow keys or WASD to move. Escape to release.",
    idleDim: 0.2,
    lives: true,
    hint: "arrows move",
    create: createPacmanArcade,
  },
  {
    id: "snake",
    label: "snake",
    playLabel: "Snake. Arrow keys or WASD to move. Escape to release.",
    idleDim: 0.65,
    lives: false,
    hint: "arrows steer",
    create: createSnakeArcade,
  },
  // Fork: the games panel plays these while agents work.
  {
    id: "blocks",
    label: "blocks",
    playLabel:
      "Blocks. Left and right move, up rotates, down drops, Space hard drops. Escape to release.",
    idleDim: 0.5,
    lives: false,
    hint: "up rotates · space drops",
    hasAction: true,
    create: createBlocksArcade,
  },
  {
    id: "runner",
    label: "agent run",
    playLabel:
      "Agent run. Space or up to jump, hold to jump higher. Escape to release.",
    idleDim: 0.55,
    lives: false,
    hint: "space jumps · hold for height",
    hasAction: true,
    create: createRunnerArcade,
  },
  {
    id: "platformer",
    label: "mono bros",
    playLabel:
      "Mono bros. Left and right to run, Space or up to jump. Escape to release.",
    idleDim: 0.45,
    lives: true,
    hint: "arrows run · space jumps",
    hasAction: true,
    create: createPlatformerArcade,
  },
  // Fork: calm ones, for when a round of anything else is too much.
  {
    id: "stack",
    label: "stack",
    playLabel:
      "Stack tower. Space or down drops the block; line it up to keep its width. Escape to release.",
    idleDim: 0.5,
    lives: false,
    hint: "space drops · line it up",
    hasAction: true,
    create: createStackArcade,
  },
  {
    id: "sand",
    label: "sand",
    playLabel:
      "Sand drop. Left and right move the spout, Space or down pours, up changes shade. Escape to release.",
    idleDim: 0.5,
    lives: false,
    hint: "arrows steer · space pours · up shade",
    hasAction: true,
    create: createSandArcade,
  },
];

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
