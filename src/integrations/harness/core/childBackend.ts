import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Process I/O is supplied by the desktop or a headless host. Provider
 * protocols never need to know which process owns their children. */
export interface ChildBackend {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

let backend: ChildBackend | undefined;

/** The headless host's backend, or undefined on the desktop. */
export function childBackend(): ChildBackend | undefined {
  return backend;
}

export function setChildBackend(next: ChildBackend): void {
  backend = next;
}

/**
 * The desktop's Rust command, or the headless host's stand-in for it when one
 * is configured. Kept apart from `child.ts` so code that must work in both —
 * the usage footer's fetches, `homeDir` — can ask without loading the bridge.
 */
export function invokeHarness<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backend
    ? backend.invoke<T>(command, args)
    : tauriInvoke<T>(command, args);
}
