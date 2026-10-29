import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Clock, Search } from "../../shared/ui/icons";
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
  type ZoneEntry,
} from "./agentTimeZone";
import type { AgentTimeZoneStatus } from "./labProtocol";
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

export function hostLine(host: AgentTimeZoneHost, target: string): string {
  if (!host.online) {
    return `${host.name} offline`;
  }
  if (!host.tzCapable) {
    return `${host.name} needs a host update for this`;
  }
  if (host.timeZone?.zone === target) {
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
    setSaving(next);
    setError("");
    try {
      await setAgentTimeZone(next);
      if (alive.current) {
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
  const segment = (on: boolean) =>
    `inline-flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-medium disabled:opacity-40 ${
      on ? "bg-selection text-content" : "text-content/55 hover:bg-selection-hover hover:text-content"
    }`;

  const clock = (
    <div className={`flex min-w-0 items-baseline gap-2 ${compact ? "text-[12px]" : ""}`}>
      {compact ? <Clock className="size-3.5 shrink-0 self-center text-content/45" strokeWidth={1.75} aria-hidden /> : null}
      <span className={compact ? "text-content/50" : "sr-only"}>Agents' time</span>
      <time
        dateTime={now.toISOString()}
        className={`shrink-0 font-semibold tabular-nums text-content ${compact ? "" : "text-[22px] leading-none tracking-tight"}`}
      >
        {formatTime(now, zone)}
      </time>
      <span className={`min-w-0 truncate ${compact ? "text-content/60" : "text-[13px] text-content/60"}`}>
        {zoneLabel(zone, now)}
      </span>
    </div>
  );

  const switcher = (
    <div
      role="group"
      aria-label="Agents' time zone"
      className={`flex min-w-0 items-center gap-1 ${compact ? "text-[11px]" : "text-[12px]"}`}
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
      className={compact ? "flex flex-col gap-2" : "flex flex-col gap-3 rounded-xl bg-content/3 px-4 py-4"}
    >
      {compact ? null : (
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-content">Agents' time zone</h3>
          <span className="shrink-0 text-[12px] text-content/55">
            {following ? "Follows this Mac" : "Picked zone"}
          </span>
        </div>
      )}
      {compact ? (
        clock
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-content/50">Agents' time</span>
          {clock}
        </div>
      )}
      {switcher}
      {picking ? (
        <ZonePicker
          compact={compact}
          mac={mac}
          current={value?.zone ?? null}
          saving={typeof saving === "string" ? saving : null}
          now={now}
          onPick={(next) => void choose(next)}
          onClose={() => setPicking(false)}
        />
      ) : null}
      {shownError ? (
        <p role="alert" className="text-[12px] leading-relaxed text-red-500">
          {shownError}
        </p>
      ) : null}
      {lines.length ? (
        <ul className={`flex flex-col gap-0.5 ${compact ? "text-[11px] text-content/50" : quiet}`}>
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
  onClose,
}: {
  compact: boolean;
  mac: string;
  current: string | null;
  saving: string | null;
  now: Date;
  onPick: (zone: string) => void;
  onClose: () => void;
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
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
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
