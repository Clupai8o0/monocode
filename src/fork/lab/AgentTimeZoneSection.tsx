import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "../../shared/ui/icons";
import {
  agentZone,
  cityLabel,
  filterZones,
  formatTime,
  hostZoneToSend,
  listZones,
  macZone,
  readRecentZones,
  setAgentTimeZone,
  setZonePickerOpen,
  useAgentTimeZone,
  zoneEntries,
  zoneLabel,
  zoneNames,
  type ZoneEntry,
} from "./agentTimeZone";
import type { AgentTimeZoneStatus } from "./labProtocol";
import type { LabHost } from "./labStore";
import { notifyLabChanged } from "./labWatcher";

/**
 * Fork: the agents' time zone. Shows the clock agents see and switches
 * between following this Mac and a picked zone. Full for Settings > Home lab,
 * compact for the footer's Home lab popover.
 */

export type AgentTimeZoneHost = {
  name: string;
  online: boolean;
  tzCapable: boolean;
  timeZone?: AgentTimeZoneStatus;
};

type Props = { compact?: boolean; hosts?: AgentTimeZoneHost[] };

const quiet = "text-[12px] leading-relaxed text-content/50";
/** Results shown at once; typing narrows the rest. */
const LIST_MAX = 80;

/** The time now, updated on each new minute. */
function useMinute(): Date
{
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, 60_000 - (Date.now() % 60_000) + 50);
    return () => {
      clearTimeout(timeout);
      if (interval) {
        clearInterval(interval);
      }
    };
  }, []);
  return now;
}

/** The lab hosts as the section lists them; a host still loading waits. */
export function zoneHosts(hosts: LabHost[]): AgentTimeZoneHost[] {
  return hosts
    .filter((host) => host.status || host.offline)
    .map((host) => ({
      name: host.machine.name,
      online: !host.offline,
      tzCapable: host.timeZone,
      timeZone: host.status?.timeZone,
    }));
}

/** "IST", or "GMT+5:30" where the zone has no short name. */
function shortZone(zone: string, now: Date): string {
  const { abbr, offset } = zoneNames(zone, now);
  return abbr ?? offset;
}

export function hostLine(host: AgentTimeZoneHost, target: string): string {
  if (!host.online) {
    return `${host.name} offline`;
  }
  if (!host.tzCapable) {
    return `${host.name} needs a host update for this`;
  }
  if (host.timeZone?.zone === target) {
    if (host.timeZone.installed === false) {
      const own = host.timeZone.hostZone ? cityLabel(host.timeZone.hostZone) : "its own zone";
      return `${host.name} doesn't have ${cityLabel(target)}; its agents use ${own}`;
    }
    return `${host.name} uses ${cityLabel(target)}`;
  }
  return `${host.name}: switching to ${cityLabel(target)}…`;
}

export function AgentTimeZoneSection({ compact = false, hosts }: Props)
{
  const { value, error: readError } = useAgentTimeZone();
  const now = useMinute();
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const pickButton = useRef<HTMLButtonElement>(null);
  /** A pick closed the picker; focus goes back to its button once the save
   * lets go of it, so the keyboard isn't sent to the top of the page. */
  const refocus = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setZonePickerOpen(false);
    };
  }, []);
  useEffect(() => {
    setZonePickerOpen(picking);
  }, [picking]);

  const mac = macZone(value);
  const zone = agentZone(value);
  const following = !value?.zone;
  const target = hostZoneToSend(value);

  const choose = async (next: string | null) => {
    // One save at a time, so answers can't land out of order.
    if (saving !== undefined) {
      return;
    }
    setSaving(next);
    setError("");
    try {
      await setAgentTimeZone(next);
      if (alive.current) {
        refocus.current = picking && next !== null;
        setPicking(false);
      }
      notifyLabChanged();
    } catch (reason) {
      if (alive.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (alive.current) {
        setSaving(undefined);
      }
    }
  };

  const busy = saving !== undefined;
  useEffect(() => {
    if (!busy && refocus.current) {
      refocus.current = false;
      pickButton.current?.focus();
    }
  }, [busy]);
  // The popover leaves Escape to an open picker, so Escape closes it from
  // anywhere, not only from inside this section (whose handler goes first).
  useEffect(() => {
    if (!picking) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setPicking(false);
        pickButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);
  // Compact matches the popover's other rows and its segmented switch.
  const segment = (on: boolean) =>
    compact
      ? `inline-flex min-w-0 flex-auto items-center justify-center rounded px-1.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          on ? "bg-content/10 font-semibold text-content" : "text-content/60 hover:text-content"
        }`
      : `inline-flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-medium disabled:opacity-40 ${
          on ? "bg-selection text-content" : "text-content/55 hover:bg-selection-hover hover:text-content"
        }`;

  const head = compact ? (
    <>
      <div className="flex min-h-5 items-center gap-2">
        <span className="font-medium text-content">Agents' time zone</span>
        <time
          dateTime={now.toISOString()}
          title={zoneLabel(zone, now)}
          className="ml-auto shrink-0 tabular-nums text-content/55"
        >
          {formatTime(now, zone)} {shortZone(zone, now)}
        </time>
      </div>
      <p className="-mt-1 text-[11px] leading-snug text-content/45">
        The clock new agents see, here and on the lab.
      </p>
    </>
  ) : (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-content/50">Agents' time</span>
      <div className="flex min-w-0 items-baseline gap-2">
        <time
          dateTime={now.toISOString()}
          className="shrink-0 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-content"
        >
          {formatTime(now, zone)}
        </time>
        <span className="min-w-0 truncate text-[13px] text-content/60">{zoneLabel(zone, now)}</span>
      </div>
    </div>
  );

  const switcher = (
    <div
      role="group"
      aria-label="Agents' time zone"
      className={
        compact
          ? "flex min-w-0 gap-0.5 rounded-md bg-content/5 p-0.5"
          : "flex min-w-0 items-center gap-1 text-[12px]"
      }
    >
      <button
        type="button"
        aria-pressed={following}
        disabled={busy}
        className={segment(following)}
        title="Agents use whatever zone this Mac is in, and move with it"
        onClick={() => {
          setPicking(false);
          if (!following) {
            void choose(null);
          }
        }}
      >
        <span className="truncate">Follow this Mac ({cityLabel(mac)})</span>
      </button>
      <button
        ref={pickButton}
        type="button"
        aria-pressed={!following}
        aria-expanded={picking}
        disabled={busy}
        className={segment(!following)}
        onClick={() => setPicking(!picking)}
      >
        <span className="truncate">{following ? "Pick a zone" : cityLabel(zone)}</span>
      </button>
    </div>
  );

  const lines = (hosts ?? []).map((host) => hostLine(host, target));
  const shownError = error || (readError && !value ? readError : "");

  return (
    <div
      data-fork-agent-tz=""
      className={compact ? "flex flex-col gap-1.5" : "flex flex-col gap-3 rounded-xl bg-content/3 px-4 py-4"}
      onKeyDown={(event) => {
        if (picking && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setPicking(false);
          pickButton.current?.focus();
        }
      }}
    >
      {compact ? null : (
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-content">Agents' time zone</h3>
          <span className="shrink-0 text-[12px] text-content/55">
            {following ? "Follows this Mac" : "Picked zone"}
          </span>
        </div>
      )}
      {head}
      {switcher}
      {picking ? (
        <ZonePicker
          compact={compact}
          mac={mac}
          current={value?.zone ?? null}
          saving={typeof saving === "string" ? saving : null}
          now={now}
          onPick={(next) => void choose(next)}
        />
      ) : null}
      {shownError ? (
        <p role="alert" className="text-[12px] leading-relaxed text-red-500">
          {shownError}
        </p>
      ) : null}
      {lines.length ? (
        <ul className={`flex flex-col gap-0.5 ${compact ? "text-[11px] text-content/45" : quiet}`}>
          {lines.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      {compact ? null : (
        <p className={quiet}>New agent sessions start in this zone; running ones keep theirs.</p>
      )}
    </div>
  );
}

function ZonePicker({
  compact,
  mac,
  current,
  saving,
  now,
  onPick,
}: {
  compact: boolean;
  mac: string;
  current: string | null;
  saving: string | null;
  now: Date;
  onPick: (zone: string) => void;
})
{
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  // Names and offsets for every zone, worked out once per hour.
  const hour = Math.floor(now.getTime() / 3_600_000);
  const entries = useMemo(() => {
    const zones = new Set(listZones());
    zones.add(mac);
    if (current) {
      zones.add(current);
    }
    return zoneEntries([...zones].sort(), new Date(hour * 3_600_000));
  }, [hour, mac, current]);
  const quick = useMemo(() => [...new Set([mac, ...readRecentZones()])].slice(0, 5), [mac]);
  const results = useMemo(() => filterZones(entries, query).slice(0, LIST_MAX), [entries, query]);
  const index = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(index - 1, 0));
    } else if (event.key === "Home" && results.length) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && results.length) {
      event.preventDefault();
      setActive(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[index];
      if (entry) {
        onPick(entry.zone);
      }
    }
  };

  const option = (entry: ZoneEntry, at: number) => {
    const selected = entry.zone === current;
    return (
      <li
        key={entry.zone}
        id={`${id}-${at}`}
        data-index={at}
        role="option"
        aria-selected={selected}
        className={`flex cursor-default items-baseline gap-2 rounded-md px-2 py-1 ${
          at === index ? "bg-selection text-content" : "text-content/75"
        }`}
        onMouseEnter={() => setActive(at)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPick(entry.zone)}
      >
        <span className={`min-w-0 truncate ${selected ? "font-semibold text-accent" : ""}`}>{entry.city}</span>
        {entry.region ? <span className="min-w-0 truncate text-content/40">{entry.region}</span> : null}
        <span className="ml-auto shrink-0 tabular-nums text-content/45">
          {saving === entry.zone ? "Saving…" : entry.abbr ? `${entry.abbr} · ${entry.offset}` : entry.offset}
        </span>
      </li>
    );
  };

  return (
    <div className={`flex flex-col gap-2 ${compact ? "text-[11px]" : "text-[12px]"}`}>
      <div className="flex items-center gap-2 rounded-lg bg-content/5 px-2 py-1.5 focus-within:bg-content/8">
        <Search className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} aria-hidden />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={results.length ? `${id}-${index}` : undefined}
          aria-autocomplete="list"
          aria-label="Find a time zone"
          placeholder="City, region, IST or +5:30"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/35"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
      </div>
      {query ? null : (
        <div className="flex flex-wrap items-center gap-1" aria-label="Quick picks" role="group">
          {quick.map((zone) => (
            <button
              key={zone}
              type="button"
              disabled={saving !== null}
              aria-pressed={zone === current}
              title={zone === mac ? `${zoneLabel(zone, now)}, where this Mac is now` : zoneLabel(zone, now)}
              className={`rounded-md px-2 py-0.5 font-medium disabled:opacity-40 ${
                zone === current
                  ? "bg-selection text-accent"
                  : "bg-content/5 text-content/65 hover:bg-selection-hover hover:text-content"
              }`}
              onClick={() => onPick(zone)}
            >
              {cityLabel(zone)}
              {zone === mac ? <span className="font-normal text-content/45"> · this Mac</span> : null}
            </button>
          ))}
        </div>
      )}
      <ul
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label="Time zones"
        className={`flex flex-col overflow-y-auto ${compact ? "max-h-44" : "max-h-60"}`}
      >
        {results.map(option)}
      </ul>
      {results.length ? null : (
        <p className="px-2 text-content/45">No zone matches “{query}”.</p>
      )}
    </div>
  );
}
