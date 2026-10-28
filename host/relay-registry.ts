/**
 * Fork feature: the session relay's files (host side). Reads this machine's
 * live Claude sessions from every account's registry, finds Claude's socket
 * folder, and writes or removes the relay's own registry entries. Real
 * entries are only ever read.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isRelayEntry, type RelayRegistryEntry } from "../src/fork/lab/labProtocol";
import { formats, PID_BASE, PID_SPAN, relayName } from "./relay-core";

/** A live Claude session on this machine that others may message. */
export type LocalSession = {
  sessionId: string;
  account: string;
  name: string;
  cwd: string;
  kind: string;
  status?: string;
  bridgeSessionId?: string;
  version?: string;
  startedAt?: number;
  pid: number;
  /** Its real messagingSocketPath. */
  socket: string;
};

/** An entry the host writes; `writer` tells its own files from a desktop's
 *  on a machine that runs both. */
export type HostRelayEntry = RelayRegistryEntry & {
  monocodeRelay: RelayRegistryEntry["monocodeRelay"] & { writer: "host" };
};

export type Liveness = (pid: number, procStart: string | undefined) => boolean | Promise<boolean>;

const REGISTRY_FILE = /^(\d+)\.json$/;
const CLAUDE_SOCKET = /^\d+(-[0-9a-f]{8})?\.sock$/;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The Claude account folders here: ~/.claude and ~/.claude-exec, plus
 *  ~/.claude-cx when it is there; only folders that exist. */
export async function accountRoots(home: string): Promise<Array<{ account: string; root: string }>> {
  const roots: Array<{ account: string; root: string }> = [];
  for (const account of [".claude", ".claude-exec", ".claude-cx"]) {
    const root = join(home, account);
    if (await exists(root)) roots.push({ account, root });
  }
  return roots;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** One real registry entry as a LocalSession, or null when it is a relay
 *  copy, a parked or spare process, speaks another peer protocol, has no
 *  process start to check, or names a socket Claude would not make. */
export function localSession(value: unknown, filePid: number, account: string): LocalSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (isRelayEntry(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.pid !== filePid) return null;
  if (raw.spare || raw.parkedJobId !== undefined) return null;
  if (raw.peerProtocol !== 1) return null;
  if (typeof raw.sessionId !== "string" || !formats.sessionId(raw.sessionId)) return null;
  if (typeof raw.cwd !== "string" || !raw.cwd) return null;
  if (raw.procStart === undefined || raw.procStart === null || raw.procStart === "") return null;
  // Only Claude's own sockets: <pid>.sock or <pid>-<8 hex>.sock in a cc-socks folder.
  const socket = raw.messagingSocketPath;
  if (typeof socket !== "string" || !isAbsolute(socket)) return null;
  if (basename(dirname(socket)) !== "cc-socks" || !CLAUDE_SOCKET.test(basename(socket))) return null;
  const session: LocalSession = {
    sessionId: raw.sessionId,
    account,
    name: relayName(typeof raw.name === "string" ? raw.name : undefined, raw.cwd),
    cwd: raw.cwd,
    kind: typeof raw.kind === "string" && formats.kind(raw.kind) ? raw.kind : "interactive",
    pid: filePid,
    socket,
  };
  if (typeof raw.status === "string" && formats.status(raw.status)) session.status = raw.status;
  if (typeof raw.bridgeSessionId === "string" && formats.bridgeSessionId(raw.bridgeSessionId)) {
    session.bridgeSessionId = raw.bridgeSessionId;
  }
  if (typeof raw.version === "string" && formats.version(raw.version)) session.version = raw.version;
  if (typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)) {
    session.startedAt = raw.startedAt;
  }
  return session;
}

/** This machine's live Claude sessions, real entries only, one per id. */
export async function discoverSessions(home: string, isAlive: Liveness): Promise<LocalSession[]> {
  // session_mirror.py copies entries into the other accounts; the account
  // a session belongs to is the one holding the original.
  const mirror = await readJson(join(home, ".local/state/session-mirror.json"));
  const copies = new Set(
    mirror && typeof mirror === "object" ? Object.keys(mirror).map((path) => resolve(path)) : [],
  );
  const bySession = new Map<string, { session: LocalSession; updatedAt: number }>();
  for (const { account, root } of await accountRoots(home)) {
    const folder = join(root, "sessions");
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = REGISTRY_FILE.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid >= PID_BASE) continue;
      if (copies.has(resolve(folder, name))) continue;
      const raw = await readJson(join(folder, name));
      const session = localSession(raw, pid, account);
      if (!session) continue;
      const record = raw as Record<string, unknown>;
      if (!(await isAlive(pid, String(record.procStart)))) continue;
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
      const current = bySession.get(session.sessionId);
      if (!current || updatedAt > current.updatedAt) {
        bySession.set(session.sessionId, { session, updatedAt });
      }
    }
  }
  return [...bySession.values()].map((entry) => entry.session);
}

export type SockDirOptions = {
  env: NodeJS.ProcessEnv;
  uid: number;
  /** Where per-user runtime folders live; /run/user on Linux. */
  runUserRoot?: string;
};

/** Claude's socket folder here: where live sessions' sockets are, else
 *  $XDG_RUNTIME_DIR/cc-socks, else /run/user/<uid>/cc-socks, else
 *  /tmp/cc-socks. */
export async function resolveSockDir(
  sessions: LocalSession[],
  options: SockDirOptions,
): Promise<string> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const dir = dirname(session.socket);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [dir, count] of counts) {
    if (!best || count > (counts.get(best) ?? 0)) best = dir;
  }
  if (best) return best;
  const runtime = options.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, "cc-socks");
  const userRun = join(options.runUserRoot ?? "/run/user", String(options.uid));
  if (await exists(userRun)) return join(userRun, "cc-socks");
  return "/tmp/cc-socks";
}

/** Writes `<pid>.json` into every account's sessions folder: a temp file
 *  then a rename, mode 0600. */
export async function writeEntry(home: string, entry: HostRelayEntry): Promise<void> {
  const text = `${JSON.stringify(entry)}\n`;
  for (const { root } of await accountRoots(home)) {
    const folder = join(root, "sessions");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temp = join(folder, `.${entry.pid}.json.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(temp, text, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, join(folder, `${entry.pid}.json`));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}

function hostWritten(value: unknown): value is HostRelayEntry {
  if (!isRelayEntry(value)) return false;
  const marker = (value as Record<string, unknown>).monocodeRelay;
  return !!marker && typeof marker === "object" && (marker as Record<string, unknown>).writer === "host";
}

function proxyRange(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid >= PID_BASE && pid < PID_BASE + PID_SPAN;
}

/** Removes `<pid>.json` from every account's sessions folder, only where
 *  the host wrote it. */
export async function removeEntry(home: string, pid: number): Promise<void> {
  if (!proxyRange(pid)) return;
  for (const { root } of await accountRoots(home)) {
    const path = join(root, "sessions", `${pid}.json`);
    if (hostWritten(await readJson(path))) await unlink(path).catch(() => undefined);
  }
}

/**
 * Removes every entry an earlier run of the host left, and its socket; real
 * entries and a desktop's copies stay. Answers how many entries went.
 */
export async function cleanHostEntries(home: string): Promise<number> {
  let removed = 0;
  for (const { root } of await accountRoots(home)) {
    const folder = join(root, "sessions");
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = REGISTRY_FILE.exec(name);
      if (!match || !proxyRange(Number(match[1]))) continue;
      const path = join(folder, name);
      const entry = await readJson(path);
      if (!hostWritten(entry)) continue;
      await unlink(path).catch(() => undefined);
      removed++;
      const socket = entry.messagingSocketPath;
      if (typeof socket === "string" && isAbsolute(socket) && basename(socket) === `${match[1]}.sock`) {
        await unlink(socket).catch(() => undefined);
      }
    }
  }
  return removed;
}
