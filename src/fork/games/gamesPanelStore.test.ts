import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIZES,
  DOCK_APP_MIN,
  activityLabel,
  clampDockWidth,
  gamesPanel,
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

describe("side by side", () => {
  afterEach(() => gamesPanel.hide());

  it("docking shows the panel, and hiding undocks it", () => {
    gamesPanel.dock(true);
    expect(gamesPanel.isOpen()).toBe(true);
    expect(gamesPanel.isDocked()).toBe(true);
    gamesPanel.hide();
    expect(gamesPanel.isDocked()).toBe(false);
    gamesPanel.toggle();
    expect(gamesPanel.isDocked()).toBe(false);
  });

  it("undocking leaves the panel floating", () => {
    gamesPanel.dock(true);
    gamesPanel.dock(false);
    expect(gamesPanel.isOpen()).toBe(true);
    expect(gamesPanel.isDocked()).toBe(false);
  });

  it("keeps room for the app, and halves a narrow window", () => {
    expect(clampDockWidth(2000, 1400, 420)).toBe(1400 - DOCK_APP_MIN);
    expect(clampDockWidth(100, 1400, 420)).toBe(420);
    expect(clampDockWidth(600, 1400, 420)).toBe(600);
    expect(clampDockWidth(900, 700, 420)).toBe(350);
    expect(clampDockWidth(100, 700, 420)).toBe(350);
  });
});
