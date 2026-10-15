/**
 * Fork feature: the shared Docker stacks and devices that every session on
 * this Mac leases through the vault's `stacks.py`. This file reads its
 * `list --json` output into rows for the footer's Stacks panel.
 */

export type Holder = { name: string; why: string; session: string | null };

export type StackRow = {
  name: string;
  /** "stack" for a Docker stack, else the device kind (ios, android). */
  kind: string;
  state: "running" | "stopped" | "unknown";
  /** Running, but not started by stacks.py: the reaper leaves it for hours. */
  byHand: boolean;
  holders: Holder[];
  idleMin: number | null;
};

export type LooseContainer = {
  name: string;
  status: string;
  project: string | null;
};

export type StacksSnapshot = {
  runtime: string;
  up: boolean;
  rows: StackRow[];
  loose: LooseContainer[];
  looseError: string | null;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function holders(value: unknown): Holder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .map((h) => ({
      name: str(h.name) || "?",
      why: str(h.why),
      session: str(h.session) || null,
    }));
}

function row(value: unknown, kind: string | null): StackRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const r = value as Record<string, unknown>;
  const name = str(r.name);
  if (!name) {
    return null;
  }
  const raw = str(r.state);
  const state =
    raw === "running" || raw === "booted"
      ? "running"
      : raw === "stopped" || raw === "off"
        ? "stopped"
        : "unknown";
  return {
    name,
    kind: kind ?? (str(r.kind) || "device"),
    state,
    byHand: r.byHand === true,
    holders: holders(r.holders),
    idleMin: typeof r.idleMin === "number" ? r.idleMin : null,
  };
}

/** Reads `stacks.py list --json`; null when it isn't that shape. */
export function parseSnapshot(value: unknown): StacksSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.stacks)) {
    return null;
  }
  const devices = Array.isArray(v.devices) ? v.devices : [];
  const loose = Array.isArray(v.loose) ? v.loose : [];
  return {
    runtime: str(v.runtime) || "docker",
    up: v.up === true,
    rows: [
      ...v.stacks.map((s) => row(s, "stack")),
      ...devices.map((d) => row(d, null)),
    ].filter((r): r is StackRow => r !== null),
    loose: loose
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        name: str(c.name),
        status: str(c.status),
        project: str(c.project) || null,
      }))
      .filter((c) => c.name),
    looseError: str(v.looseError) || null,
  };
}

export function upCount(snapshot: StacksSnapshot): number {
  return snapshot.rows.filter((r) => r.state === "running").length;
}

/** Running, started by hand, and nobody holds it: likely forgotten. */
export function isForgotten(row: StackRow): boolean {
  return row.state === "running" && row.byHand && row.holders.length === 0;
}

/** Stopping a stack someone holds asks first, naming them. */
export function stopQuestion(row: StackRow): string | null {
  if (row.holders.length === 0) {
    return null;
  }
  const names = [...new Set(row.holders.map((h) => h.name))];
  const who =
    names.length <= 2
      ? names.join(" and ")
      : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `${who} ${names.length === 1 ? "is" : "are"} using this. Stop anyway?`;
}

/** One short line under the name: who holds it, or why it stands out. */
export function rowDetail(row: StackRow): string {
  if (row.state === "unknown") {
    return "state unknown (docker call failed)";
  }
  if (row.state === "stopped") {
    return row.holders.length > 0
      ? `stopped, leased by ${row.holders.map((h) => h.name).join(", ")}`
      : "stopped";
  }
  if (isForgotten(row)) {
    return "started by hand, nobody using it";
  }
  if (row.holders.length === 0) {
    return row.idleMin !== null
      ? `nobody using it, idle ${row.idleMin} min`
      : "nobody using it";
  }
  return row.holders
    .map((h) => (h.why ? `${h.name} (${h.why})` : h.name))
    .join(", ");
}
