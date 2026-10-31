// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SUN,
  BEDS,
  BLOOM_ROWS,
  GARDEN_EVENT,
  MAX_CATCH_UP,
  PLANT_ROWS,
  SEEDS,
  STAGE_COST,
  TICK_MS,
  activityLine,
  applyActivity,
  bloomed,
  buy,
  createGarden,
  harvest,
  loadGarden,
  noteAgentActivity,
  parseGarden,
  plant,
  saveGarden,
  shine,
  tend,
  tick,
  updateGarden,
  water,
} from "./garden";

const T0 = 1_000_000;

describe("garden", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
  });

  it("starts empty with daisies", () => {
    const state = createGarden(T0);
    expect(state.beds).toHaveLength(BEDS);
    expect(state.beds.every((bed) => bed === null)).toBe(true);
    expect(state.owned).toEqual(["daisy"]);
  });

  it("plants only owned seeds in empty beds", () => {
    let state = plant(createGarden(T0), 0);
    expect(state.beds[0]?.kind).toBe("daisy");
    expect(plant(state, 0)).toBe(state);
    expect(plant(state, 1, "tulip")).toBe(state);
  });

  it("one agent sunshine advances a stage; watered doubles once", () => {
    let state = plant(plant(createGarden(T0), 0), 1);
    state = water(state, 1);
    state = shine(state, AGENT_SUN);
    expect(state.beds[0]?.stage).toBe(1);
    expect(state.beds[1]?.stage).toBe(2);
    expect(state.beds[1]?.watered).toBe(false);
    expect(AGENT_SUN).toBe(STAGE_COST);
  });

  it("blooms, harvests for petals, and never wilts", () => {
    let state = plant(createGarden(T0), 0);
    state = shine(state, 100);
    expect(bloomed(state.beds[0]!)).toBe(true);
    expect(shine(state, 50).beds[0]).toEqual(state.beds[0]);
    expect(water(state, 0)).toBe(state);
    state = harvest(state, 0);
    expect(state.beds[0]).toBeNull();
    expect(state.petals).toBe(SEEDS[0]!.petals);
    expect(state.blooms).toBe(1);
  });

  it("tend plants, waters, then harvests", () => {
    let state = tend(createGarden(T0), 2);
    expect(state.beds[2]).not.toBeNull();
    state = tend(state, 2);
    expect(state.beds[2]?.watered).toBe(true);
    state = shine(state, 100);
    state = tend(state, 2);
    expect(state.petals).toBeGreaterThan(0);
  });

  it("buys seeds with petals only when affordable", () => {
    const tulip = SEEDS.find((seed) => seed.id === "tulip")!;
    let state = createGarden(T0);
    expect(buy(state, "tulip")).toBe(state);
    state = { ...state, petals: tulip.price + 1 };
    state = buy(state, "tulip");
    expect(state.owned).toContain("tulip");
    expect(state.petals).toBe(1);
    expect(state.selected).toBe("tulip");
    expect(buy(state, "tulip")).toBe(state);
  });

  it("counts each drop in working as sunshine", () => {
    let state = plant(createGarden(T0), 0);
    state = applyActivity(state, { working: 3, waiting: 0 }, T0);
    expect(state.beds[0]?.stage).toBe(0);
    state = applyActivity(state, { working: 1, waiting: 0 }, T0);
    expect(state.sunshine).toBe(2 * AGENT_SUN);
    expect(state.beds[0]?.stage).toBe(2);
    state = applyActivity(state, { working: 2, waiting: 0 }, T0);
    expect(state.sunshine).toBe(2 * AGENT_SUN);
  });

  it("gives quiet-time sunshine with a capped catch-up", () => {
    let state = createGarden(T0);
    state = tick(state, T0 + TICK_MS * 2 + 5);
    expect(state.sunshine).toBe(2);
    expect(state.lastTick).toBe(T0 + TICK_MS * 2);
    state = tick(createGarden(T0), T0 + TICK_MS * 1000);
    expect(state.sunshine).toBe(MAX_CATCH_UP);
    expect(state.lastTick).toBe(T0 + TICK_MS * 1000);
  });

  it("noteAgentActivity persists and announces without the UI", () => {
    let events = 0;
    const onEvent = () => {
      events += 1;
    };
    window.addEventListener(GARDEN_EVENT, onEvent);
    noteAgentActivity({ working: 2, waiting: 0 }, T0);
    // Stopping on an approval is still busy: no sunshine yet.
    noteAgentActivity({ working: 1, waiting: 1 }, T0);
    expect(loadGarden(T0).sunshine).toBe(0);
    noteAgentActivity({ working: 0, waiting: 0 }, T0);
    window.removeEventListener(GARDEN_EVENT, onEvent);
    expect(events).toBe(2);
    const saved = loadGarden(T0);
    expect(saved.lastWorking).toBe(0);
    expect(saved.sunshine).toBe(2 * AGENT_SUN);
  });

  it("keeps changes in memory when storage writes fail", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    try {
      updateGarden((state) => plant(state, 0), T0);
      expect(loadGarden(T0).beds[0]).not.toBeNull();
    } finally {
      setItem.mockRestore();
    }
    // A save that works clears the in-memory copy for later tests.
    saveGarden(createGarden(T0));
  });

  it("survives bad storage", () => {
    expect(parseGarden("{nope", T0).owned).toEqual(["daisy"]);
    const odd = parseGarden(JSON.stringify({ beds: [{ kind: "cactus" }], petals: -4, owned: ["tulip"] }), T0);
    expect(odd.beds[0]).toBeNull();
    expect(odd.petals).toBe(0);
    expect(odd.owned).toEqual(["daisy", "tulip"]);
  });

  it("has even sprite rows and a friendly line", () => {
    for (const rows of [...Object.values(PLANT_ROWS), ...Object.values(BLOOM_ROWS)]) {
      expect(new Set(rows.map((row) => row.length)).size).toBe(1);
      expect(rows).toHaveLength(10);
    }
    expect(activityLine({ working: 3, waiting: 0 })).toBe("3 agents working · sunshine on the way");
  });
});
