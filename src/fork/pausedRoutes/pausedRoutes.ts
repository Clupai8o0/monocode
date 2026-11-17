import { invoke } from "@tauri-apps/api/core";

const REFRESH_MS = 60_000;

let cached: Record<string, string> = {};
let cachedAt = 0;
let inflight: Promise<Record<string, string>> | null = null;

function normalizePaused(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function loadPausedRoutes(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedAt > 0 && now - cachedAt < REFRESH_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const raw = await invoke<unknown>("fork_paused_routes");
      cached = normalizePaused(raw);
    } catch {
      cached = {};
    }
    cachedAt = Date.now();
    inflight = null;
    return cached;
  })();

  return inflight;
}

export function pausedRoutesSnapshot(): Record<string, string> {
  return cached;
}

export function isRoutePaused(
  route: string,
  paused = pausedRoutesSnapshot(),
): boolean {
  for (const key of Object.keys(paused)) {
    if (route.startsWith(key)) return true;
  }
  return false;
}

export function antigravityRoute(nativeId: string): string {
  return `agy:${nativeId}`;
}

/** Test seam. */
export function resetPausedRoutesCache(): void {
  cached = {};
  cachedAt = 0;
  inflight = null;
}