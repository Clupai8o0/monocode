import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { remoteRequest } from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import {
  RateLimit,
  backoffMs,
  base64Bytes,
  capItems,
  decideShow,
  idlePauseMs,
  isUnknownMethod,
  loadCursor,
  nextRound,
  rewriteLink,
  saveCursor,
  withPending,
  type PendingShow,
} from "./showsLogic";
import { SHOW_MAX_FILE_BYTES, SHOWS_WAIT_MAX_MS, type ShowItem, type ShowsReadResult } from "./showsModel";
import { showsOpener } from "./showsOpener";

/**
 * Fork: show on the Mac, the watcher. One loop per machine whose host has
 * the `shows` capability, in one window only (a Web Lock per machine, or the
 * `main` window when locks are missing). Items open by themselves or wait in
 * a toast; files are copied into the app cache first and opened from there.
 * Files are never run or handed to the system opener; a link opens in the
 * browser only from a click.
 */

const NEXT_TIMEOUT_MS = SHOWS_WAIT_MAX_MS + 10_000;
const UNKNOWN_PAUSE_MS = 5 * 60_000;

// ---- toast store ----

let pending: PendingShow[] = [];
const notes = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeShows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pendingShows(): PendingShow[] {
  return pending;
}

export function showNote(key: string): string | undefined {
  return notes.get(key);
}

function addPending(entry: PendingShow) {
  pending = withPending(pending, entry);
  emit();
}

export function dismissShow(machineId: string, itemId?: string): void {
  pending = pending.filter(
    (row) => row.machineId !== machineId || (itemId !== undefined && row.item.id !== itemId),
  );
  emit();
}

// ---- opening ----

const machines = new Map<string, RemoteMachine>();
const downloaded = new Map<string, Promise<string>>();

async function download(machineId: string, item: ShowItem): Promise<string> {
  const key = `${machineId}:${item.id}`;
  let job = downloaded.get(key);
  if (!job) {
    job = (async () => {
      let offset = 0;
      let path = "";
      for (;;) {
        const chunk = await remoteRequest<ShowsReadResult>(machineId, "shows.read", {
          id: item.id,
          offset,
        });
        const data = typeof chunk?.data === "string" ? chunk.data : "";
        const bytes = base64Bytes(data);
        if (
          chunk?.offset !== offset ||
          (!data && !chunk.done) ||
          offset + bytes > (item.size ?? SHOW_MAX_FILE_BYTES)
        ) {
          throw new Error("The file arrived damaged; try again.");
        }
        path = await invoke<string>("fork_shows_cache_write", {
          machineId,
          itemId: item.id,
          name: item.name,
          offset,
          data,
        });
        offset += bytes;
        if (chunk.done) {
          if (offset !== chunk.size || (item.size !== undefined && offset !== item.size)) {
            throw new Error("The file arrived incomplete; try again.");
          }
          return path;
        }
      }
    })();
    downloaded.set(key, job);
    job.catch(() => downloaded.delete(key));
  }
  return job;
}

/** Opens one item, from a click or by itself. */
export async function openShow(entry: PendingShow): Promise<void> {
  const { machineId, item } = entry;
  if (item.kind === "url") {
    const machine = machines.get(machineId);
    const link = item.url && machine ? rewriteLink(item.url, machine) : undefined;
    if (!link) {
      return;
    }
    if (!link.url) {
      throw new Error(link.note ?? "Not opened.");
    }
    if (link.note) {
      notes.set(`${machineId}:${item.id}`, link.note);
    }
    await openUrl(link.url);
    return;
  }
  const opener = showsOpener();
  if (!opener) {
    throw new Error("MonoCode isn't ready to open files yet.");
  }
  opener.openLocalFile(await download(machineId, item));
}

// ---- the loop ----

const limit = new RateLimit();

async function handle(machine: RemoteMachine, label: string, item: ShowItem, hostNow: number) {
  const entry = { machineId: machine.id, label, item };
  const context = {
    machine,
    activeProject: showsOpener()?.activeProject(),
    hostNow,
    canOpen: limit.allowed(Date.now()),
  };
  if (decideShow(item, context) === "open" && limit.take(Date.now())) {
    try {
      await openShow(entry);
      return;
    } catch {
      // Falls back to a toast the user can retry.
    }
  }
  addPending(entry);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

async function loop(machine: RemoteMachine, label: () => string, signal: AbortSignal) {
  let state = loadCursor(machine.id);
  let failures = 0;
  while (!signal.aborted) {
    try {
      const started = Date.now();
      const round = await nextRound(
        (params) => remoteRequest(machine.id, "shows.next", params, NEXT_TIMEOUT_MS),
        state,
      );
      failures = 0;
      if (signal.aborted) {
        return;
      }
      // The cursor moves past every item, but a flood shows only the newest.
      for (const item of capItems(round.items)) {
        await handle(machine, label(), item, round.now);
      }
      state = round.state;
      saveCursor(machine.id, state);
      const pause = idlePauseMs(round.items.length, Date.now() - started);
      if (pause) {
        await sleep(pause, signal);
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (isUnknownMethod(error)) {
        await sleep(UNKNOWN_PAUSE_MS, signal);
        continue;
      }
      failures += 1;
      await sleep(backoffMs(failures), signal);
    }
  }
}

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

/** Watches one machine until `signal` aborts. Only one window watches it. */
export function watchMachine(machine: RemoteMachine, label: () => string, signal: AbortSignal): void {
  machines.set(machine.id, machine);
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    void locks
      .request(`monocode.fork.shows.${machine.id}`, { signal }, () => loop(machine, label, signal))
      .catch(() => {
        // Aborted while waiting for another window's lock.
      });
    return;
  }
  if (isMainWindow()) {
    void loop(machine, label, signal);
  }
}

let pruned = false;

/** Trims the cache once per launch. */
export function pruneShowsCacheOnce(): void {
  if (pruned) {
    return;
  }
  pruned = true;
  void invoke("fork_shows_cache_prune").catch(() => {
    // An older native side without the command: nothing to trim.
  });
}
