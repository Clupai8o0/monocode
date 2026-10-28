/**
 * Fork feature: show on the Mac (host side). Agents send files and links over
 * a Unix socket; the host snapshots files into a spool and the Mac collects
 * them with `shows.next` and `shows.read` on `/rpc`. Shapes and limits live in
 * src/fork/shows/showsModel.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  SHOW_CHUNK_BYTES,
  SHOW_ID_PATTERN,
  SHOW_MAX_FILE_BYTES,
  SHOW_SPOOL_MAX_BYTES,
  SHOW_SPOOL_MAX_ITEMS,
  SHOW_TTL_MS,
  SHOWS_WAIT_MAX_MS,
  showableUrl,
  type ShowItem,
  type ShowRequest,
  type ShowResponse,
  type ShowsNextResult,
  type ShowsReadResult,
} from "../src/fork/shows/showsModel";

const LINE_CAP = 64 * 1024;
const SOCKET_TIMEOUT_MS = 10_000;
const SWEEP_MS = 10 * 60_000;
const ADDS_PER_MINUTE = 20;
const DESKTOP_RECENT_MS = 40_000;
const URL_REPEAT_MS = 60_000;
const UNREACHABLE = "MonoCode host isn't running here, so nothing was sent.";

type SpoolIndex = { epoch: string; seq: number; items: ShowItem[] };

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tex": "application/x-tex",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const newId = () => randomBytes(16).toString("base64url");

const cleanName = (value: string) =>
  basename(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "file";

const inside = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** A name that looks like a key, token or password store. */
export function secretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".key") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".kdbx") ||
    lower.startsWith("id_rsa") ||
    lower.startsWith("id_ed25519") ||
    lower.startsWith("id_ecdsa") ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.includes("credential") ||
    /^auth.*\.json$/.test(lower) ||
    [".netrc", ".npmrc", ".pypirc", ".git-credentials"].includes(lower)
  );
}

/** The default socket: `$XDG_RUNTIME_DIR/monocode-host/show.sock`, else under the data dir. */
export function showSocketPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "monocode-host", "show.sock")
    : join(dataDir, "run", "show.sock");
}

export type HostShowsOptions = {
  dataDir: string;
  /** Host projects, to tag items with the deepest one holding `cwd`. */
  projects?: () => { id: string; cwd: string }[];
  socketPath?: string;
  home?: string;
  now?: () => number;
};

export class HostShows {
  readonly dataDir: string;
  readonly spoolDir: string;
  readonly socketPath: string;
  agentBinDir: string | undefined;
  private index: SpoolIndex;
  private readonly projects: () => { id: string; cwd: string }[];
  private readonly home: string;
  private readonly now: () => number;
  private readonly waiters = new Set<() => void>();
  private recentAdds: number[] = [];
  private lastAsked = 0;
  private server: Server | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private blockedDirs: string[] | undefined;

  constructor(options: HostShowsOptions) {
    this.dataDir = options.dataDir;
    this.spoolDir = join(options.dataDir, "shows");
    this.socketPath = options.socketPath ?? showSocketPath(options.dataDir);
    this.projects = options.projects ?? (() => []);
    this.home = options.home ?? homedir();
    this.now = options.now ?? Date.now;
    mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(this.spoolDir, 0o700);
    }
    this.index = this.load();
  }

  private load(): SpoolIndex {
    try {
      const raw = JSON.parse(readFileSync(join(this.spoolDir, "index.json"), "utf8")) as SpoolIndex;
      if (typeof raw.epoch === "string" && Number.isSafeInteger(raw.seq) && Array.isArray(raw.items)) {
        const items = raw.items.filter(
          (item) =>
            item &&
            SHOW_ID_PATTERN.test(item.id) &&
            (item.kind === "url" || existsSync(join(this.spoolDir, item.id))),
        );
        return { epoch: raw.epoch, seq: raw.seq, items };
      }
    } catch {
      /* a new spool */
    }
    for (const name of readdirSync(this.spoolDir)) {
      rmSync(join(this.spoolDir, name), { force: true, recursive: true });
    }
    const fresh = { epoch: newId(), seq: 0, items: [] };
    this.index = fresh;
    this.save();
    return fresh;
  }

  private save(): void {
    const path = join(this.spoolDir, "index.json");
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.index), { mode: 0o600 });
    renameSync(temp, path);
  }

  get epoch(): string {
    return this.index.epoch;
  }

  items(): ShowItem[] {
    return [...this.index.items];
  }

  private remove(item: ShowItem): void {
    this.index.items = this.index.items.filter((entry) => entry !== item);
    if (item.kind === "file") {
      rmSync(join(this.spoolDir, item.id), { force: true });
    }
  }

  /** Drops expired items, then the oldest until under the caps. */
  sweep(): void {
    const now = this.now();
    for (const item of [...this.index.items]) {
      if (now - item.createdAt > SHOW_TTL_MS) {
        this.remove(item);
      }
    }
    const bytes = () => this.index.items.reduce((sum, item) => sum + (item.size ?? 0), 0);
    while (
      this.index.items.length > SHOW_SPOOL_MAX_ITEMS ||
      (this.index.items.length > 0 && bytes() > SHOW_SPOOL_MAX_BYTES)
    ) {
      this.remove(this.index.items[0]);
    }
    this.save();
  }

  private desktopNear(): boolean {
    return this.waiters.size > 0 || this.now() - this.lastAsked < DESKTOP_RECENT_MS;
  }

  private projectFor(cwd: string | undefined): string | undefined {
    if (!cwd) {
      return undefined;
    }
    let best: { id: string; cwd: string } | undefined;
    for (const project of this.projects()) {
      if (inside(cwd, project.cwd) && (!best || project.cwd.length > best.cwd.length)) {
        best = project;
      }
    }
    return best?.id;
  }

  private blocked(): string[] {
    if (!this.blockedDirs) {
      const dirs = [
        join(this.home, ".ssh"),
        join(this.home, ".gnupg"),
        join(this.home, ".aws"),
        join(this.home, ".config", "gcloud"),
        "/proc",
        "/sys",
        "/dev",
        "/etc",
        "/private/etc",
        this.dataDir,
      ];
      const real: string[] = [];
      for (const dir of dirs) {
        try {
          real.push(realpathSync(dir));
        } catch {
          /* missing */
        }
      }
      this.blockedDirs = [...new Set([...dirs, ...real])];
    }
    return this.blockedDirs;
  }

  private isSecret(path: string): boolean {
    if (secretName(basename(path))) {
      return true;
    }
    if (
      path === join(this.home, ".claude", ".credentials.json") ||
      path === join(this.home, ".codex", "auth.json")
    ) {
      return true;
    }
    return this.blocked().some((dir) => inside(path, dir));
  }

  private takeRate(): boolean {
    const now = this.now();
    this.recentAdds = this.recentAdds.filter((at) => now - at < 60_000);
    if (this.recentAdds.length >= ADDS_PER_MINUTE) {
      return false;
    }
    this.recentAdds.push(now);
    return true;
  }

  private push(item: Omit<ShowItem, "seq">): ShowItem {
    const full = { ...item, seq: ++this.index.seq } as ShowItem;
    this.index.items.push(full);
    this.sweep();
    for (const wake of [...this.waiters]) {
      wake();
    }
    return full;
  }

  async add(request: ShowRequest): Promise<ShowResponse> {
    const fail = (error: string): ShowResponse => ({ ok: false, error });
    if (!request || typeof request !== "object" || request.v !== 1) {
      return fail("Not sent: the request was not understood.");
    }
    const text = (value: unknown, max: number) =>
      typeof value === "string" && value ? value.slice(0, max) : undefined;
    const title = text(request.title, 200);
    const cwd = typeof request.cwd === "string" && isAbsolute(request.cwd) ? request.cwd.slice(0, 1024) : undefined;
    const sessionId = text(request.sessionId, 200);
    const base = { title, cwd, projectId: this.projectFor(cwd), sessionId };
    if (request.kind === "url") {
      const url = showableUrl(request.url);
      if (!url) {
        return fail("Not sent: only http and https links can be shown.");
      }
      const near = this.desktopNear();
      const message = near ? `Sent the link to the Mac: ${url}` : `Queued the link until the Mac connects: ${url}`;
      const repeat = this.index.items.find(
        (item) => item.kind === "url" && item.url === url && this.now() - item.createdAt < URL_REPEAT_MS,
      );
      if (repeat) {
        return { ok: true, id: repeat.id, message };
      }
      if (!this.takeRate()) {
        return fail("Not sent: too many at once; try again in a minute.");
      }
      const item = this.push({
        id: newId(),
        kind: "url",
        name: new URL(url).host.slice(0, 200) || "link",
        url,
        ...base,
        createdAt: this.now(),
      });
      return { ok: true, id: item.id, message };
    }
    if (request.kind !== "file" || typeof request.path !== "string" || !isAbsolute(request.path)) {
      return fail("Not sent: the request was not understood.");
    }
    const given = request.path;
    const shown = cleanName(given);
    if (this.isSecret(resolve(given))) {
      return fail(`Not sent: ${shown} looks like a secret.`);
    }
    let real: string;
    try {
      real = await realpath(given);
    } catch {
      return fail(`Not sent: ${given} was not found.`);
    }
    const name = cleanName(real);
    if (this.isSecret(real)) {
      return fail(`Not sent: ${name} looks like a secret.`);
    }
    const info = await stat(real);
    if (!info.isFile()) {
      return fail(`Not sent: ${name} is not a file.`);
    }
    if (info.size > SHOW_MAX_FILE_BYTES) {
      return fail(`Not sent: ${name} is larger than ${SHOW_MAX_FILE_BYTES / 1024 / 1024} MB.`);
    }
    if (!this.takeRate()) {
      return fail("Not sent: too many at once; try again in a minute.");
    }
    const id = newId();
    const target = join(this.spoolDir, id);
    let size: number;
    try {
      size = await copyCapped(real, target, SHOW_MAX_FILE_BYTES);
    } catch (error) {
      rmSync(target, { force: true });
      return fail(
        error instanceof CapError
          ? `Not sent: ${name} is larger than ${SHOW_MAX_FILE_BYTES / 1024 / 1024} MB.`
          : `Not sent: ${name} could not be read.`,
      );
    }
    for (const older of this.index.items.filter((item) => item.kind === "file" && item.sourcePath === real)) {
      this.remove(older);
    }
    const message = this.desktopNear() ? `Sent to the Mac: ${name}` : `Queued until the Mac connects: ${name}`;
    this.push({
      id,
      kind: "file",
      name,
      size,
      mime: MIME[extname(name).toLowerCase()],
      sourcePath: real,
      ...base,
      createdAt: this.now(),
    });
    return { ok: true, id, message };
  }

  async next(params: Record<string, unknown>): Promise<ShowsNextResult> {
    const sameEpoch = params.epoch === this.index.epoch;
    const after =
      sameEpoch && typeof params.after === "number" && Number.isSafeInteger(params.after) && params.after > 0
        ? params.after
        : 0;
    const waitMs =
      typeof params.waitMs === "number" && Number.isFinite(params.waitMs) && params.waitMs > 0
        ? Math.min(params.waitMs, SHOWS_WAIT_MAX_MS)
        : 0;
    this.lastAsked = this.now();
    const pick = () => this.index.items.filter((item) => item.seq > after);
    if (!pick().length && waitMs > 0) {
      await new Promise<void>((done) => {
        let timer: NodeJS.Timeout;
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          done();
        };
        timer = setTimeout(wake, waitMs);
        this.waiters.add(wake);
      });
      this.lastAsked = this.now();
    }
    return {
      epoch: this.index.epoch,
      items: pick(),
      cursor: this.index.seq,
      now: this.now(),
    };
  }

  async read(params: Record<string, unknown>): Promise<ShowsReadResult> {
    const id = params.id;
    const offset = params.offset ?? 0;
    if (typeof id !== "string" || !SHOW_ID_PATTERN.test(id)) {
      throw new Error("Invalid show id");
    }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("Invalid offset");
    }
    const item = this.index.items.find((entry) => entry.id === id && entry.kind === "file");
    if (!item) {
      throw new Error("That item is no longer on this machine");
    }
    const size = item.size ?? 0;
    if (offset > size) {
      throw new Error("Invalid offset");
    }
    const handle = await open(join(this.spoolDir, item.id), "r");
    try {
      const buffer = Buffer.alloc(Math.min(SHOW_CHUNK_BYTES, size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        offset,
        size,
        done: offset + bytesRead >= size,
      };
    } finally {
      await handle.close();
    }
  }

  /** Opens the agents' socket. Not on Windows. */
  async listen(): Promise<void> {
    if (process.platform === "win32" || this.server) {
      return;
    }
    const folder = dirname(this.socketPath);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    if (existsSync(this.socketPath)) {
      const alive = await new Promise<boolean>((done) => {
        const probe = createConnection(this.socketPath);
        probe.once("connect", () => {
          probe.destroy();
          done(true);
        });
        probe.once("error", () => done(false));
      });
      if (alive) {
        throw new Error(`Another host is already serving ${this.socketPath}`);
      }
      rmSync(this.socketPath, { force: true });
    }
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => done());
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  private serve(socket: Socket): void {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) {
        if (buffer.length > LINE_CAP) {
          socket.destroy();
        }
        return;
      }
      handled = true;
      const line = buffer.slice(0, end);
      void (async () => {
        let response: ShowResponse;
        try {
          response = line.length > LINE_CAP
            ? { ok: false, error: "Not sent: the request was too long." }
            : await this.add(JSON.parse(line) as ShowRequest);
        } catch {
          response = { ok: false, error: "Not sent: the request was not understood." };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  }

  /** Writes `monocode-show`, `xdg-open` and `open` into `<data dir>/agent-bin`. */
  installAgentBin(execPath: string, entry: string): string | undefined {
    if (process.platform === "win32") {
      return undefined;
    }
    const dir = join(this.dataDir, "agent-bin");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o755);
    for (const [name, content] of Object.entries(agentBinScripts(dir, execPath, entry))) {
      const path = join(dir, name);
      let current: string | undefined;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        /* new */
      }
      if (current !== content) {
        writeFileSync(path, content, { mode: 0o755 });
      }
      chmodSync(path, 0o755);
    }
    this.agentBinDir = dir;
    return dir;
  }

  /** Extra environment for an agent the host starts. Empty until installed and listening. */
  agentEnv(sessionId: string, path: string | undefined): Record<string, string> {
    if (!this.agentBinDir || !this.server) {
      return {};
    }
    return {
      PATH: path ? `${this.agentBinDir}${delimiter}${path}` : this.agentBinDir,
      MONOCODE_SHOW_SOCKET: this.socketPath,
      MONOCODE_SESSION_ID: sessionId,
      BROWSER: join(this.agentBinDir, "xdg-open"),
    };
  }

  close(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
    }
    for (const wake of [...this.waiters]) {
      wake();
    }
    if (this.server) {
      this.server.close();
      this.server = undefined;
      rmSync(this.socketPath, { force: true });
    }
  }
}

class CapError extends Error {}

async function copyCapped(source: string, target: string, cap: number): Promise<number> {
  const input = await open(source, "r");
  const output = await open(target, "wx", 0o600);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        break;
      }
      total += bytesRead;
      if (total > cap) {
        throw new CapError();
      }
      await output.write(buffer, 0, bytesRead);
    }
    return total;
  } finally {
    await input.close();
    await output.close();
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The shim scripts, by file name. */
export function agentBinScripts(dir: string, execPath: string, entry: string): Record<string, string> {
  const real = `real() {
  name=$1
  shift
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    case "$dir" in
      ""|${shellQuote(dir)}|${shellQuote(dir + "/")}) continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      IFS=$old_ifs
      exec "$dir/$name" "$@"
    fi
  done
  IFS=$old_ifs
  echo "$name: not found" >&2
  exit 127
}
`;
  const head = "#!/bin/sh\n# Written by MonoCode host: sends files and links to MonoCode on the Mac.\n";
  const show = shellQuote(join(dir, "monocode-show"));
  return {
    "monocode-show": `${head}exec ${shellQuote(execPath)} ${shellQuote(entry)} show "$@"\n`,
    "xdg-open": `${head}${real}
if [ "\${MONOCODE_SHOW:-}" = off ] || [ -z "\${MONOCODE_SHOW_SOCKET:-}" ]; then
  real xdg-open "$@"
fi
${show} "$@"
code=$?
if [ "$code" -eq 2 ]; then
  real xdg-open "$@"
fi
exit "$code"
`,
    open: `${head}${real}
pick() {
  target=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -a|-b|--env|--stdin|--stdout|--stderr|--arch)
        shift
        [ $# -gt 0 ] && shift
        ;;
      --args) break ;;
      -*) shift ;;
      *)
        target=$1
        shift
        ;;
    esac
  done
  printf '%s' "$target"
}
if [ "\${MONOCODE_SHOW:-}" = off ] || [ -z "\${MONOCODE_SHOW_SOCKET:-}" ]; then
  real open "$@"
fi
target=$(pick "$@")
if [ -z "$target" ]; then
  real open "$@"
fi
${show} "$target"
code=$?
if [ "$code" -eq 2 ]; then
  real open "$@"
fi
exit "$code"
`,
  };
}

let active: HostShows | undefined;

/** The host's shows service, made on first use. */
export function hostShows(options: HostShowsOptions): HostShows {
  if (!active || active.dataDir !== options.dataDir) {
    active = new HostShows(options);
  }
  return active;
}

/** Agent env for a host-started session; empty when shows are not running. */
export function showsAgentEnv(sessionId: string, path: string | undefined): Record<string, string> {
  return active ? active.agentEnv(sessionId, path) : {};
}

function sendLine(socketPath: string, request: ShowRequest): Promise<ShowResponse | undefined> {
  return new Promise((done) => {
    let buffer = "";
    let settled = false;
    const finish = (value: ShowResponse | undefined) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        done(value);
      }
    };
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish(undefined));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        try {
          finish(JSON.parse(buffer.slice(0, end)) as ShowResponse);
        } catch {
          finish(undefined);
        }
      }
    });
    socket.once("error", () => finish(undefined));
    socket.once("close", () => finish(undefined));
  });
}

/**
 * `monocode-host show <file|url>... [--title T]`. Returns the exit code:
 * 0 sent, 1 refused, 2 host not reachable.
 */
export async function runShowCommand(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; socketPath: string; print: (line: string) => void },
): Promise<number> {
  let title: string | undefined;
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title") {
      title = args[++i];
    } else if (args[i] === "--") {
      targets.push(...args.slice(i + 1));
      break;
    } else {
      targets.push(args[i]);
    }
  }
  if (!targets.length) {
    options.print("Use: monocode-show <file|url>... [--title T]");
    return 1;
  }
  let code = 0;
  for (const target of targets) {
    const url = /^https?:\/\//i.test(target) ? showableUrl(target) : undefined;
    let path: string | undefined;
    if (!url) {
      try {
        path = /^file:\/\//i.test(target) ? fileURLToPath(target) : resolve(options.cwd, target);
      } catch {
        options.print(`Not sent: ${target} is not a file or an http link.`);
        code = 1;
        continue;
      }
    }
    const response = await sendLine(options.socketPath, {
      v: 1,
      kind: url ? "url" : "file",
      ...(url ? { url } : { path }),
      ...(title ? { title } : {}),
      cwd: options.cwd,
      ...(options.env.MONOCODE_SESSION_ID ? { sessionId: options.env.MONOCODE_SESSION_ID } : {}),
    });
    if (!response) {
      options.print(UNREACHABLE);
      return 2;
    }
    options.print(response.ok ? response.message : response.error);
    if (!response.ok) {
      code = 1;
    }
  }
  return code;
}
