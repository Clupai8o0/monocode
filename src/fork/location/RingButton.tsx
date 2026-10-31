import { useState, useSyncExternalStore } from "react";
import { MapPin, X } from "../../shared/ui/icons";
import {
  addPlace,
  FORK_LOCATION,
  formatDistance,
  locationStatus,
  openLocationSettings,
  removePlace,
  ringSentence,
  setRingMode,
  subscribeLocation,
  type LocationStatus,
  type RingMode,
} from "./location";

const MODES: { mode: RingMode; label: string; title: string }[] = [
  {
    mode: "places",
    label: "At my places",
    title: "Ring only at a saved place",
  },
  { mode: "always", label: "Always", title: "Ring everywhere" },
  { mode: "never", label: "Never", title: "Never ring; banners still show" },
];

/** Off (null) when location isn't in use, under the test runner. */
export function useRingStatus(): LocationStatus | null {
  const status = useSyncExternalStore(
    subscribeLocation,
    locationStatus,
    locationStatus,
  );
  return FORK_LOCATION ? status : null;
}

/** Something's wrong with the sounds, rather than it being a quiet place. */
export function ringAlert(status: LocationStatus | null): boolean {
  return (
    !!status &&
    (!!status.error ||
      (status.mode === "places" &&
        (status.permission === "denied" || status.permission === "off")))
  );
}

/**
 * Fork: alert sounds, in the footer's More chip. Alerts ring only at saved
 * places (home, or any place added here); elsewhere banners still show without
 * a sound.
 */
export function RingPanel({ status }: { status: LocationStatus }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    void work()
      .then(() => after?.())
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const add = (useAddress: boolean) =>
    run(
      () => addPlace(name, useAddress ? address : null),
      () => {
        setName("");
        setAddress("");
      },
    );

  const locationOff =
    status.permission === "denied" || status.permission === "off";
  const shown = error ?? status.error;

  return (
    <div data-fork-ring="" className="flex flex-col gap-2 p-2 text-[12px]">
      <div className="flex flex-col gap-0.5 px-1">
        <span className="font-semibold text-content">Alert sounds</span>
        <span className="text-content/60">{ringSentence(status)}</span>
        {locationOff && status.mode === "places" ? (
          <button
            type="button"
            onClick={() => run(openLocationSettings)}
            className="self-start text-accent hover:underline"
          >
            Open Location Services settings
          </button>
        ) : null}
      </div>

      <div
        role="radiogroup"
        aria-label="When alerts ring"
        className="flex gap-0.5 rounded-md bg-content/5 p-0.5"
      >
        {MODES.map(({ mode, label, title }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={status.mode === mode}
            title={title}
            disabled={busy}
            onClick={() => run(() => setRingMode(mode))}
            className={`flex-1 rounded px-1.5 py-0.5 ${
              status.mode === mode
                ? "bg-content/10 font-semibold text-content"
                : "text-content/60 hover:text-content"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-0.5">
        {status.places.length === 0 ? (
          <span className="px-1.5 py-1 text-content/45">
            No places yet. Add home below.
          </span>
        ) : (
          status.places.map((place) => {
            const here = status.place === place.name;
            const detail = !place.located
              ? "Looking up the address…"
              : (formatDistance(place.distance) ?? `${place.radius} m radius`);
            return (
              <div
                key={place.name}
                data-fork-place-row=""
                className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-content/5"
              >
                <MapPin
                  className={`size-3.5 shrink-0 ${here ? "text-accent" : "text-content/40"}`}
                  strokeWidth={1.75}
                  aria-hidden
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold text-content">
                    {place.name}
                    {here ? (
                      <span className="ml-1.5 font-normal text-accent">
                        here
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="truncate text-content/45"
                    title={place.address ?? "Saved from where you were"}
                  >
                    {detail}
                  </span>
                </span>
                <button
                  type="button"
                  title={`Remove ${place.name}`}
                  aria-label={`Remove ${place.name}`}
                  disabled={busy}
                  onClick={() => run(() => removePlace(place.name))}
                  className="rounded p-1 text-content/50 opacity-0 hover:bg-content/10 hover:text-content group-focus-within:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3.5" strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            );
          })
        )}
      </div>

      <form
        className="flex flex-col gap-1 px-1 pt-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && address.trim()) {
            add(true);
          }
        }}
      >
        <input
          value={name}
          maxLength={40}
          placeholder="Place name, e.g. Uni"
          aria-label="Place name"
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 rounded border border-content/15 bg-transparent px-1.5 py-0.5 text-content outline-none placeholder:text-content/35 focus:border-accent"
        />
        <input
          value={address}
          maxLength={200}
          placeholder="Address or landmark"
          aria-label="Address or landmark"
          onChange={(event) => setAddress(event.target.value)}
          className="min-w-0 rounded border border-content/15 bg-transparent px-1.5 py-0.5 text-content outline-none placeholder:text-content/35 focus:border-accent"
        />
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => add(false)}
            title="Save where this Mac is now"
            className="rounded px-1.5 py-0.5 text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40"
          >
            Use where I am
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || !address.trim()}
            className="rounded px-1.5 py-0.5 text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
      {shown ? (
        <span role="alert" className="px-1 text-red-600 dark:text-red-400">
          {shown}
        </span>
      ) : null}
    </div>
  );
}
