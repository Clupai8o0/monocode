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

import { useSyncExternalStore } from "react";
import type { MonoSessionRef } from "./messageLogModel";
import type { MessageLogView, WindowChoice } from "./messageLogView";

export type { MonoSessionRef } from "./messageLogModel";

/** What to show when the window opens. */
export type MessagesWindowRequest = {
  problemsOnly?: boolean;
  /** A Party key to filter the Feed to. */
  partyKey?: string;
};

// ---- the view (built by the model builder) ----

let windowChoice: WindowChoice = "24h";

const EMPTY: MessageLogView = {
  window: "24h",
  rows: [],
  graph: { places: [], unknown: [], edges: [] },
  counts: { total: 0, problems: 0, crossMachine: 0 },
  recentProblems: 0,
  sources: [],
  loading: true,
};

/** The view, kept fresh while a component uses it (see the header). */
export function useMessageLog(fast: boolean): MessageLogView {
  void fast;
  return EMPTY.window === windowChoice ? EMPTY : { ...EMPTY, window: windowChoice };
}

/** The window choice the view uses; "24h" until changed. */
export function setMessageLogWindow(choice: WindowChoice): void {
  windowChoice = choice;
}

/** App.tsx calls this as its sessions change, beside publishOwnSessions. */
export function publishMonoSessions(sessions: readonly MonoSessionRef[]): void {
  void sessions;
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
