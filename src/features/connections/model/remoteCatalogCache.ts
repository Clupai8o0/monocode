import type { HostModelCatalog } from "./protocol";

/** A host's model catalog is large and slow to read over a remote link, and
 * rarely changes, so a cached copy shows at once and is refreshed at most
 * this often, or when the user asks or the machine reconnects. */
export const CATALOG_REFRESH_MS = 10 * 60_000;
/** Catalogs kept on disk; each can be a few hundred KB, and local storage
 * also holds the remote outbox, which must always have room. */
const STORED_CATALOGS = 3;

export type CachedCatalog = { at: number; catalog: HostModelCatalog };

const PREFIX = "monocode.remote-catalog.v1:";
const INDEX = "monocode.remote-catalog-index.v1";
const memory = new Map<string, CachedCatalog>();
const loading = new Map<string, Promise<HostModelCatalog>>();
const keyOf = (machineId: string, projectId: string) =>
  JSON.stringify([machineId, projectId]);

const isCatalog = (value: unknown): value is HostModelCatalog =>
  !!value &&
  typeof value === "object" &&
  typeof (value as HostModelCatalog).models === "object" &&
  !!(value as HostModelCatalog).models &&
  typeof (value as HostModelCatalog).errors === "object" &&
  !!(value as HostModelCatalog).errors;

function readIndex(): { key: string; at: number }[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(INDEX) ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is { key: string; at: number } =>
            typeof entry?.key === "string" && typeof entry?.at === "number",
        )
      : [];
  } catch {
    return [];
  }
}

/** The last catalog read for a machine's project, from memory or disk. */
export function cachedRemoteCatalog(
  machineId: string,
  projectId: string,
): CachedCatalog | undefined {
  const key = keyOf(machineId, projectId);
  const known = memory.get(key);
  if (known) return known;
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PREFIX + key) ?? "null",
    );
    const entry = value as CachedCatalog | null;
    if (entry && typeof entry.at === "number" && isCatalog(entry.catalog)) {
      memory.set(key, entry);
      return entry;
    }
  } catch {
    /* an unreadable copy is fetched again */
  }
  return undefined;
}

/** Whether to ask the host again: when forced, with nothing cached, or once
 * the copy is old. A clock set back counts as old. */
export function catalogNeedsRefresh(
  entry: CachedCatalog | undefined,
  now: number,
  force = false,
): boolean {
  return (
    force || !entry || now < entry.at || now - entry.at >= CATALOG_REFRESH_MS
  );
}

export function rememberRemoteCatalog(
  machineId: string,
  projectId: string,
  catalog: HostModelCatalog,
  at = Date.now(),
) {
  const key = keyOf(machineId, projectId);
  memory.set(key, { at, catalog });
  try {
    const index = [
      { key, at },
      ...readIndex().filter((entry) => entry.key !== key),
    ];
    for (const old of index.splice(STORED_CATALOGS))
      localStorage.removeItem(PREFIX + old.key);
    localStorage.setItem(INDEX, JSON.stringify(index));
    localStorage.setItem(PREFIX + key, JSON.stringify({ at, catalog }));
  } catch {
    // Out of room: drop every stored catalog rather than crowd out the
    // outbox. This session keeps its copy in memory.
    try {
      for (const entry of readIndex()) localStorage.removeItem(PREFIX + entry.key);
      localStorage.removeItem(INDEX);
    } catch {
      /* storage is unavailable */
    }
  }
}

/** Drops cached catalogs: one machine's when it is disconnected, or all. */
export function forgetRemoteCatalogs(machineId?: string) {
  const mine = (key: string) =>
    machineId === undefined || (JSON.parse(key) as string[])[0] === machineId;
  for (const key of [...memory.keys()]) if (mine(key)) memory.delete(key);
  try {
    const index = readIndex();
    for (const entry of index)
      if (mine(entry.key)) localStorage.removeItem(PREFIX + entry.key);
    localStorage.setItem(
      INDEX,
      JSON.stringify(index.filter((entry) => !mine(entry.key))),
    );
  } catch {
    /* storage is unavailable */
  }
}

/** Reads the catalog from the host once, however many views ask at the same
 * time, and caches it. A failure leaves the cached copy in place. */
export function fetchRemoteCatalog(
  machineId: string,
  projectId: string,
  request: () => Promise<HostModelCatalog>,
): Promise<HostModelCatalog> {
  const key = keyOf(machineId, projectId);
  const pending = loading.get(key);
  if (pending) return pending;
  const next = request()
    .then((catalog) => {
      // A malformed reply must never replace a good cached copy.
      if (!isCatalog(catalog)) throw new Error("Invalid model catalog");
      rememberRemoteCatalog(machineId, projectId, catalog);
      return catalog;
    })
    .finally(() => loading.delete(key));
  loading.set(key, next);
  return next;
}
