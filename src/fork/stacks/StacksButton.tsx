import { openDevicePanel, type Device } from "../device/deviceModel"; // Fork
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, RefreshCw } from "../../shared/ui/icons";
import { useMachineHost, useMachineSignal } from "../machines/machinesStore";
import {
  isForgotten,
  parseSnapshot,
  rowDetail,
  stopQuestion,
  upCount,
  type StackRow,
  type StacksSnapshot,
} from "./stacksModel";

const POLL_MS = 60_000;

/**
 * Lets the footer keep its right-hand group for this button. Off under the
 * test runner, so upstream footer tests don't see an extra button or invoke.
 */
export const FORK_STACKS = import.meta.env.MODE !== "test";

// --- Store: one poll for every footer that shows the button ---------------

type Store = {
  snapshot: StacksSnapshot | null;
  /** stacks.py isn't on this Mac: the button stays hidden. */
  missing: boolean;
  loading: boolean;
  error: string | null;
};

let current: Store = {
  snapshot: null,
  missing: false,
  loading: false,
  error: null,
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let inFlightForced = false;
let queuedForced: Promise<void> | null = null;

function set(next: Partial<Store>) {
  current = { ...current, ...next };
  for (const listener of listeners) {
    listener();
  }
}

export function refreshStacks(force = false): Promise<void> {
  if (inFlight) {
    if (force && !inFlightForced) {
      // A cached poll cannot satisfy an explicit Refresh. Coalesce repeated
      // clicks into one fresh read after it settles, including after failure.
      queuedForced ??= inFlight.then(() => {
        queuedForced = null;
        return refreshStacks(true);
      });
      return queuedForced;
    }
    return inFlight;
  }
  inFlightForced = force;
  set({ loading: true });
  inFlight = invoke<unknown>("fork_stacks_list", { force })
    .then((value) => {
      if (value === null) {
        set({ missing: true, snapshot: null, error: null });
        return;
      }
      const snapshot = parseSnapshot(value);
      set(
        snapshot
          ? { snapshot, missing: false, error: null }
          : { error: "stacks.py printed something unexpected" },
      );
    })
    .catch((e: unknown) => set({ error: String(e) }))
    .finally(() => {
      inFlight = null;
      inFlightForced = false;
      set({ loading: false });
    });
  return inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    void refreshStacks();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshStacks();
      }
    }, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function useStacks(): Store {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

// --- UI ----------------------------------------------------------------------

/**
 * The Stacks tab of the footer's Machines chip: a list of the shared stacks and
 * devices, who holds each, and a Stop for the running ones.
 */
export function StacksButton() {
  return FORK_STACKS ? <Stacks /> : null;
}

function Stacks() {
  const { snapshot, missing, loading, error } = useStacks();
  const host = useMachineHost("stacks");
  const open = host !== null;
  const count = snapshot ? upCount(snapshot) : 0;
  const forgotten = snapshot?.rows.some(isForgotten) ?? false;
  const label = count > 0 ? `Stacks · ${count} up` : "Stacks";
  useMachineSignal("stacks", {
    tone: forgotten ? "amber" : null,
    why: forgotten ? `${label}: one was started by hand and nobody is using it.` : "",
    detail: missing || !snapshot ? "" : label,
  });
  useEffect(() => {
    if (open) {
      void refreshStacks();
    }
  }, [open]);
  if (!host) {
    return null;
  }
  return createPortal(
    missing || (!snapshot && !error) ? (
      <p className="p-3 text-[12px] text-content/50">
        {missing ? "Stacks aren't set up on this machine." : "Checking stacks…"}
      </p>
    ) : (
      <StacksPanel label={label} snapshot={snapshot} loading={loading} error={error} />
    ),
    host,
  );
}

function StacksPanel({
  label,
  snapshot,
  loading,
  error,
}: {
  label: string;
  snapshot: StacksSnapshot | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 p-2 text-[12px]">
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="font-semibold tabular-nums text-content">{label}</span>
        <span className="text-content/45">
          {snapshot
            ? `${snapshot.runtime} ${snapshot.up ? "up" : "not running"}`
            : ""}
        </span>
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-content/45 hover:bg-content/10 hover:text-content"
          title="Refresh"
          aria-label="Refresh stacks"
          onClick={() => void refreshStacks(true)}
        >
          {loading ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      {error ? <p className="px-1 text-red-300">{error}</p> : null}
      {snapshot?.rows.map((row) => (
        <Row key={row.name} row={row} />
      ))}
      {snapshot && snapshot.loose.length > 0 ? (
        <div className="mt-2 px-1">
          <p className="pb-0.5 text-[11px] font-medium text-content/45">
            Not in a stack
          </p>
          {snapshot.loose.map((c) => (
            <p
              key={c.name}
              className="truncate text-content/55"
              title={c.status}
            >
              {c.name}
              <span className="text-content/35"> · {c.status}</span>
            </p>
          ))}
        </div>
      ) : null}
      {snapshot?.looseError ? (
        <p className="px-1 text-[11px] text-content/45">
          {snapshot.looseError}
        </p>
      ) : null}
    </div>
  );
}

type StopState =
  | { step: "idle" }
  | { step: "asking"; question: string }
  | { step: "stopping" }
  | { step: "failed"; message: string };

// Kept outside the row, so a stop still shows as running after the popover
// closes and opens again.
const stopping = new Set<string>();

function Row({ row }: { row: StackRow }) {
  const [stop, setStop] = useState<StopState>(
    stopping.has(row.name) ? { step: "stopping" } : { step: "idle" },
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const running = row.state === "running";
  const forgotten = isForgotten(row);

  const doStop = () => {
    stopping.add(row.name);
    setStop({ step: "stopping" });
    invoke<string>("fork_stacks_stop", { name: row.name })
      .then(() => {
        if (mounted.current) {
          setStop({ step: "idle" });
        }
      })
      .catch((e: unknown) => {
        if (mounted.current) {
          setStop({ step: "failed", message: String(e) });
        }
      })
      .finally(() => {
        stopping.delete(row.name);
        void refreshStacks();
      });
  };

  return (
    <div
      data-fork-stack={row.name}
      className={`flex flex-col gap-1 rounded-md px-1.5 py-1 ${running ? "" : "opacity-50"}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            running
              ? forgotten
                ? "bg-amber-400"
                : "bg-emerald-400"
              : "bg-content/30"
          }`}
          aria-hidden
        />
        <span className="min-w-0 truncate font-medium text-content">
          {row.name}
        </span>
        {row.kind !== "stack" ? (
          <span className="shrink-0 text-[10px] text-content/40">
            {row.kind}
          </span>
        ) : null}
        {/* Fork: a running device can be watched beside the session. */}
        {running && (row.kind === "ios" || row.kind === "android") ? (
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-1.5 text-[11px] font-medium text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => openDevicePanel(row.kind as Device["kind"])}
          >
            Show
          </button>
        ) : null}
        {running && stop.step !== "asking" ? (
          <button
            type="button"
            disabled={stop.step === "stopping"}
            className={`${row.kind === "stack" ? "ml-auto " : ""}shrink-0 rounded px-1.5 text-[11px] font-medium text-content/55 hover:bg-red-400/15 hover:text-red-300 disabled:opacity-60 disabled:hover:bg-transparent`}
            onClick={() => {
              const question = stopQuestion(row);
              if (question) {
                setStop({ step: "asking", question });
              } else {
                doStop();
              }
            }}
          >
            {stop.step === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
      <p
        className={`truncate pl-3.5 text-[11px] ${forgotten ? "text-amber-300" : "text-content/50"}`}
        title={rowDetail(row)}
      >
        {rowDetail(row)}
      </p>
      {stop.step === "asking" ? (
        <div className="flex items-center gap-2 pl-3.5 text-[11px]">
          <span className="min-w-0 flex-1 text-amber-300">{stop.question}</span>
          <button
            type="button"
            className="shrink-0 rounded bg-red-400/20 px-1.5 font-semibold text-red-200 hover:bg-red-400/30"
            onClick={doStop}
          >
            Stop
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-1.5 text-content/55 hover:bg-content/10"
            onClick={() => setStop({ step: "idle" })}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {stop.step === "failed" ? (
        <p className="pl-3.5 text-[11px] text-red-300">{stop.message}</p>
      ) : null}
    </div>
  );
}
