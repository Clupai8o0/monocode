/**
 * Fork: what the games panel knows about every game before any game's code has
 * loaded. Plain data with no imports, so the footer and the panel's chrome can
 * read it without pulling a game in.
 */

export type GameGroupId = "dev" | "arcade" | "tables" | "puzzles";

/** The order the picker lists them. */
export const GAME_GROUPS: readonly { id: GameGroupId; label: string }[] = [
  { id: "arcade", label: "Arcade" },
  { id: "dev", label: "Dev" },
  { id: "tables", label: "Cards and boards" },
  { id: "puzzles", label: "Puzzles" },
];

export type GridGameMeta = {
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
  /** The controls, one short line for the games panel. */
  hint?: string;
  /** Space does something, and retries once the game is over. */
  hasAction?: boolean;
  group: GameGroupId;
};

/** The canvas games, in the order the empty-session slider shows them. */
export const GRID_CATALOG: readonly GridGameMeta[] = [
  {
    id: "pacman",
    label: "pac-man",
    playLabel: "Pac-man. Arrow keys or WASD to move. Escape to release.",
    idleDim: 0.2,
    lives: true,
    hint: "arrows move",
    group: "arcade",
  },
  {
    id: "snake",
    label: "snake",
    playLabel: "Snake. Arrow keys or WASD to move. Escape to release.",
    idleDim: 0.65,
    lives: false,
    hint: "arrows steer",
    group: "arcade",
  },
  {
    id: "blocks",
    label: "blocks",
    playLabel:
      "Blocks. Left and right move, up rotates, down drops, Space hard drops. Escape to release.",
    idleDim: 0.5,
    lives: false,
    hint: "up rotates · space drops",
    hasAction: true,
    group: "arcade",
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
    group: "arcade",
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
    group: "arcade",
  },
  {
    id: "stack",
    label: "stack",
    playLabel:
      "Stack tower. Space or down drops the block; line it up to keep its width. Escape to release.",
    idleDim: 0.5,
    lives: false,
    hint: "space drops · line it up",
    hasAction: true,
    group: "arcade",
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
    group: "arcade",
  },
  {
    id: "rain",
    label: "token rain",
    playLabel:
      "Token rain. Left and right move the bucket, Space compacts the context window before it overflows. Escape to release.",
    idleDim: 0.55,
    lives: true,
    hint: "arrows move · space compacts",
    hasAction: true,
    group: "arcade",
  },
];

export type TableGameMeta = {
  id: string;
  label: string;
  hint: string;
  group: GameGroupId;
  /** False when the panel's difficulty chip would do nothing here. */
  usesMode: boolean;
};

/** The tables stay out of vitest, like the panel itself. */
const TABLES_ON = import.meta.env.MODE !== "test";

export const TABLE_GAMES: readonly TableGameMeta[] = TABLES_ON
  ? [
      { id: "poker", label: "poker", hint: "F fold · C call · R raise · A all in", group: "tables", usesMode: true },
      { id: "blackjack", label: "blackjack", hint: "H hit · S stand · D double · P split", group: "tables", usesMode: true },
      { id: "chess", label: "chess", hint: "click or drag to move", group: "tables", usesMode: true },
      // The Code tab's drills, run by fork_code_run. Its own Level chip picks how hard.
      { id: "code", label: "code", hint: "write code · Cmd+Enter to run", group: "dev", usesMode: false },
      { id: "garden", label: "garden", hint: "click a bed to plant, water or pick · agents bring the sun", group: "puzzles", usesMode: false },
      { id: "solitaire", label: "solitaire", hint: "click to move · drag · space draws · U undo · N new", group: "tables", usesMode: true },
      { id: "sort", label: "colour sort", hint: "click a tube, then another to pour · U undo · R restart · N next", group: "puzzles", usesMode: true },
      { id: "sudoku", label: "sudoku", hint: "click a cell or use the arrows · 1-9 fills · N notes · U undo", group: "puzzles", usesMode: true },
      { id: "pipeline", label: "pipeline", hint: "click a tile to turn it · U undo · R restart · N next", group: "puzzles", usesMode: true },
      { id: "merge", label: "merge conflict", hint: "type the resolution · backspace fixes", group: "dev", usesMode: true },
      { id: "race", label: "type race", hint: "type the words · space moves on · backspace fixes", group: "dev", usesMode: true },
      { id: "turnbet", label: "turn bet", hint: "guess how long the agent takes · - + B bets", group: "dev", usesMode: true },
    ]
  : [];

export type GameEntry = {
  id: string;
  label: string;
  hint?: string;
  group: GameGroupId;
  kind: "grid" | "table";
  usesMode: boolean;
};

export const ALL_GAMES: readonly GameEntry[] = [
  ...GRID_CATALOG.map(({ id, label, hint, group }) => ({
    id,
    label,
    hint,
    group,
    kind: "grid" as const,
    usesMode: true,
  })),
  ...TABLE_GAMES.map(({ id, label, hint, group, usesMode }) => ({
    id,
    label,
    hint,
    group,
    kind: "table" as const,
    usesMode,
  })),
];

export function gameEntry(id: string): GameEntry | undefined {
  return ALL_GAMES.find((game) => game.id === id);
}

export function isTableGame(id: string) {
  return gameEntry(id)?.kind === "table";
}
