import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/**
 * Fork: the agents' time zone, as this Mac keeps it. Agents MonoCode starts
 * get TZ=<zone> when the owner picked one; with none picked they follow this
 * Mac's own zone. One store for every window, fed by the Rust commands
 * fork_agent_tz_get / fork_agent_tz_set, the "fork-agent-tz-changed" event
 * (sent to all windows after a set) and a fresh read on window focus, since
 * the Mac's zone can change while the app runs.
 */

export type AgentTimeZone = {
  /** The zone the owner picked; null: follow this Mac. */
  zone: string | null;
  /** This Mac's zone now, from /etc/localtime; null if unreadable. */
  systemZone: string | null;
  /** zone ?? systemZone. */
  effectiveZone: string | null;
};

export const AGENT_TZ_CHANGED = "fork-agent-tz-changed";
const RECENT_KEY = "monocode:fork-agent-tz-recent";
const RECENT_MAX = 4;

// ---- helpers ----

/** The zone this webview runs in, the fallback for an unreadable Mac zone. */
export function intlZone(): string {
  try {
    return currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

function zoneOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The Rust commands' answer, checked; undefined when it is not one. */
export function parseAgentTimeZone(value: unknown): AgentTimeZone | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const zone = zoneOrNull(record.zone);
  const systemZone = zoneOrNull(record.systemZone);
  return { zone, systemZone, effectiveZone: zoneOrNull(record.effectiveZone) ?? zone ?? systemZone };
}

/** This Mac's zone, or the webview's when the Mac's could not be read. */
export function macZone(value: AgentTimeZone | null | undefined): string {
  return value?.systemZone ?? intlZone();
}

/** The zone agents start in now. */
export function agentZone(value: AgentTimeZone | null | undefined): string {
  return value?.zone ?? macZone(value);
}

/** The zone to tell lab hosts: never null, so hosts follow this Mac. */
export function hostZoneToSend(value: AgentTimeZone | null | undefined): string {
  return value?.effectiveZone ?? intlZone();
}

// Browsers still list some zones by their old names; this Mac and the lab
// hosts use the current ones.
const RENAMED: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
};

/** A zone's current name: "Asia/Calcutta" -> "Asia/Kolkata". */
export function currentZoneName(zone: string): string {
  return RENAMED[zone] ?? zone;
}

/** Every IANA zone this webview knows, by current name, plus UTC, sorted;
 * empty when it can't say. */
export function listZones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported !== "function") {
      return [];
    }
    const zones = supported("timeZone");
    return Array.isArray(zones) ? [...new Set([...zones.map(currentZoneName), "UTC"])].sort() : [];
  } catch {
    return [];
  }
}

/** "Asia/Kolkata" -> "Kolkata", "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export function cityLabel(zone: string): string {
  const last = zone.split("/").pop() || zone;
  return last.replace(/_/g, " ");
}

/** "Asia/Kolkata" -> "Asia"; "" for a zone without a region such as "UTC". */
export function regionLabel(zone: string): string {
  const parts = zone.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join(" / ").replace(/_/g, " ") : "";
}

/** "14:05", or "2:05 PM" where the locale reads 12-hour time. */
export function formatTime(date: Date, zone: string, locale?: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}

function zonePart(date: Date, zone: string, style: "short" | "shortOffset", locale?: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style }).formatToParts(date);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// Locales that name more zones than "GMT+n": IST, AEDT, BST, EST...
const NAMING_LOCALES = ["en-US", "en-GB", "en-AU", "en-IN"];

/** abbr: "IST" or null when no locale names it; offset: "GMT+5:30". */
export function zoneNames(zone: string, date = new Date(), locale?: string): { abbr: string | null; offset: string } {
  const offset = (zonePart(date, zone, "shortOffset", "en-US") || "GMT").replace(/^GMT[+-]0$/, "GMT");
  for (const name of [locale, ...NAMING_LOCALES]) {
    const short = zonePart(date, zone, "short", name);
    if (short && !/^(GMT|UTC)([+\-−]|$)/.test(short)) {
      return { abbr: short, offset };
    }
  }
  return { abbr: null, offset };
}

/** "Kolkata (IST, GMT+5:30)". */
export function zoneLabel(zone: string, date = new Date(), locale?: string): string {
  const { abbr, offset } = zoneNames(zone, date, locale);
  return `${cityLabel(zone)} (${abbr ? `${abbr}, ${offset}` : offset})`;
}

export type ZoneEntry = {
  zone: string;
  city: string;
  region: string;
  abbr: string | null;
  offset: string;
  /** Everything a search may match, lower case. */
  haystack: string;
};

export function zoneEntry(zone: string, date = new Date(), locale?: string): ZoneEntry {
  const { abbr, offset } = zoneNames(zone, date, locale);
  const city = cityLabel(zone);
  const region = regionLabel(zone);
  // "GMT+5:30" is also findable as "+5:30", "5:30" and "UTC+5:30".
  const bare = offset.replace(/^GMT/, "");
  const haystack = [zone.replace(/_/g, " "), city, region, abbr ?? "", offset, `UTC${bare}`, bare]
    .join(" ")
    .toLowerCase();
  return { zone, city, region, abbr, offset, haystack };
}

// Working out every zone's names takes a few thousand formatters, so the
// picker keeps them for the hour they were made in.
let cacheHour = -1;
const cache = new Map<string, ZoneEntry>();

/** Entries for these zones at the start of the hour `date` is in. */
export function zoneEntries(zones: string[], date = new Date()): ZoneEntry[] {
  const hour = Math.floor(date.getTime() / 3_600_000);
  if (hour !== cacheHour) {
    cache.clear();
    cacheHour = hour;
  }
  const start = new Date(hour * 3_600_000);
  return zones.map((zone) => {
    let entry = cache.get(zone);
    if (!entry) {
      entry = zoneEntry(zone, start);
      cache.set(zone, entry);
    }
    return entry;
  });
}

/** Zones whose city, region, abbreviation or offset match every word typed. */
export function filterZones(entries: ZoneEntry[], query: string): ZoneEntry[] {
  const words = query.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) {
    return entries;
  }
  const hits = entries.filter((entry) => words.every((word) => entry.haystack.includes(word)));
  // Cities that start with what was typed come first.
  const first = words[0];
  return [
    ...hits.filter((entry) => entry.city.toLowerCase().startsWith(first)),
    ...hits.filter((entry) => !entry.city.toLowerCase().startsWith(first)),
  ];
}

// ---- recent picks, per viewer ----

export function readRecentZones(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((zone): zone is string => typeof zone === "string" && !!zone).slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberZone(zone: string): string[] {
  const next = [zone, ...readRecentZones().filter((item) => item !== zone)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the quick picks just stay as they were.
  }
  return next;
}

/** A failed command, in words. */
export function zoneErrorText(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const text = raw.trim();
  if (/command \S+ not found|unknown command|not allowed/i.test(text)) {
    return "This needs a newer MonoCode on this Mac.";
  }
  return text || "Changing the time zone didn't work.";
}

// ---- store ----

type Store = {
  value: AgentTimeZone | null;
  loading: boolean;
  /** Reading failed; the last good value stays. */
  error: string | null;
  /** The zone picker is open, so a popover around it can leave Escape to it. */
  pickerOpen: boolean;
};

let current: Store = { value: null, loading: false, error: null, pickerOpen: false };
const listeners = new Set<() => void>();
let stopSync: (() => void) | undefined;
let inFlight: Promise<void> | null = null;
/** Moved on by every save, so a read that started before it can't put the
 * old zone back. */
let saves = 0;

function set(next: Partial<Store>): void {
  current = { ...current, ...next };
  for (const listener of listeners) {
    listener();
  }
}

export function agentTimeZoneSnapshot(): Store {
  return current;
}

export function refreshAgentTimeZone(): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  set({ loading: true });
  const started = saves;
  inFlight = invoke<unknown>("fork_agent_tz_get")
    .then((raw) => {
      if (started !== saves) {
        return;
      }
      const value = parseAgentTimeZone(raw);
      set(value ? { value, error: null } : { error: "The time zone came back unreadable." });
    })
    .catch((reason: unknown) => {
      if (started === saves) {
        set({ error: zoneErrorText(reason) });
      }
    })
    .finally(() => {
      inFlight = null;
      set({ loading: false });
    });
  return inFlight;
}

/** Picks a zone, or null to follow this Mac. Throws the error in words. */
export async function setAgentTimeZone(zone: string | null): Promise<AgentTimeZone> {
  let value: AgentTimeZone | undefined;
  try {
    value = parseAgentTimeZone(await invoke<unknown>("fork_agent_tz_set", { zone }));
  } catch (reason) {
    throw new Error(zoneErrorText(reason));
  }
  if (!value) {
    throw new Error("The time zone came back unreadable.");
  }
  if (zone) {
    rememberZone(zone);
  }
  saves += 1;
  set({ value, error: null });
  return value;
}

export function setZonePickerOpen(open: boolean): void {
  if (current.pickerOpen !== open) {
    set({ pickerOpen: open });
  }
}

export function subscribeAgentTimeZone(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const onFocus = () => void refreshAgentTimeZone();
    window.addEventListener("focus", onFocus);
    void listen<unknown>(AGENT_TZ_CHANGED, (event) => {
      const value = parseAgentTimeZone(event.payload);
      if (value) {
        set({ value, error: null });
      } else {
        void refreshAgentTimeZone();
      }
    })
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {});
    stopSync = () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
    void refreshAgentTimeZone();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopSync?.();
      stopSync = undefined;
    }
  };
}

export function useAgentTimeZone(): Store {
  return useSyncExternalStore(subscribeAgentTimeZone, agentTimeZoneSnapshot, agentTimeZoneSnapshot);
}

/** For a popover holding the section: true while the zone picker is open,
 * so the popover can leave Escape to the picker (dismissOnEscape={!open}). */
export function useZonePickerOpen(): boolean {
  return useAgentTimeZone().pickerOpen;
}

/** Tests only: back to a fresh store. */
export function resetAgentTimeZoneForTests(): void {
  stopSync?.();
  stopSync = undefined;
  listeners.clear();
  inFlight = null;
  current = { value: null, loading: false, error: null, pickerOpen: false };
}
