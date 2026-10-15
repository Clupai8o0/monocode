import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentWorkspaceSlug } from "./workspaceWindow";

/** Fork: one row per named workspace (src-tauri/src/fork_workspaces.rs). */
export type WorkspaceRow = {
  slug: string;
  name: string;
  /** Reopens at launch. */
  open: boolean;
  /** Has a window in this process, maybe hidden. */
  live: boolean;
  updatedAt: number;
};

/** Off under the test runner, so upstream tests see no new IPC or button. */
export const FORK_WORKSPACES = import.meta.env.MODE !== "test";

export function listWorkspaces(): Promise<WorkspaceRow[]> {
  return invoke<WorkspaceRow[]>("fork_workspace_list");
}

export function createWorkspace(name: string): Promise<string> {
  return invoke<string>("fork_workspace_create", { name });
}

export function openWorkspace(slug: string): Promise<void> {
  return invoke("fork_workspace_open", { slug });
}

export function renameWorkspace(slug: string, name: string): Promise<void> {
  return invoke("fork_workspace_rename", { slug, name });
}

export function deleteWorkspace(slug: string): Promise<void> {
  return invoke("fork_workspace_delete", { slug });
}

export function openWorkspaceChrome(slug: string): Promise<void> {
  return invoke("fork_workspace_chrome", { slug });
}

// ---- This window's workspace name, for the footer and the window title ----

let name: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function setName(next: string | null): void {
  if (next === name) {
    return;
  }
  name = next;
  listeners.forEach((fn) => fn());
}

export function workspaceName(): string | null {
  return name;
}

export function subscribeWorkspaceName(fn: () => void): () => void {
  listeners.add(fn);
  if (!loaded && FORK_WORKSPACES && currentWorkspaceSlug()) {
    loaded = true;
    void invoke<string | null>("fork_workspace_current")
      .then((value) => setName(value ?? null))
      .catch(() => undefined);
    void listen<string>("fork_workspace_renamed", ({ payload }) =>
      setName(payload),
    ).catch(() => undefined);
  }
  return () => {
    listeners.delete(fn);
  };
}

/** "Uni · 2 need you · chat" — the workspace name goes first when there is one. */
export function titleWithWorkspace(
  title: string,
  workspace: string | null,
): string {
  if (!workspace) {
    return title;
  }
  return title ? `${workspace} · ${title}` : workspace;
}

// ---- One session, one window ----

/** Same ids in any order count as no change. */
export function sessionIdsKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join("\n");
}

/**
 * Fork: tell Rust which sessions this window has open, so another window
 * asked to open one of them sends the user here instead of driving the same
 * agent from two places.
 */
/** Rust asks the window holding a session to show it (`fork_claim_session`). */
export const OPEN_SESSION_EVENT = "fork_open_session";

export function useWindowSessions(ids: readonly string[]): void {
  const key = sessionIdsKey(ids);
  useEffect(() => {
    if (!FORK_WORKSPACES) {
      return;
    }
    // At once, not debounced: a gap would let another window open a session
    // this one just restored. Chained, so reports land in order.
    const ids = key ? key.split("\n") : [];
    reporting = reporting
      .then(() => invoke("fork_window_sessions_set", { ids }))
      .catch(() => undefined);
  }, [key]);
}

let reporting: Promise<unknown> = Promise.resolve();

/**
 * Fork: call before this window opens a session. True when another window
 * already has it: that window is brought forward and shows it, and the
 * caller should stop. False means this window now holds it. `focus: false`
 * (background work) only reports, and moves no window.
 */
export async function focusSessionElsewhere(
  sessionId: string,
  focus = true,
): Promise<boolean> {
  if (!FORK_WORKSPACES) {
    return false;
  }
  try {
    return await invoke<boolean>("fork_claim_session", { sessionId, focus });
  } catch {
    return false;
  }
}
