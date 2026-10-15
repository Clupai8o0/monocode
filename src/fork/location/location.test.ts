import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  FORK_LOCATION,
  forkRingAllowed,
  formatDistance,
  ringLabel,
  ringSentence,
  type LocationStatus,
} from "./location";

function status(over: Partial<LocationStatus>): LocationStatus {
  return {
    mode: "places",
    ring: false,
    place: null,
    reason: "away",
    permission: "granted",
    fixAgeSecs: 10,
    accuracy: 40,
    places: [],
    error: null,
    ...over,
  };
}

describe("location-aware ringing", () => {
  it("names the place when ringing there, else says silent", () => {
    expect(
      ringLabel(status({ ring: true, reason: "atPlace", place: "Home" })),
    ).toBe("Home");
    expect(ringLabel(status({ ring: true, reason: "always" }))).toBe("Ringing");
    expect(ringLabel(status({ reason: "away" }))).toBe("Silent");
    expect(ringLabel(null)).toBe("Alerts");
  });

  it("explains why it is quiet", () => {
    expect(ringSentence(status({ reason: "away" }))).toMatch(
      /not at a saved place/,
    );
    expect(
      ringSentence(status({ reason: "noFix", permission: "denied" })),
    ).toMatch(/location is off/);
    expect(
      ringSentence(status({ reason: "noFix", permission: "prompt" })),
    ).toMatch(/allow location/);
    expect(
      ringSentence(status({ ring: true, reason: "atPlace", place: "Uni" })),
    ).toBe("Ringing: you are at Uni.");
  });

  it("shows distances in m then km", () => {
    expect(formatDistance(42.4)).toBe("42 m away");
    expect(formatDistance(2345)).toBe("2.3 km away");
    expect(formatDistance(null)).toBeNull();
  });

  it("leaves cues alone under the test runner", () => {
    expect(FORK_LOCATION).toBe(false);
    expect(forkRingAllowed()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
