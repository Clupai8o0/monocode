import type { RemoteMachine } from "../../features/connections/model/protocol";
import { parseRemotePath } from "../../features/connections/model/remoteProjects";
import {
  SHOW_FRESH_MS,
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

function isInside(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, "");
  return child === base || child.startsWith(`${base}/`) || base === "";
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
  const what = item.kind === "url" ? (item.title ?? item.url ?? item.name) : (item.title ?? item.name);
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

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

/** A link to the sending machine's localhost, pointed at its address. */
export function rewriteLink(
  url: string,
  machine: Pick<RemoteMachine, "endpoint" | "ssh">,
): { url: string; note?: string } | undefined {
  const safe = showableUrl(url);
  if (!safe) {
    return undefined;
  }
  const parsed = new URL(safe);
  if (!isLoopback(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    return { url: safe };
  }
  const address = machineAddress(machine);
  if (!address) {
    return { url: safe };
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
  return /unknown method/i.test(String(error instanceof Error ? error.message : error));
}

/** 3 s doubling to 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(60_000, 3_000 * 2 ** Math.max(0, failures - 1));
}
