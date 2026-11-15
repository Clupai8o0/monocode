/**
 * Fork: which project a peer message's sender works in, so its card can show
 * that project's icon. The sender's session registry file only exists while
 * it runs, so a found project is kept per message (address and arrival time);
 * the card still shows it after the sender has exited or the app restarts.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  knownLocalProjectPaths,
  matchProjects,
} from "../externalSessions/externalSessionsStore";
import { parsePeerMessage } from "./peerMessage";

const STORE_KEY = "monocode.fork.peerProjects";
const STORE_MAX = 400;
/** A sender not found yet (registry not written) is asked once more after this. */
const RETRY_MS = 5_000;
/**
 * Older messages are not looked up: their sender may have exited and its
 * process id gone to another session, which would show the wrong project.
 */
const LOOKUP_WITHIN_MS = 30 * 60_000;

type Stored = Record<string, string>;

const pending = new Map<string, Promise<string | null>>();

function storeKey(address: string, at: number | undefined): string {
  return `${address}@${at ?? 0}`;
}

function readStore(): Stored {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Stored)
      : {};
  } catch {
    return {};
  }
}

function remember(key: string, cwd: string) {
  try {
    const store = readStore();
    delete store[key];
    store[key] = cwd;
    const keys = Object.keys(store);
    for (const old of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) {
      delete store[old];
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked: the icon is a nicety, so go without it.
  }
}

/** The project a stored lookup found for this message, if any. */
export function storedPeerProject(
  address: string | undefined,
  at: number | undefined,
): string | null {
  if (!address) {
    return null;
  }
  const cwd = readStore()[storeKey(address, at)];
  return typeof cwd === "string" && cwd ? cwd : null;
}

function lookup(address: string, at: number): Promise<string | null> {
  const key = storeKey(address, at);
  let request = pending.get(key);
  if (!request) {
    // Inside a promise, so a throw (no Tauri bridge, bad storage) is a miss.
    request = Promise.resolve()
      .then(() =>
        invoke<string | null>("fork_peer_sender_project", {
          address,
          at,
          projects: matchProjects([], knownLocalProjectPaths()),
        }),
      )
      .then((cwd) => (typeof cwd === "string" && cwd ? cwd : null))
      .catch(() => null)
      .then((cwd) => {
        pending.delete(key);
        if (cwd) {
          remember(key, cwd);
        }
        return cwd;
      });
    pending.set(key, request);
  }
  return request;
}

function recent(at: number | undefined, now: number): at is number {
  return at !== undefined && now - at <= LOOKUP_WITHIN_MS;
}

/**
 * Looks the sender up as soon as its message arrives, while it surely still
 * runs, so a card shown later (a folded trail opened, a restart) has it.
 */
export function notePeerArrival(text: string) {
  const message = parsePeerMessage(text);
  if (message?.from && recent(message.at, Date.now())) {
    void lookup(message.from, message.at);
  }
}

/** The sender's project folder, or null while unknown. */
export function usePeerProject(
  address: string | undefined,
  at: number | undefined,
  enabled = true,
): string | null {
  const [cwd, setCwd] = useState(() =>
    enabled ? storedPeerProject(address, at) : null,
  );
  useEffect(() => {
    if (!enabled || !address) {
      setCwd(null);
      return;
    }
    const stored = storedPeerProject(address, at);
    if (stored) {
      setCwd(stored);
      return;
    }
    if (!recent(at, Date.now())) {
      return;
    }
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = (again: boolean) => {
      void lookup(address, at).then((found) => {
        if (!live) {
          return;
        }
        if (found) {
          setCwd(found);
        } else if (again) {
          retry = setTimeout(() => ask(false), RETRY_MS);
        }
      });
    };
    ask(true);
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [address, at, enabled]);
  return cwd;
}
