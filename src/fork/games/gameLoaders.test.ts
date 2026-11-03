import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ table: vi.fn(), arcade: vi.fn() }));
vi.mock("./table/PokerTable", () => {
  loaded.table();
  return { PokerTable: () => null };
});
vi.mock("../../features/terminal/arcade/gridGames", () => ({
  loadGridGame: loaded.arcade.mockResolvedValue(undefined),
}));
import { preloadGame, tableLoaders } from "./gameLoaders";

it("does not import a table until requested and reuses its pending import", async () => {
  expect(loaded.table).not.toHaveBeenCalled();
  preloadGame("poker");
  const first = tableLoaders.poker();
  expect(tableLoaders.poker()).toBe(first);
  await first;
  expect(loaded.table).toHaveBeenCalledTimes(1);
});

it("accepts unknown and inherited object ids without throwing", () => {
  expect(() => {
    preloadGame("missing");
    preloadGame("constructor");
    preloadGame("__proto__");
  }).not.toThrow();
});
