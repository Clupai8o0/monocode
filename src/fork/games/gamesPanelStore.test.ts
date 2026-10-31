import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIZES,
  activityLabel,
  activityNotice,
  loadFullscreen,
  loadSizes,
  saveFullscreen,
  saveSizes,
} from "./gamesPanelStore";

describe("activityLabel", () => {
  it("says who is working and who is waiting", () => {
    expect(activityLabel({ working: 0, waiting: 0 })).toBe("");
    expect(activityLabel({ working: 1, waiting: 0 })).toBe("1 agent working");
    expect(activityLabel({ working: 2, waiting: 1 })).toBe(
      "2 agents working · 1 needs you",
    );
  });
});

describe("activityNotice", () => {
  it("stops the game when an agent starts waiting", () => {
    expect(
      activityNotice({ working: 2, waiting: 0 }, { working: 1, waiting: 1 }),
    ).toBe("An agent needs you");
  });

  it("stops the game when the last agent finishes", () => {
    expect(
      activityNotice({ working: 1, waiting: 0 }, { working: 0, waiting: 0 }),
    ).toBe("Agents finished");
  });

  it("stays quiet otherwise", () => {
    expect(
      activityNotice({ working: 2, waiting: 0 }, { working: 1, waiting: 0 }),
    ).toBeNull();
    expect(
      activityNotice({ working: 0, waiting: 0 }, { working: 1, waiting: 0 }),
    ).toBeNull();
    expect(
      activityNotice({ working: 0, waiting: 1 }, { working: 0, waiting: 0 }),
    ).toBeNull();
  });
});

describe("panel size and full screen", () => {
  const SIZE_KEY = "monocode.fork.games.size";

  function memoryStore() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  }

  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
    vi.stubGlobal("localStorage", store);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts at the defaults", () => {
    expect(loadSizes()).toEqual(DEFAULT_SIZES);
    expect(loadFullscreen()).toBe(false);
  });

  it("keeps a size for each kind and the full screen flag", () => {
    const sizes = {
      grid: { width: 700, height: 500 },
      table: { width: 900, height: 700 },
    };
    saveSizes(sizes);
    saveFullscreen(true);
    expect(loadSizes()).toEqual(sizes);
    expect(loadFullscreen()).toBe(true);
    saveFullscreen(false);
    expect(loadFullscreen()).toBe(false);
  });

  it("falls back one kind at a time when the store is bad", () => {
    store.setItem(SIZE_KEY, "not json");
    expect(loadSizes()).toEqual(DEFAULT_SIZES);
    store.setItem(
      SIZE_KEY,
      JSON.stringify({ grid: { width: 700, height: 500 }, table: "wide" }),
    );
    expect(loadSizes()).toEqual({
      grid: { width: 700, height: 500 },
      table: DEFAULT_SIZES.table,
    });
  });

  it("falls back when the store throws", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    expect(loadSizes()).toEqual(DEFAULT_SIZES);
    expect(loadFullscreen()).toBe(false);
    expect(() => saveSizes(DEFAULT_SIZES)).not.toThrow();
    expect(() => saveFullscreen(true)).not.toThrow();
  });
});
