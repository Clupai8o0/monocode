/**
 * Fork feature: keeps the message log fresh and hands the view to React.
 *
 * Polls this Mac (`fork_message_log`, `fork_relay_traffic`) and each
 * connected host that offers MESSAGES_CAPABILITY / RELAY_TRAFFIC_CAPABILITY
 * (`messages.list`, `relay.traffic` through remoteRequest), asking with
 * `since` so answers stay small, merges them (messageLogModel.ts) and builds
 * the view. While the Messages window is open (`useMessageLog(true)`): this
 * Mac every 5 s, hosts every 10 s. Otherwise, while anything uses the view:
 * every 60 s, for the footer button's count. Nothing polls under the test
 * runner, and nothing is written to disk.
 */

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import { formatPeerTime } from "../peerMessages/peerMessage";
import {
  buildMessageLogView,
  mergeLogAnswer,
  mergeTraffic,
  type MonoSessionRef,
  type SourceInput,
} from "./messageLogModel";
import {
  MESSAGES_CAPABILITY,
  RELAY_TRAFFIC_CAPABILITY,
  type MessageLogAnswer,
  type MessageLogParams,
  type RelayTrafficAnswer,
  type RelayTrafficParams,
} from "./messageLogProtocol";
import {
  WINDOW_HOURS,
  type MessageLogView,
  type SourceState,
  type WindowChoice,
} from "./messageLogView";

export type { MonoSessionRef } from "./messageLogModel";

/** What to show when the window opens. */
export type MessagesWindowRequest = {
  problemsOnly?: boolean;
  /** A Party key to filter the Feed to. */
  partyKey?: string;
};

export const MAC_FAST_MS = 5_000;
export const HOST_FAST_MS = 10_000;
export const SLOW_MS = 60_000;
/** The view also shows times ("waiting too long", the last hour's problems),
 *  so a poll rebuilds it at least this often even when nothing came in. */
const REBUILD_MIN_MS = 30_000;
/** How often to ask a host again what it offers. */
const DESCRIBE_EVERY_MS = 5 * 60_000;

let polling = import.meta.env.MODE !== "test";

type Source = {
  state: SourceState;
  error?: string;
  log?: MessageLogAnswer;
  traffic?: RelayTrafficAnswer;
  inFlight: boolean;
};

type Host = Source & {
  machine: RemoteMachine;
  os: string;
  messages: boolean;
  relay: boolean;
  describedAt: number;
};

function newSource(): Source {
  return { state: "loading", inFlight: false };
}

let windowChoice: WindowChoice = "24h";
let mono: readonly MonoSessionRef[] = [];
let mac: Source = newSource();
let macAnswered = false;
let hosts = new Map<string, Host>();
/** Goes up with each host listing; an older listing that lands late is ignored. */
let listing = 0;
let bumpedAt = 0;

const listeners = new Set<() => void>();
let version = 0;
let cached: { version: number; view: MessageLogView } | null = null;

let subscribers = 0;
let fastSubscribers = 0;
let macTimer: ReturnType<typeof setInterval> | null = null;
let hostTimer: ReturnType<typeof setInterval> | null = null;
let timerMode: "off" | "fast" | "slow" = "off";

function bump(): void {
  bumpedAt = Date.now();
  version += 1;
  cached = null;
  for (const listener of listeners) {
    listener();
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether merging `answer` into `prev` (giving `merged`) changed anything
 *  the view shows. An incremental answer with no events and the same
 *  sessions and proxies changes nothing, unless an event aged out. */
function logChanged(
  prev: MessageLogAnswer | undefined,
  answer: MessageLogAnswer,
  merged: MessageLogAnswer,
): boolean {
  return (
    !prev ||
    answer.full ||
    answer.events.length > 0 ||
    prev.epoch !== answer.epoch ||
    prev.machine !== answer.machine ||
    prev.windowHours !== answer.windowHours ||
    prev.events.length !== merged.events.length ||
    !sameJson(prev.sessions, answer.sessions) ||
    !sameJson(prev.proxies, answer.proxies)
  );
}

function trafficChanged(prev: RelayTrafficAnswer | undefined, answer: RelayTrafficAnswer): boolean {
  return (
    !prev ||
    answer.hops.length > 0 ||
    prev.epoch !== answer.epoch ||
    prev.machine !== answer.machine ||
    prev.enabled !== answer.enabled
  );
}

/** Whether a poll should rebuild the view: something changed, or the times
 *  it shows are getting old. */
function due(changed: boolean): boolean {
  return changed || Date.now() - bumpedAt >= REBUILD_MIN_MS;
}

/** Sets a source's state and error; true when either changed. */
function setState(source: Source, state: SourceState, error: string | undefined): boolean {
  const changed = source.state !== state || source.error !== error;
  source.state = state;
  source.error = error;
  return changed;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

function since(answer: { epoch: string; cursor: number } | undefined) {
  return answer ? { epoch: answer.epoch, cursor: answer.cursor } : undefined;
}

function logParams(log: MessageLogAnswer | undefined): MessageLogParams {
  const params: MessageLogParams = { windowHours: WINDOW_HOURS[windowChoice] };
  const from = since(log);
  if (from) {
    params.since = from;
  }
  return params;
}

function trafficParams(traffic: RelayTrafficAnswer | undefined): RelayTrafficParams {
  const from = since(traffic);
  return from ? { since: from } : {};
}

function offers(describe: unknown, capability: string): boolean {
  if (!describe || typeof describe !== "object") {
    return false;
  }
  const capabilities = (describe as Record<string, unknown>).capabilities;
  return Array.isArray(capabilities) && capabilities.includes(capability);
}

function osOf(describe: unknown): string {
  if (!describe || typeof describe !== "object") {
    return "";
  }
  const record = describe as Record<string, unknown>;
  const text = record.osName ?? record.platform;
  return typeof text === "string" ? text.trim().slice(0, 80) : "";
}

async function pollMac(): Promise<void> {
  if (mac.inFlight) {
    return;
  }
  const source = mac;
  source.inFlight = true;
  let changed = !macAnswered;
  try {
    const [log, traffic] = await Promise.all([
      invoke<MessageLogAnswer>("fork_message_log", { params: logParams(source.log) }),
      invoke<RelayTrafficAnswer>("fork_relay_traffic", { params: trafficParams(source.traffic) })
        .catch(() => undefined),
    ]);
    if (source !== mac) {
      return;
    }
    const merged = mergeLogAnswer(source.log, log, Date.now());
    changed = logChanged(source.log, log, merged) || changed;
    source.log = merged;
    if (traffic) {
      changed = trafficChanged(source.traffic, traffic) || changed;
      source.traffic = mergeTraffic(source.traffic, traffic);
    }
    changed = setState(source, "ok", undefined) || changed;
  } catch (error) {
    if (source !== mac) {
      return;
    }
    changed = setState(source, "error", errorText(error)) || changed;
  } finally {
    source.inFlight = false;
    if (source === mac) {
      macAnswered = true;
      if (due(changed)) {
        bump();
      }
    }
  }
}

async function pollHost(host: Host): Promise<void> {
  if (host.inFlight) {
    return;
  }
  host.inFlight = true;
  const id = host.machine.id;
  let changed = false;
  try {
    const now = Date.now();
    if (!host.describedAt || now - host.describedAt > DESCRIBE_EVERY_MS) {
      const describe = await remoteRequest<unknown>(id, "environment.describe", {});
      const os = osOf(describe);
      const messages = offers(describe, MESSAGES_CAPABILITY);
      const relay = offers(describe, RELAY_TRAFFIC_CAPABILITY);
      changed = os !== host.os || messages !== host.messages || relay !== host.relay;
      host.os = os;
      host.messages = messages;
      host.relay = relay;
      host.describedAt = now;
      if (!host.relay) {
        host.traffic = undefined;
      }
    }
    if (!host.messages) {
      changed = setState(host, "old-host", undefined) || changed;
      return;
    }
    const [log, traffic] = await Promise.all([
      remoteRequest<MessageLogAnswer>(id, "messages.list", logParams(host.log)),
      host.relay
        ? remoteRequest<RelayTrafficAnswer>(id, "relay.traffic", trafficParams(host.traffic))
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const merged = mergeLogAnswer(host.log, log, Date.now());
    changed = logChanged(host.log, log, merged) || changed;
    host.log = merged;
    if (traffic) {
      changed = trafficChanged(host.traffic, traffic) || changed;
      host.traffic = mergeTraffic(host.traffic, traffic);
    }
    changed = setState(host, "ok", undefined) || changed;
  } catch (error) {
    // The last answer stays; the view says when it is from.
    changed = setState(host, "offline", errorText(error)) || changed;
    host.describedAt = 0;
  } finally {
    host.inFlight = false;
    if (due(changed) && hosts.get(id) === host) {
      bump();
    }
  }
}

/** Lists the hosts and polls each one not already being polled: every host
 *  has its own in-flight flag, so a slow one does not hold up the rest. */
async function pollHosts(): Promise<void> {
  const mine = ++listing;
  let list: RemoteMachine[];
  try {
    const value = await invoke<RemoteMachine[]>("remote_machines");
    list = Array.isArray(value) ? value : [];
  } catch {
    list = [...hosts.values()].map((host) => host.machine);
  }
  if (mine !== listing) {
    // A newer listing is on its way, or has landed: it polls the hosts.
    return;
  }
  const next = new Map<string, Host>();
  for (const machine of list) {
    const known = hosts.get(machine.id);
    next.set(
      machine.id,
      known
        ? { ...known, machine }
        : { ...newSource(), machine, os: "", messages: false, relay: false, describedAt: 0 },
    );
  }
  const changed =
    next.size !== hosts.size ||
    [...next.values()].some((host) => hosts.get(host.machine.id)?.machine.name !== host.machine.name);
  // Keep the same objects so polls in flight land on them.
  for (const [id, host] of next) {
    const known = hosts.get(id);
    if (known) {
      known.machine = host.machine;
      next.set(id, known);
    }
  }
  hosts = next;
  if (changed) {
    bump();
  }
  await Promise.all([...hosts.values()].map((host) => pollHost(host)));
}

function sourcesNow(): SourceInput[] {
  const out: SourceInput[] = [
    {
      place: { id: "local", label: "This Mac", os: "macOS", local: true },
      state: mac.state,
      error: mac.error,
      log: mac.log,
      traffic: mac.traffic,
    },
  ];
  for (const host of hosts.values()) {
    out.push({
      place: { id: host.machine.id, label: host.machine.name, os: host.os, local: false },
      state: host.state,
      error: host.error,
      log: host.log,
      traffic: host.relay ? host.traffic : undefined,
    });
  }
  return out;
}

function getView(): MessageLogView {
  if (!cached || cached.version !== version) {
    cached = {
      version,
      view: buildMessageLogView({
        window: windowChoice,
        now: Date.now(),
        sources: sourcesNow(),
        mono,
        formatTime: formatPeerTime,
        loading: !macAnswered,
      }),
    };
  }
  return cached.view;
}

function stopTimers(): void {
  if (macTimer) {
    clearInterval(macTimer);
    macTimer = null;
  }
  if (hostTimer) {
    clearInterval(hostTimer);
    hostTimer = null;
  }
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/** Starts, changes or stops the timers to match who is subscribed. */
function updateTimers(): void {
  const mode = !polling || subscribers === 0 ? "off" : fastSubscribers > 0 ? "fast" : "slow";
  if (mode === timerMode) {
    return;
  }
  const wasOff = timerMode === "off";
  const sped = mode === "fast";
  timerMode = mode;
  stopTimers();
  if (mode === "off") {
    return;
  }
  macTimer = setInterval(() => {
    if (!hidden()) {
      void pollMac();
    }
  }, sped ? MAC_FAST_MS : SLOW_MS);
  hostTimer = setInterval(() => {
    if (!hidden()) {
      void pollHosts();
    }
  }, sped ? HOST_FAST_MS : SLOW_MS);
  if (wasOff || sped) {
    void pollMac();
    void pollHosts();
  }
}

function addSubscriber(fast: boolean): () => void {
  subscribers += 1;
  if (fast) {
    fastSubscribers += 1;
  }
  updateTimers();
  return () => {
    subscribers -= 1;
    if (fast) {
      fastSubscribers -= 1;
    }
    updateTimers();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The view, kept fresh while a component uses it (see the header). */
export function useMessageLog(fast: boolean): MessageLogView {
  useEffect(() => addSubscriber(fast), [fast]);
  return useSyncExternalStore(subscribe, getView, getView);
}

/** The window choice the view uses; "24h" until changed. */
export function setMessageLogWindow(choice: WindowChoice): void {
  if (choice === windowChoice) {
    return;
  }
  windowChoice = choice;
  bump();
  if (timerMode !== "off") {
    void pollMac();
    void pollHosts();
  }
}

/** App.tsx calls this as its sessions change, beside publishOwnSessions. */
export function publishMonoSessions(sessions: readonly MonoSessionRef[]): void {
  const same =
    sessions.length === mono.length &&
    sessions.every(
      (ref, index) =>
        ref.id === mono[index].id &&
        ref.providerSessionId === mono[index].providerSessionId &&
        ref.placeId === mono[index].placeId,
    );
  if (same) {
    return;
  }
  mono = sessions.slice();
  bump();
}

// ---- test-only hooks ----

/** Tests only: turns polling on or off and forgets everything. */
export function __resetMessageLogForTests(pollingOn = false): void {
  stopTimers();
  timerMode = "off";
  polling = pollingOn;
  windowChoice = "24h";
  mono = [];
  mac = newSource();
  macAnswered = false;
  hosts = new Map();
  listing += 1;
  subscribers = 0;
  fastSubscribers = 0;
  bump();
}

/** Tests only: one poll of every machine, without timers. */
export async function __pollMessageLogForTests(): Promise<void> {
  await Promise.all([pollMac(), pollHosts()]);
}

/** Tests only: the view right now and the timer mode. */
export function __messageLogStateForTests(): { view: MessageLogView; timers: string } {
  return { view: getView(), timers: timerMode };
}

/** Tests only: subscribes as a component would. */
export function __subscribeMessageLogForTests(fast: boolean): () => void {
  return addSubscriber(fast);
}

// ---- opening the window ----

let request: MessagesWindowRequest | null = null;
const requestListeners = new Set<() => void>();

function setRequest(next: MessagesWindowRequest | null): void {
  request = next;
  for (const listener of requestListeners) {
    listener();
  }
}

function subscribeRequest(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** Opens the Messages window (footer popover, a notification…). */
export function openMessagesWindow(next: MessagesWindowRequest = {}): void {
  setRequest({ ...next });
}

export function closeMessagesWindow(): void {
  setRequest(null);
}

/** The open request; null while the window is closed. */
export function useMessagesWindowRequest(): MessagesWindowRequest | null {
  return useSyncExternalStore(subscribeRequest, () => request, () => request);
}
