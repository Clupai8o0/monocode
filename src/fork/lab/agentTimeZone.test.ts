// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import {
  AGENT_TZ_CHANGED,
  agentTimeZoneSnapshot,
  cityLabel,
  currentZoneName,
  filterZones,
  formatTime,
  hostZoneToSend,
  intlZone,
  listZones,
  macZone,
  parseAgentTimeZone,
  readRecentZones,
  rememberZone,
  regionLabel,
  resetAgentTimeZoneForTests,
  setAgentTimeZone,
  subscribeAgentTimeZone,
  zoneEntry,
  zoneLabel,
  zoneNames,
} from "./agentTimeZone";

const at = new Date("2026-10-29T08:35:00Z");

describe("helpers", () => {
  it("makes a city label from an IANA name", () => {
    expect(cityLabel("Asia/Kolkata")).toBe("Kolkata");
    expect(cityLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(cityLabel("UTC")).toBe("UTC");
    expect(regionLabel("America/Argentina/Buenos_Aires")).toBe("America / Argentina");
    expect(regionLabel("UTC")).toBe("");
  });

  it("formats a time in a zone, in 24 or 12 hour form by locale", () => {
    expect(formatTime(at, "Asia/Kolkata", "en-GB")).toBe("14:05");
    expect(formatTime(at, "Asia/Kolkata", "en-US")).toMatch(/^2:05\sPM$/);
    expect(formatTime(at, "Not/AZone", "en-GB")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("names a zone and its offset", () => {
    expect(zoneNames("Asia/Kolkata", at)).toEqual({ abbr: "IST", offset: "GMT+5:30" });
    expect(zoneNames("Australia/Sydney", at)).toEqual({ abbr: "AEDT", offset: "GMT+11" });
    expect(zoneLabel("Asia/Kolkata", at)).toBe("Kolkata (IST, GMT+5:30)");
    expect(zoneNames("UTC", at)).toEqual({ abbr: null, offset: "GMT" });
  });

  it("finds zones by city, region, abbreviation or offset", () => {
    const entries = ["Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney", "Europe/London"].map((zone) =>
      zoneEntry(zone, at),
    );
    const zones = (query: string) => filterZones(entries, query).map((entry) => entry.zone);
    expect(zones("kolk")).toEqual(["Asia/Kolkata"]);
    expect(zones("asia")).toEqual(["Asia/Kolkata", "Asia/Tokyo"]);
    expect(zones("IST")).toEqual(["Asia/Kolkata"]);
    expect(zones("+5:30")).toEqual(["Asia/Kolkata"]);
    expect(zones("aedt")).toEqual(["Australia/Sydney"]);
    expect(zones("")).toHaveLength(4);
  });

  it("lists zones by their current names, and copes without the list", () => {
    const zones = listZones();
    expect(zones).toContain("Asia/Kolkata");
    expect(zones).not.toContain("Asia/Calcutta");
    expect(zones).toContain("UTC");
    expect(currentZoneName("Europe/Kiev")).toBe("Europe/Kyiv");
    const original = Intl.supportedValuesOf;
    try {
      (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
      expect(listZones()).toEqual([]);
    } finally {
      Intl.supportedValuesOf = original;
    }
  });

  it("sends the effective zone to hosts, else this webview's", () => {
    expect(hostZoneToSend({ zone: "Asia/Tokyo", systemZone: "Asia/Kolkata", effectiveZone: "Asia/Tokyo" })).toBe(
      "Asia/Tokyo",
    );
    expect(hostZoneToSend({ zone: null, systemZone: null, effectiveZone: null })).toBe(intlZone());
    expect(hostZoneToSend(null)).toBe(intlZone());
    expect(macZone({ zone: null, systemZone: null, effectiveZone: null })).toBe(intlZone());
  });

  it("parses the Rust answer", () => {
    expect(parseAgentTimeZone({ zone: null, systemZone: "Asia/Kolkata", effectiveZone: "Asia/Kolkata" })).toEqual({
      zone: null,
      systemZone: "Asia/Kolkata",
      effectiveZone: "Asia/Kolkata",
    });
    expect(parseAgentTimeZone({ zone: "Asia/Tokyo", systemZone: null })).toEqual({
      zone: "Asia/Tokyo",
      systemZone: null,
      effectiveZone: "Asia/Tokyo",
    });
    expect(parseAgentTimeZone(null)).toBeUndefined();
  });
});

describe("recent zones", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the last four, newest first, without repeats", () => {
    for (const zone of ["A/a", "B/b", "C/c", "A/a", "D/d", "E/e"]) {
      rememberZone(zone);
    }
    expect(readRecentZones()).toEqual(["E/e", "D/d", "A/a", "C/c"]);
  });

  it("survives broken or blocked storage", () => {
    localStorage.setItem("monocode:fork-agent-tz-recent", "{nope");
    expect(readRecentZones()).toEqual([]);
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(readRecentZones()).toEqual([]);
      expect(rememberZone("Asia/Tokyo")).toEqual(["Asia/Tokyo"]);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe("store", () => {
  let fire: ((event: { payload: unknown }) => void) | undefined;
  const unlisten = vi.fn();

  beforeEach(() => {
    resetAgentTimeZoneForTests();
    localStorage.clear();
    fire = undefined;
    unlisten.mockReset();
    invoke.mockReset();
    listen.mockReset().mockImplementation(async (name: string, handler: typeof fire) => {
      expect(name).toBe(AGENT_TZ_CHANGED);
      fire = handler;
      return unlisten;
    });
  });

  afterEach(() => resetAgentTimeZoneForTests());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("reads on subscribe, follows the event and re-reads on focus", async () => {
    invoke.mockResolvedValue({ zone: null, systemZone: "Asia/Kolkata", effectiveZone: "Asia/Kolkata" });
    const listener = vi.fn();
    const stop = subscribeAgentTimeZone(listener);
    await settle();
    expect(invoke).toHaveBeenCalledWith("fork_agent_tz_get");
    expect(agentTimeZoneSnapshot().value?.systemZone).toBe("Asia/Kolkata");

    fire?.({ payload: { zone: "Asia/Tokyo", systemZone: "Asia/Kolkata", effectiveZone: "Asia/Tokyo" } });
    expect(agentTimeZoneSnapshot().value?.zone).toBe("Asia/Tokyo");

    invoke.mockResolvedValue({ zone: null, systemZone: "Europe/Paris", effectiveZone: "Europe/Paris" });
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(agentTimeZoneSnapshot().value?.systemZone).toBe("Europe/Paris");
    expect(listener).toHaveBeenCalled();

    stop();
    expect(unlisten).toHaveBeenCalled();
    invoke.mockClear();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps a read error in words", async () => {
    invoke.mockRejectedValue("Command fork_agent_tz_get not found");
    const stop = subscribeAgentTimeZone(() => {});
    await settle();
    expect(agentTimeZoneSnapshot().error).toBe("This needs a newer MonoCode on this Mac.");
    stop();
  });

  it("sets a zone, remembers it, and passes errors on in words", async () => {
    invoke.mockResolvedValue({ zone: "Asia/Tokyo", systemZone: "Asia/Kolkata", effectiveZone: "Asia/Tokyo" });
    await setAgentTimeZone("Asia/Tokyo");
    expect(invoke).toHaveBeenCalledWith("fork_agent_tz_set", { zone: "Asia/Tokyo" });
    expect(agentTimeZoneSnapshot().value?.effectiveZone).toBe("Asia/Tokyo");
    expect(readRecentZones()).toEqual(["Asia/Tokyo"]);

    invoke.mockRejectedValue("Asia/Nowhere is not a time zone on this Mac.");
    await expect(setAgentTimeZone("Asia/Nowhere")).rejects.toThrow("Asia/Nowhere is not a time zone on this Mac.");
    expect(readRecentZones()).toEqual(["Asia/Tokyo"]);
  });

  it("doesn't let a read that started before a save put the old zone back", async () => {
    let answer: (value: unknown) => void = () => {};
    invoke.mockImplementation((command: string) =>
      command === "fork_agent_tz_get"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ zone: "Asia/Tokyo", systemZone: "Asia/Kolkata", effectiveZone: "Asia/Tokyo" }),
    );
    const stop = subscribeAgentTimeZone(() => {});
    await setAgentTimeZone("Asia/Tokyo");
    answer({ zone: null, systemZone: "Asia/Kolkata", effectiveZone: "Asia/Kolkata" });
    await settle();
    expect(agentTimeZoneSnapshot().value?.zone).toBe("Asia/Tokyo");
    stop();
  });
});
