import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "../../shared/ui/icons";
import { LAYER } from "../../shared/lib/layers";
import {
  useRemoteMachineOnline,
  useRemoteMachines,
} from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import { machineLabel, useMachineInfo } from "../machines/machineLabel";
import { groupToasts, toastText, type PendingShow, type ShowToast } from "./showsLogic";
import {
  dismissShow,
  openShow,
  pendingShows,
  pruneShowsCacheOnce,
  showNote,
  subscribeShows,
  watchMachine,
} from "./showsWatcher";

/**
 * Fork: show on the Mac. Mounted once in App: watches every connected
 * machine whose host can send files and links, and shows the toasts for the
 * ones that did not open by themselves. Off under the test runner.
 */
export const FORK_SHOWS = import.meta.env.MODE !== "test";

export function ShowsWatcher({ topOffset = 12 }: { topOffset?: number })
{
  const { machines } = useRemoteMachines(FORK_SHOWS);
  useEffect(() => {
    if (FORK_SHOWS) {
      pruneShowsCacheOnce();
    }
  }, []);
  if (!FORK_SHOWS) {
    return null;
  }
  return (
    <>
      {machines.map((machine) => (
        <MachineWatch key={machine.id} machine={machine} />
      ))}
      <ShowToasts topOffset={topOffset} />
    </>
  );
}

function MachineWatch({ machine }: { machine: RemoteMachine })
{
  const info = useMachineInfo(machine.id);
  const online = useRemoteMachineOnline(machine.id);
  const label = machineLabel(machine.name, info?.platform);
  const labelRef = useRef(label);
  labelRef.current = label;
  const enabled = !!info?.shows && online !== false;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    watchMachine(machine, () => labelRef.current, controller.signal);
    return () => controller.abort();
  }, [enabled, machine]);
  return null;
}

function ShowToasts({ topOffset }: { topOffset: number })
{
  const pending = useSyncExternalStore(subscribeShows, pendingShows, pendingShows);
  if (!pending.length) {
    return null;
  }
  // Under the notification pop-ups' column, bottom right.
  return createPortal(
    <div
      aria-live="polite"
      data-fork-shows-toasts=""
      style={{ zIndex: LAYER.toast, bottom: topOffset }}
      className="pointer-events-none fixed right-3 flex w-[min(340px,calc(100vw-24px))] flex-col gap-2"
    >
      {groupToasts(pending).map((toast) => (
        <Toast key={toast.key} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}

function Toast({ toast }: { toast: ShowToast })
{
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const machineId = toast.kind === "one" ? toast.entry.machineId : toast.entries[0].machineId;
  const open = async (entry: PendingShow) => {
    try {
      setError(undefined);
      await openShow(entry);
      const text = showNote(`${entry.machineId}:${entry.item.id}`);
      if (text) {
        setNote(text);
        window.setTimeout(() => dismissShow(entry.machineId, entry.item.id), 8000);
      } else {
        dismissShow(entry.machineId, entry.item.id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn’t open it.");
    }
  };
  return (
    <article
      role="status"
      className="pointer-events-auto relative overflow-hidden rounded-xl bg-background-base/95 px-3.5 py-3 pr-8 shadow-xl ring-1 ring-content/10 backdrop-blur-xl"
    >
      <p className="truncate text-[13px] font-medium text-content/90">{toastText(toast)}</p>
      {toast.kind === "one" && toast.entry.item.sourcePath ? (
        <p className="truncate text-[11px] text-content/45" title={toast.entry.item.sourcePath}>
          {toast.entry.item.sourcePath}
        </p>
      ) : null}
      {toast.kind === "one" && toast.entry.item.kind === "url" ? (
        <p className="truncate text-[11px] text-content/45" title={toast.entry.item.url}>
          {toast.entry.item.url}
        </p>
      ) : null}
      {toast.kind === "group" ? (
        <ul className="mt-1.5 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {toast.entries.map((entry) => (
            <li key={entry.item.id}>
              <button
                type="button"
                onClick={() => void open(entry)}
                className="w-full truncate rounded px-1.5 py-1 text-left text-[12px] text-content/75 hover:bg-content/5"
              >
                {entry.item.title ?? entry.item.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="mt-1 text-[11px] text-content/55">{note}</p> : null}
      {error ? <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">{error}</p> : null}
      <div className="mt-2 flex gap-1.5">
        {toast.kind === "one" ? (
          <button
            type="button"
            onClick={() => void open(toast.entry)}
            className="rounded-md bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-content hover:bg-accent/25"
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            toast.kind === "one"
              ? dismissShow(machineId, toast.entry.item.id)
              : dismissShow(machineId)
          }
          className="rounded-md bg-content/5 px-2.5 py-1 text-[12px] text-content/70 hover:bg-content/10"
        >
          {toast.kind === "one" ? "Dismiss" : "Dismiss all"}
        </button>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() =>
          toast.kind === "one" ? dismissShow(machineId, toast.entry.item.id) : dismissShow(machineId)
        }
        className="absolute right-1.5 top-1.5 rounded p-1 text-content/35 hover:bg-content/10 hover:text-content"
      >
        <X className="size-3" aria-hidden />
      </button>
    </article>
  );
}
