import { createMono, findMono, removeMono, updateMono } from "../../features/monos/model/mono";
import { withMonoConfigurationLock } from "../../features/monos/model/monoConfigurationLock";

/**
 * Fork: a Mono the app makes once, with its own name, look and standing
 * instructions (like the Stylist in src/fork/stylist). It starts with no
 * projects. Deleting it keeps it deleted.
 */
export type StarterMono = {
  /** localStorage key that remembers its id. */
  key: string;
  name: string;
  mascot: string;
  color: string;
  soul: string;
};

function loadId(key: string): string | null | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const { id } = raw as Record<string, unknown>;
    return typeof id === "string" ? id : undefined;
  } catch {
    // Unreadable storage: never make a second copy.
    return null;
  }
}

/** Its id while it exists; undefined before it is made or once deleted. */
export function starterMonoId(spec: Pick<StarterMono, "key">): string | undefined {
  const id = loadId(spec.key);
  return id && findMono(id) ? id : undefined;
}

/** Makes the Mono once. Returns its id, or undefined once the user deleted it. */
export function ensureStarterMono(spec: StarterMono): string | undefined {
  const known = loadId(spec.key);
  if (known === null) return undefined;
  if (known !== undefined) return findMono(known) ? known : undefined;
  const mono = createMono([]);
  // Configured before it is marked, so no load sees it without its instructions.
  updateMono(mono.id, (current) => ({
    ...current,
    name: spec.name,
    mascot: spec.mascot,
    color: spec.color,
    // Seeds SOUL.md the first time its files load (see monoFiles.ts).
    instructions: spec.soul,
  }));
  let saved = false;
  try {
    localStorage.setItem(spec.key, JSON.stringify({ id: mono.id }));
    saved = true;
  } catch {
    // Without its state the next launch would make a second one.
  }
  if (findMono(mono.id)?.instructions !== spec.soul || !saved) {
    removeMono(mono.id);
    return undefined;
  }
  return mono.id;
}

/** At launch: one window at a time, so two windows never make two copies. */
export function seedStarterMonos(specs: readonly StarterMono[]): Promise<void> {
  return withMonoConfigurationLock(async () => {
    for (const spec of specs) ensureStarterMono(spec);
  }).catch(() => undefined);
}
