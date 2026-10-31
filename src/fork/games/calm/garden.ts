import type { AgentActivity } from "../../backgroundAgents/runningAgents";
import type { Rows } from "../table/sprites";

/**
 * Fork: agent garden. Finished agent work brings sunshine, sunshine grows
 * plants, blooms give petals, petals buy seeds. Nothing wilts or dies.
 */

export const GARDEN_KEY = "monocode.fork.games.garden";
export const GARDEN_EVENT = "monocode:fork-garden";

export const COLS = 4;
export const ROWS = 3;
export const BEDS = COLS * ROWS;

/** Growth from one finished agent run, and from a quiet ten minutes. */
export const AGENT_SUN = 2;
export const TIME_SUN = 1;
export const TICK_MS = 10 * 60 * 1000;
/** At most this many quiet ticks are made up after time away. */
export const MAX_CATCH_UP = 12;
/** Growth a plant needs per stage. */
export const STAGE_COST = 2;

export type SeedKind = "daisy" | "tulip" | "poppy" | "sunflower" | "lavender";

export type Seed = {
  id: SeedKind;
  name: string;
  /** Petals to unlock; 0 is known from the start. */
  price: number;
  /** Stages after the seed before it blooms. */
  stages: number;
  petals: number;
  colors: Record<string, string>;
};

export const SEEDS: readonly Seed[] = [
  { id: "daisy", name: "Daisy", price: 0, stages: 3, petals: 3, colors: { p: "#f4efe2", c: "#e8c547" } },
  { id: "tulip", name: "Tulip", price: 15, stages: 3, petals: 5, colors: { p: "#e98a9a", c: "#c4596d" } },
  { id: "poppy", name: "Poppy", price: 30, stages: 4, petals: 8, colors: { p: "#e8775f", c: "#3d3a36" } },
  { id: "sunflower", name: "Sunflower", price: 60, stages: 5, petals: 14, colors: { p: "#f0c43f", c: "#7a5530" } },
  { id: "lavender", name: "Lavender", price: 100, stages: 5, petals: 20, colors: { p: "#a993d8", c: "#7c68b3" } },
];

export function seedOf(id: SeedKind): Seed {
  return SEEDS.find((seed) => seed.id === id) ?? SEEDS[0]!;
}

export type Plant = {
  kind: SeedKind;
  /** 0 is a seed; `stages` is in bloom. */
  stage: number;
  growth: number;
  watered: boolean;
};

export type GardenState = {
  beds: (Plant | null)[];
  petals: number;
  blooms: number;
  owned: SeedKind[];
  selected: SeedKind;
  /** Last `working` count seen. */
  lastWorking: number;
  /** When quiet-time sunshine was last counted. */
  lastTick: number;
  /** Sunshine earned since the garden UI last showed it. */
  sunshine: number;
};

export function createGarden(now: number): GardenState {
  return {
    beds: Array.from({ length: BEDS }, () => null),
    petals: 0,
    blooms: 0,
    owned: ["daisy"],
    selected: "daisy",
    lastWorking: 0,
    lastTick: now,
    sunshine: 0,
  };
}

export function bloomed(plant: Plant | null): boolean {
  return !!plant && plant.stage >= seedOf(plant.kind).stages;
}

/** Every plant takes `amount` growth; a watered one takes twice and dries. */
export function shine(state: GardenState, amount: number): GardenState {
  if (amount <= 0) {
    return state;
  }
  const beds = state.beds.map((plant) => {
    if (!plant || bloomed(plant)) {
      return plant;
    }
    const { stages } = seedOf(plant.kind);
    let growth = plant.growth + amount * (plant.watered ? 2 : 1);
    let stage = plant.stage;
    while (growth >= STAGE_COST && stage < stages) {
      growth -= STAGE_COST;
      stage += 1;
    }
    return { ...plant, stage, growth: stage >= stages ? 0 : growth, watered: false };
  });
  return { ...state, beds, sunshine: state.sunshine + amount };
}

export function plant(state: GardenState, bed: number, kind = state.selected): GardenState {
  if (state.beds[bed] !== null || !state.owned.includes(kind)) {
    return state;
  }
  const beds = [...state.beds];
  beds[bed] = { kind, stage: 0, growth: 0, watered: false };
  return { ...state, beds };
}

export function water(state: GardenState, bed: number): GardenState {
  const current = state.beds[bed];
  if (!current || current.watered || bloomed(current)) {
    return state;
  }
  const beds = [...state.beds];
  beds[bed] = { ...current, watered: true };
  return { ...state, beds };
}

export function harvest(state: GardenState, bed: number): GardenState {
  const current = state.beds[bed] ?? null;
  if (!bloomed(current)) {
    return state;
  }
  const beds = [...state.beds];
  beds[bed] = null;
  return {
    ...state,
    beds,
    petals: state.petals + seedOf(current!.kind).petals,
    blooms: state.blooms + 1,
  };
}

/** One click on a bed: plant if empty, harvest if in bloom, else water. */
export function tend(state: GardenState, bed: number): GardenState {
  const current = state.beds[bed];
  if (current === null || current === undefined) {
    return plant(state, bed);
  }
  return bloomed(current) ? harvest(state, bed) : water(state, bed);
}

export function buy(state: GardenState, kind: SeedKind): GardenState {
  const seed = seedOf(kind);
  if (state.owned.includes(kind) || state.petals < seed.price) {
    return state;
  }
  return { ...state, petals: state.petals - seed.price, owned: [...state.owned, kind], selected: kind };
}

export function select(state: GardenState, kind: SeedKind): GardenState {
  return state.owned.includes(kind) ? { ...state, selected: kind } : state;
}

/** Quiet-time sunshine since `lastTick`, capped after a long time away. */
export function tick(state: GardenState, now: number): GardenState {
  const ticks = Math.floor((now - state.lastTick) / TICK_MS);
  if (ticks <= 0) {
    return now < state.lastTick ? { ...state, lastTick: now } : state;
  }
  const counted = Math.min(ticks, MAX_CATCH_UP);
  const next = shine(state, counted * TIME_SUN);
  const lastTick = ticks > MAX_CATCH_UP ? now : state.lastTick + ticks * TICK_MS;
  return { ...next, lastTick };
}

/** One sunshine for each agent that stopped working. */
export function applyActivity(state: GardenState, activity: AgentActivity, now: number): GardenState {
  const finished = Math.max(0, state.lastWorking - activity.working);
  const next = tick(state, now);
  return { ...shine(next, finished * AGENT_SUN), lastWorking: activity.working };
}

/** Sunshine the UI has shown; only clears the counter. */
export function seenSunshine(state: GardenState): GardenState {
  return state.sunshine === 0 ? state : { ...state, sunshine: 0 };
}

// --- Persistence -------------------------------------------------------------

function isKind(value: unknown): value is SeedKind {
  return SEEDS.some((seed) => seed.id === value);
}

function num(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function parseGarden(raw: string | null, now: number): GardenState {
  const fresh = createGarden(now);
  if (!raw) {
    return fresh;
  }
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof GardenState, unknown>>;
    const beds = Array.isArray(data.beds) ? data.beds : [];
    const owned = Array.isArray(data.owned) ? data.owned.filter(isKind) : [];
    if (!owned.includes("daisy")) {
      owned.unshift("daisy");
    }
    return {
      beds: fresh.beds.map((_, index) => {
        const item = beds[index] as Partial<Plant> | null | undefined;
        if (!item || !isKind(item.kind)) {
          return null;
        }
        return {
          kind: item.kind,
          stage: Math.min(num(item.stage, 0), seedOf(item.kind).stages),
          growth: num(item.growth, 0),
          watered: item.watered === true,
        };
      }),
      petals: num(data.petals, 0),
      blooms: num(data.blooms, 0),
      owned,
      selected: isKind(data.selected) && owned.includes(data.selected) ? data.selected : "daisy",
      lastWorking: num(data.lastWorking, 0),
      lastTick: num(data.lastTick, now),
      sunshine: num(data.sunshine, 0),
    };
  } catch {
    return fresh;
  }
}

export function loadGarden(now = Date.now()): GardenState {
  try {
    return parseGarden(localStorage.getItem(GARDEN_KEY), now);
  } catch {
    return createGarden(now);
  }
}

export function saveGarden(state: GardenState) {
  try {
    localStorage.setItem(GARDEN_KEY, JSON.stringify(state));
  } catch {
    // Storage full or off: the garden still grows this session.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GARDEN_EVENT));
  }
}

/** Load, change, save, announce. Saves only when something changed. */
export function updateGarden(change: (state: GardenState) => GardenState, now = Date.now()) {
  const before = loadGarden(now);
  const after = change(before);
  if (after !== before) {
    saveGarden(after);
  }
  return after;
}

/** Call on every activity change, garden open or not. */
export function noteAgentActivity(activity: AgentActivity, now: number) {
  const before = loadGarden(now);
  const after = applyActivity(before, activity, now);
  if (
    after.lastWorking !== before.lastWorking ||
    after.lastTick !== before.lastTick ||
    after.sunshine !== before.sunshine
  ) {
    saveGarden(after);
  }
  return after;
}

/** "3 agents working · sunshine on the way". */
export function activityLine(activity: AgentActivity) {
  if (activity.working > 0) {
    const who = activity.working === 1 ? "1 agent working" : `${activity.working} agents working`;
    return `${who} · sunshine on the way`;
  }
  if (activity.waiting > 0) {
    return `${activity.waiting} waiting on you · the garden can wait too`;
  }
  return "all quiet · a little sun every ten minutes";
}

// --- Sprites (9 x 10) ---------------------------------------------------------

/** g stem, l leaf, p petal, c centre, s soil seed. */
export const PLANT_ROWS: Record<"seed" | "sprout" | "bud" | "grown", Rows> = {
  seed: [
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    "...sss...",
    "....s....",
  ],
  sprout: [
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    "..ll.ll..",
    "...lgl...",
    "....g....",
    "....g....",
  ],
  bud: [
    ".........",
    ".........",
    ".........",
    "....c....",
    "...ccc...",
    "....g....",
    ".ll.g....",
    "..llg.ll.",
    "....gll..",
    "....g....",
  ],
  grown: [
    ".........",
    ".........",
    "....p....",
    "...ppp...",
    "....g....",
    "..l.g....",
    ".llgg.l..",
    "....gll..",
    "....g....",
    "....g....",
  ],
};

export const BLOOM_ROWS: Record<SeedKind, Rows> = {
  daisy: [
    "...p.p...",
    "..ppppp..",
    ".pppcppp.",
    "..ppppp..",
    "...p.p...",
    "....g....",
    ".ll.g.ll.",
    "..llgll..",
    "....g....",
    "....g....",
  ],
  tulip: [
    "..p.p.p..",
    "..ppppp..",
    "..ppcpp..",
    "...ppp...",
    "....g....",
    "..l.g.l..",
    "..llgll..",
    "...lgl...",
    "....g....",
    "....g....",
  ],
  poppy: [
    "..ppppp..",
    ".ppppppp.",
    ".pppcppp.",
    "..ppppp..",
    "....g....",
    "....g.l..",
    "..l.gll..",
    "..llg....",
    "....g....",
    "....g....",
  ],
  sunflower: [
    "..ppppp..",
    ".ppcccpp.",
    "ppcccccpp",
    ".ppcccpp.",
    "..ppppp..",
    "....g....",
    ".lllg....",
    "....glll.",
    "....g....",
    "....g....",
  ],
  lavender: [
    "...p.p...",
    "..pcpcp..",
    "...pcp.p.",
    "..pcp.pc.",
    "...p.gp..",
    "....g.g..",
    "...lg.g..",
    "..ll.gll.",
    ".....g...",
    ".....g...",
  ],
};

export const SUN_ROWS: Rows = [
  "..#.#.#..",
  "...###...",
  "#.#####.#",
  ".#######.",
  "#.#####.#",
  "...###...",
  "..#.#.#..",
];

export const DROP_ROWS: Rows = ["..#..", ".###.", "#####", "#####", ".###."];

/** Which picture a plant shows right now. */
export function plantRows(plant: Plant): Rows {
  const { stages } = seedOf(plant.kind);
  if (plant.stage >= stages) {
    return BLOOM_ROWS[plant.kind];
  }
  if (plant.stage === 0) {
    return PLANT_ROWS.seed;
  }
  const left = stages - plant.stage;
  return left === 1 ? PLANT_ROWS.grown : left === 2 ? PLANT_ROWS.bud : PLANT_ROWS.sprout;
}
