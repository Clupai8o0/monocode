import type { RemoteMachine } from "../../features/connections/model/protocol";
import { parseRemotePath } from "../../features/connections/model/remoteProjects";
import {
  SHOW_FRESH_MS,
  SHOW_SPOOL_MAX_ITEMS,
  SHOWS_WAIT_MAX_MS,
  parseShowItem,
  showableUrl,
  type ShowItem,
  type ShowsNextParams,
} from "./showsModel";

/**
 * Fork: show on the Mac, the pure parts. Which items open by themselves and
 * which wait in a toast, the open rate limit, toast grouping, the localhost
 * rewrite for links, and one `shows.next` round with its saved cursor.
 */

/** Opens by itself at most this many times a minute. */
export const AUTO_OPEN_PER_MINUTE = 5;
/** More waiting toasts than this from one machine fold into one. */
export const TOAST_GROUP_AFTER = 3;
/** Waiting toasts kept per machine; older ones drop. */
export const PENDING_PER_MACHINE = 20;
/** An empty `shows.next` answer faster than this waits before the next poll. */
export const FAST_EMPTY_MS = 1_000;

const PASSIVE_EXTENSIONS = new Set([
  // Markdown and text
  "md", "markdown", "mdx", "txt", "text", "log", "rst",
  // Data
  "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "xml",
  // Images and PDF
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "pdf",
  // HTML, in the sandboxed preview
  "html", "htm",
  // Code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "rb", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "swift", "sh", "bash", "zsh", "fish", "sql",
  "css", "scss", "less", "lua", "php", "pl", "r", "scala", "dart", "vue", "svelte",
  "ini", "conf", "diff", "patch",
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Types safe to open with no click: viewed, never run. LaTeX, Office and
 * unknown types only open from a click. */
export function isPassiveShow(item: Pick<ShowItem, "kind" | "name">): boolean {
  return item.kind === "file" && PASSIVE_EXTENSIONS.has(extensionOf(item.name));
}

export function isInside(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, "");
  // A project at "/" would hold every path: no auto-open there.
  if (base === "") {
    return false;
  }
  return child === base || child.startsWith(`${base}/`);
}

export type OpenContext = {
  /** The machine that sent the item. */
  machine: Pick<RemoteMachine, "environmentId">;
  /** The active project's path (a `remote://` path for a remote one). */
  activeProject?: string;
  /** Host clock now, from the same `shows.next` answer. */
  hostNow: number;
  /** The rate limiter's verdict for one more open. */
  canOpen: boolean;
};

/** Open by itself only when fresh, from the active project's machine and
 * folder, of a passive type, and under the rate limit; otherwise a toast. */
export function decideShow(item: ShowItem, context: OpenContext): "open" | "toast" {
  if (item.kind !== "file" || !isPassiveShow(item) || !context.canOpen) {
    return "toast";
  }
  if (context.hostNow - item.createdAt >= SHOW_FRESH_MS) {
    return "toast";
  }
  const active = context.activeProject ? parseRemotePath(context.activeProject) : undefined;
  if (!active || active.environmentId !== context.machine.environmentId) {
    return "toast";
  }
  return item.cwd && isInside(item.cwd, active.hostPath) ? "open" : "toast";
}

/** A sliding one-minute window. */
export class RateLimit {
  private times: number[] = [];

  constructor(private readonly max = AUTO_OPEN_PER_MINUTE, private readonly windowMs = 60_000)
  {
  }

  allowed(now: number): boolean {
    this.times = this.times.filter((time) => now - time < this.windowMs);
    return this.times.length < this.max;
  }

  take(now: number): boolean {
    if (!this.allowed(now)) {
      return false;
    }
    this.times.push(now);
    return true;
  }
}

export type PendingShow = { machineId: string; label: string; item: ShowItem };

export type ShowToast =
  | { kind: "one"; key: string; label: string; entry: PendingShow }
  | { kind: "group"; key: string; label: string; entries: PendingShow[] };

/** One toast per item, or one per machine when more than three wait. */
export function groupToasts(pending: readonly PendingShow[]): ShowToast[] {
  const byMachine = new Map<string, PendingShow[]>();
  for (const entry of pending) {
    byMachine.set(entry.machineId, [...(byMachine.get(entry.machineId) ?? []), entry]);
  }
  const toasts: ShowToast[] = [];
  for (const [machineId, entries] of byMachine) {
    const label = entries[entries.length - 1].label;
    if (entries.length > TOAST_GROUP_AFTER) {
      toasts.push({ kind: "group", key: `group:${machineId}`, label, entries });
    } else {
      for (const entry of entries) {
        toasts.push({ kind: "one", key: `${machineId}:${entry.item.id}`, label, entry });
      }
    }
  }
  return toasts;
}

/** "Vivobook · Linux sent report.pdf". Plain text. */
export function toastText(toast: ShowToast): string {
  if (toast.kind === "group") {
    return `${toast.label} sent ${toast.entries.length} items`;
  }
  const item = toast.entry.item;
  // A file's real name stays visible: its extension picks the viewer.
  const what =
    item.kind === "url"
      ? (item.title ?? item.url ?? item.name)
      : item.title && item.title !== item.name
        ? `${item.title} (${item.name})`
        : item.name;
  return `${toast.label} sent ${what}`;
}

/** The machine's own address: the endpoint's host, or the SSH target's. */
export function machineAddress(
  machine: Pick<RemoteMachine, "endpoint" | "ssh">,
): string | undefined {
  if (machine.ssh?.target) {
    const target = machine.ssh.target.trim();
    const host = target.slice(target.lastIndexOf("@") + 1).replace(/^\[|\]$/g, "");
    return host || undefined;
  }
  try {
    const host = new URL(machine.endpoint).hostname.replace(/^\[|\]$/g, "");
    return host && !isLoopback(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

function cleanHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function ipv4Parts(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return undefined;
  }
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

/** The IPv4 address inside an IPv4-mapped IPv6 one (`::ffff:7f00:1`). */
function mappedIpv4(host: string): number[] | undefined {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) {
    return ipv4Parts(dotted[1]);
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) {
    return undefined;
  }
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

function v4Of(host: string): number[] | undefined {
  return ipv4Parts(host) ?? mappedIpv4(host);
}

/** The machine's own localhost: 127.0.0.0/8, ::1, ::, 0.0.0.0, mapped
 * loopback, localhost and *.localhost. */
export function isLoopback(rawHost: string): boolean {
  const host = cleanHost(rawHost);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") {
    return true;
  }
  const v4 = v4Of(host);
  return !!v4 && (v4[0] === 127 || v4.every((part) => part === 0));
}

/** A private network address: it means a different machine on each LAN. */
export function isPrivateHost(rawHost: string): boolean {
  const host = cleanHost(rawHost);
  if (host.endsWith(".local")) {
    return true;
  }
  const v4 = v4Of(host);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (!host.includes(":")) {
    return false;
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

export const LOOPBACK_UNKNOWN_NOTE =
  "Not opened: a link to the other machine's localhost, and its address is unknown.";
export const PRIVATE_NOTE = "A private address; it opens on this Mac's network.";

/** A link to the sending machine's localhost, pointed at its address. No
 * `url` means refused, with the reason in `note`. */
export function rewriteLink(
  url: string,
  machine: Pick<RemoteMachine, "endpoint" | "ssh">,
): { url?: string; note?: string } | undefined {
  const safe = showableUrl(url);
  if (!safe) {
    return undefined;
  }
  const parsed = new URL(safe);
  if (!isLoopback(parsed.hostname)) {
    return isPrivateHost(parsed.hostname) ? { url: safe, note: PRIVATE_NOTE } : { url: safe };
  }
  const address = machineAddress(machine);
  if (!address) {
    return { note: LOOPBACK_UNKNOWN_NOTE };
  }
  parsed.hostname = address.includes(":") ? `[${address}]` : address;
  return {
    url: parsed.href,
    note: `Opened at ${address}; the server there must listen on all addresses (0.0.0.0), not only localhost.`,
  };
}

/** Bytes a base64 string decodes to. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

// ---- cursor per machine ----

export type ShowsCursor = { epoch?: string; cursor: number };

const CURSOR_KEY = "monocode.fork.shows.cursor.v1";

export function loadCursor(machineId: string): ShowsCursor {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(CURSOR_KEY) ?? "{}");
    const value = all && typeof all === "object" ? (all as Record<string, unknown>)[machineId] : undefined;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return {
        epoch: typeof record.epoch === "string" ? record.epoch : undefined,
        cursor:
          typeof record.cursor === "number" && Number.isSafeInteger(record.cursor) && record.cursor > 0
            ? record.cursor
            : 0,
      };
    }
  } catch {
    // Blocked storage: start from what the host still queues.
  }
  return { cursor: 0 };
}

export function saveCursor(machineId: string, value: ShowsCursor): void {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(CURSOR_KEY) ?? "{}");
    const next = all && typeof all === "object" && !Array.isArray(all) ? { ...(all as object) } : {};
    localStorage.setItem(CURSOR_KEY, JSON.stringify({ ...next, [machineId]: value }));
  } catch {
    // Kept in memory by the watcher for this run.
  }
}

export type NextRequest = (params: ShowsNextParams) => Promise<unknown>;

/** One `shows.next` round: asks after the saved cursor, checks every item,
 * and returns the new cursor. Another epoch drops the old cursor. */
export async function nextRound(
  request: NextRequest,
  state: ShowsCursor,
  waitMs = SHOWS_WAIT_MAX_MS,
): Promise<{ state: ShowsCursor; items: ShowItem[]; now: number }> {
  const answer = await request({
    after: state.cursor,
    ...(state.epoch ? { epoch: state.epoch } : {}),
    waitMs,
  });
  const record = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  if (typeof record.epoch !== "string" || !record.epoch) {
    throw new Error("shows.next: bad answer");
  }
  const sameEpoch = record.epoch === state.epoch;
  const after = sameEpoch ? state.cursor : 0;
  const items = (Array.isArray(record.items) ? record.items : [])
    .map(parseShowItem)
    .filter((item): item is ShowItem => !!item && item.seq > after)
    .sort((a, b) => a.seq - b.seq);
  const reported =
    typeof record.cursor === "number" && Number.isSafeInteger(record.cursor) ? record.cursor : 0;
  const cursor = Math.max(after, reported, ...items.map((item) => item.seq));
  const now = typeof record.now === "number" ? record.now : Date.now();
  return { state: { epoch: record.epoch, cursor }, items, now };
}

/** True for a host from before shows. */
export function isUnknownMethod(error: unknown): boolean {
  return /unknown method|unsupported host method/i.test(String(error instanceof Error ? error.message : error));
}

/** The newest `max` items of one answer (items are sorted oldest first). */
export function capItems<T>(items: readonly T[], max = SHOW_SPOOL_MAX_ITEMS): T[] {
  return items.length > max ? items.slice(items.length - max) : [...items];
}

/** Adds one waiting toast, replacing the same item and dropping the
 * machine's oldest past `max`. */
export function withPending(
  pending: readonly PendingShow[],
  entry: PendingShow,
  max = PENDING_PER_MACHINE,
): PendingShow[] {
  const next = [
    ...pending.filter((row) => !(row.machineId === entry.machineId && row.item.id === entry.item.id)),
    entry,
  ];
  let extra = next.filter((row) => row.machineId === entry.machineId).length - max;
  return next.filter((row) => {
    if (extra > 0 && row.machineId === entry.machineId) {
      extra -= 1;
      return false;
    }
    return true;
  });
}

/** Pause before the next poll: a fast empty answer waits a second. */
export function idlePauseMs(itemCount: number, elapsedMs: number): number {
  return itemCount === 0 && elapsedMs < FAST_EMPTY_MS ? FAST_EMPTY_MS : 0;
}

/** 3 s doubling to 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(60_000, 3_000 * 2 ** Math.max(0, failures - 1));
}
