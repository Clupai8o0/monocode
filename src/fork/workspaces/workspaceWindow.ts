import { getCurrentWindow } from "@tauri-apps/api/window";

/** Fork: workspace windows are labelled `ws-<slug>` (src-tauri/src/fork_workspaces.rs). */
export const WORKSPACE_LABEL_PREFIX = "ws-";

export function workspaceSlugOfLabel(label: string): string | null {
  if (!label.startsWith(WORKSPACE_LABEL_PREFIX)) {
    return null;
  }
  const slug = label.slice(WORKSPACE_LABEL_PREFIX.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) ? slug : null;
}

let label: string | null | undefined;

/** This webview's window label; it never changes, so it is read once. */
function windowLabel(): string | null {
  if (label === undefined) {
    try {
      label = getCurrentWindow().label || null;
    } catch {
      // No Tauri (the test runner): behave like the main window.
      label = null;
    }
  }
  return label;
}

/** The workspace this window shows, or null for `main` / `window-N`. */
export function currentWorkspaceSlug(): string | null {
  const own = windowLabel();
  return own ? workspaceSlugOfLabel(own) : null;
}

const WORKSPACE_COMMANDS = {
  workspace_set_snapshot: "fork_workspace_save",
  workspace_get_snapshot: "fork_workspace_load",
  session_set_in_flight: "fork_workspace_set_in_flight",
  session_list_in_flight: "fork_workspace_list_in_flight",
} as const;

export type StoreCommand = keyof typeof WORKSPACE_COMMANDS;

/**
 * Fork: the store command for this window. A workspace window keeps its
 * layout and interrupted turns in its own row; Rust reads which one from the
 * calling window, so the arguments stay the same.
 */
export function storeCommand(
  command: StoreCommand,
  slug: string | null = currentWorkspaceSlug(),
): string {
  return slug ? WORKSPACE_COMMANDS[command] : command;
}

/** Test hook. */
export function setWindowLabelForTest(next: string | null | undefined): void {
  label = next;
}
