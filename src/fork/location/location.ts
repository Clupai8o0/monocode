import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Fork: alerts ring only at saved places (src-tauri/src/fork_location.rs).
 * Rust silences native banners itself; this module gives the in-app cues the
 * same answer and feeds the footer button.
 */

export type RingMode = "places" | "always" | "never";

export type RingReason =
  "always" | "never" | "noPlaces" | "noFix" | "away" | "atPlace";

export type PlaceView = {
  name: string;
  address: string | null;
  radius: number;
  located: boolean;
  distance: number | null;
};

export type LocationStatus = {
  mode: RingMode;
  ring: boolean;
  place: string | null;
  reason: RingReason;
  permission: "prompt" | "granted" | "denied" | "off" | "unknown";
  fixAgeSecs: number | null;
  accuracy: number | null;
  places: PlaceView[];
  error: string | null;
};

/** Off under the test runner, so upstream tests see no new IPC or button. */
export const FORK_LOCATION = import.meta.env.MODE !== "test";

const EVENT = "fork_location";
/** Rust only reports changes; a fix going stale is noticed by asking again. */
const REFRESH_MS = 120_000;

let status: LocationStatus | null = null;
let started = false;
/** False until Rust has answered, and again after a failed refresh. */
let trusted = false;
const listeners = new Set<() => void>();

function set(next: LocationStatus) {
  status = next;
  trusted = true;
  listeners.forEach((fn) => fn());
}

function refresh(): void {
  void invoke<LocationStatus>("fork_location_status")
    .then(set)
    .catch(() => {
      // Unknown again: cues stay quiet until Rust answers.
      trusted = false;
      status = null;
      listeners.forEach((fn) => fn());
    });
}

function ensureStarted(): void {
  if (started || !FORK_LOCATION) {
    return;
  }
  started = true;
  refresh();
  void listen<LocationStatus>(EVENT, ({ payload }) => set(payload)).catch(
    () => undefined,
  );
  setInterval(refresh, REFRESH_MS);
}

export function locationStatus(): LocationStatus | null {
  return status;
}

export function subscribeLocation(fn: () => void): () => void {
  ensureStarted();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Fork hook for `playCue`: may an alert cue sound right now? Quiet until Rust
 * has answered (it says "always" when places were never set up). Outside the
 * app (tests, browser) cues are left alone.
 */
export function forkRingAllowed(): boolean {
  if (!FORK_LOCATION) {
    return true;
  }
  ensureStarted();
  return trusted && status !== null && status.ring;
}

export function setRingMode(mode: RingMode): Promise<LocationStatus> {
  return invoke<LocationStatus>("fork_location_set_mode", { mode }).then(
    (next) => {
      set(next);
      return next;
    },
  );
}

/** No address: the place is where the Mac is now. */
export function addPlace(
  name: string,
  address: string | null,
  radius?: number,
): Promise<LocationStatus> {
  return invoke<LocationStatus>("fork_place_add", {
    name,
    address,
    radius: radius ?? null,
  }).then((next) => {
    set(next);
    return next;
  });
}

export function removePlace(name: string): Promise<LocationStatus> {
  return invoke<LocationStatus>("fork_place_remove", { name }).then((next) => {
    set(next);
    return next;
  });
}

export function openLocationSettings(): Promise<void> {
  return invoke("fork_location_open_settings");
}

/** Footer label: the place you are at, or why alerts are quiet. */
export function ringLabel(s: LocationStatus | null): string {
  if (!s) {
    return "Alerts";
  }
  switch (s.reason) {
    case "atPlace":
      return s.place ?? "Ringing";
    case "always":
      return "Ringing";
    default:
      return "Silent";
  }
}

/** One plain line for the top of the panel. */
export function ringSentence(s: LocationStatus): string {
  switch (s.reason) {
    case "atPlace":
      return `Ringing: you are at ${s.place}.`;
    case "always":
      return "Ringing everywhere.";
    case "never":
      return "Silent everywhere. Banners still show.";
    case "noPlaces":
      return "Silent: no saved places yet. Banners still show.";
    case "away":
      return "Silent: not at a saved place. Banners still show.";
    case "noFix":
      if (s.permission === "denied" || s.permission === "off") {
        return "Silent: location is off for MonoCode.";
      }
      if (s.permission === "prompt") {
        return "Silent until you allow location for MonoCode.";
      }
      return "Silent: finding where you are…";
  }
}

export function formatDistance(metres: number | null): string | null {
  if (metres == null) {
    return null;
  }
  return metres < 1000
    ? `${Math.round(metres)} m away`
    : `${(metres / 1000).toFixed(1)} km away`;
}
