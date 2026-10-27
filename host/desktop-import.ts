import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HostStore } from "./store";
import { readRoster, writeRoster, type RosterMono } from "./mobile-monos";

/**
 * How the desktop showed its projects, brought to a host: each project's
 * name, colour and mascot, the rail's order, and the default model per
 * provider. Kept in `<data dir>/desktop.json`, written by `import-desktop`
 * and read by the phone's catalog.
 */
export type DesktopLooks = {
  /** Project folders in the desktop rail's order. */
  order: string[];
  projects: Record<string, { name?: string; color?: string; mascot?: string }>;
  /** Model id per provider, as the desktop's settings had them. */
  defaultModels: Record<string, string>;
};

const LOOKS_FILE = "desktop.json";

export function readLooks(dataDir: string): DesktopLooks {
  const empty: DesktopLooks = { order: [], projects: {}, defaultModels: {} };
  try {
    const value = JSON.parse(readFileSync(join(dataDir, LOOKS_FILE), "utf8"));
    return {
      order: Array.isArray(value?.order)
        ? value.order.filter((path: unknown) => typeof path === "string")
        : [],
      projects:
        value?.projects && typeof value.projects === "object"
          ? value.projects
          : {},
      defaultModels:
        value?.defaultModels && typeof value.defaultModels === "object"
          ? value.defaultModels
          : {},
    };
  } catch {
    return empty;
  }
}

/** A desktop value from its localStorage, which keeps JSON as strings. */
function stored(storage: Record<string, unknown>, key: string): unknown {
  const value = storage[key];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/** A Mac path on this machine: `/Users/<name>/...` becomes `<home>/...`. */
export function mapPath(path: string, home = homedir()): string {
  const match = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  return match ? `${home}${match[1] ?? ""}` : path;
}

const folder = (path: string) => {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
};

export type ImportSummary = {
  projects: string[];
  missing: string[];
  monos: string[];
};

/**
 * Brings a desktop export (see the README beside it) onto this host: the
 * projects that exist here are listed for the phone with their looks, and the
 * Monos on the desktop's roster are copied, keeping any this host already has.
 * Login secrets are never part of an export, and none are read here.
 */
export function importDesktop(
  exportDir: string,
  dataDir: string,
  store: HostStore,
  home = homedir(),
): ImportSummary {
  const storage = record(
    JSON.parse(readFileSync(join(exportDir, "localstorage.json"), "utf8")),
  );
  const rail = (stored(storage, "monocode.projectRailOrder") as unknown[]) ?? [];
  const locations = Object.keys(record(stored(storage, "monocode.projectLocations")));
  const labels = strings(stored(storage, "monocode:tab-group:labels"));
  const mascots = strings(stored(storage, "monocode:tab-group:mascots"));
  const colors = {
    ...strings(stored(storage, "monocode:tab-group:colors")),
    ...strings(stored(storage, "monocode:tab-group:custom-colors")),
  };
  const macPaths = [
    ...new Set([
      ...(Array.isArray(rail) ? rail.filter((path) => typeof path === "string") : []),
      ...locations,
    ]),
  ] as string[];

  const summary: ImportSummary = { projects: [], missing: [], monos: [] };
  const looks = readLooks(dataDir);
  const order: string[] = [];
  for (const macPath of macPaths) {
    const cwd = folder(mapPath(macPath, home));
    if (!cwd) {
      summary.missing.push(mapPath(macPath, home));
      continue;
    }
    store.addProject(cwd, labels[macPath] ?? basename(cwd));
    order.push(cwd);
    looks.projects[cwd] = {
      ...looks.projects[cwd],
      ...(labels[macPath] ? { name: labels[macPath] } : {}),
      ...(colors[macPath] ? { color: colors[macPath] } : {}),
      ...(mascots[macPath] ? { mascot: mascots[macPath] } : {}),
    };
    summary.projects.push(cwd);
  }
  looks.order = [...order, ...looks.order.filter((path) => !order.includes(path))];
  looks.defaultModels = {
    ...looks.defaultModels,
    ...strings(stored(storage, "monocode.defaultModels")),
  };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, LOOKS_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(looks, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);

  // Monos on the roster; folders left from deleted ones stay behind.
  const monoDir = join(dataDir, "monos");
  const roster = readRoster(monoDir);
  const exported = stored(storage, "monocode:mono-roster");
  for (const entry of Array.isArray(exported) ? exported : []) {
    const mono = record(entry);
    if (
      typeof mono.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(mono.id) ||
      typeof mono.mascot !== "string" ||
      typeof mono.color !== "string" ||
      roster.some((existing) => existing.id === mono.id)
    )
      continue;
    const source = join(exportDir, "monos", mono.id);
    const target = join(monoDir, mono.id);
    if (existsSync(source) && !existsSync(target)) {
      // Whole or not at all, so a failed copy is tried again next time.
      const partial = `${target}.import-${process.pid}`;
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(monoDir, { recursive: true, mode: 0o700 });
      cpSync(source, partial, { recursive: true });
      renameSync(partial, target);
    }
    const projects = (Array.isArray(mono.projects) ? mono.projects : [])
      .filter((path): path is string => typeof path === "string")
      .map((path) => folder(mapPath(path, home)))
      .filter((path): path is string => !!path);
    const imported: RosterMono = {
      id: mono.id,
      ...(typeof mono.name === "string" && mono.name.trim() ? { name: mono.name } : {}),
      mascot: mono.mascot,
      color: mono.color,
      projects,
    };
    roster.push(imported);
    summary.monos.push(mono.id);
  }
  // Read again just before writing, so a session the running host gave a
  // Mono meanwhile is kept; only the new Monos are added.
  if (summary.monos.length) {
    const added = roster.filter((mono) => summary.monos.includes(mono.id));
    const current = readRoster(monoDir);
    writeRoster(monoDir, [
      ...current,
      ...added.filter((mono) => !current.some((entry) => entry.id === mono.id)),
    ]);
  }
  return summary;
}

/** Where the data folder is, from the store's own file. */
export const dataDirOf = (store: HostStore) => dirname(store.attachmentDir);
