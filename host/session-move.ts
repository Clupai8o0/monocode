/**
 * Fork feature: moving a session between machines, this machine's half. The
 * rules and shapes are in src/fork/sessionMove/sessionMoveProtocol.ts; the
 * Mac's half (src-tauri/src/fork_session_move.rs) does the same. The source's
 * worktree and transcript are only ever read, and never deleted.
 */
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BUNDLE_FILE,
  CHUNK_BYTES,
  LONG_OPS,
  COMMIT_ID,
  CONVO_DIR,
  IGNORED_MAX,
  isClientPath,
  manifestProblem,
  MOVE_ID,
  normalizeRemoteUrl,
  PACK_MAX_BYTES,
  packPathOk,
  PATCH_FILE,
  PROJECT_KEY_MAX,
  SESSION_ID,
  SESSION_NAME,
  UNTRACKED_DIR,
  WRITE_MAX_BASE64,
  type CheckResult,
  type ConfirmResult,
  type InspectResult,
  type MoveAccount,
  type MoveManifest,
  type MoveRemote,
  type PackFile,
  type PackLink,
  type SourceState,
  type StartResult,
  type UnpackCodeResult,
} from "../src/fork/sessionMove/sessionMoveProtocol";
import { isRelayEntry } from "../src/fork/lab/labProtocol";
import { sessionLiveness } from "./external-sessions";
import { runCommand, type CommandRunner } from "./lab-system";

export type SessionMoveEnv = {
  home: string;
  /** Where packs wait, one folder per move. */
  stagingRoot: string;
  run: CommandRunner;
  /** Project folders this host knows, searched first. */
  projects: () => string[];
  isAlive: (pid: number, procStart: string | undefined) => boolean | Promise<boolean>;
  /** The process's command line, or null when it can't be read. */
  commandLine: (pid: number) => Promise<string | null>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** What this machine made for a move, so a failure can remove just that. */
type Made = {
  repo?: string;
  remoteName?: string;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  /** Saved before `git worktree add`; it is only this move's if the add worked. */
  pending?: { worktree: string; branch: string; head: string };
  account?: "main" | "cx";
  /** Files that did not exist before. */
  files: string[];
  /** Files replaced, with where the old copy waits. */
  replaced?: Array<{ path: string; backup: string }>;
  window?: string;
};

const GIT_LONG_MS = 10 * 60_000;
const GIT_MS = 30_000;
const STOP_POLLS = 150;
const STOP_POLL_MS = 100;
const SETTLE_MS = 5_000;
const STALE_MS = 24 * 60 * 60_000;
const SEARCH_DEPTH = 3;
const SEARCH_MAX = 400;
const ROOM_CAP = 90;
const WINDOWS_TRIED = 5;
const GATE_NAME_MAX = 40;
const LAB_TMUX = "lab";
const ACCOUNT_DIRS: Record<"main" | "cx", string> = { main: ".claude", cx: ".claude-exec" };
const REGISTRY_DIRS = [".claude", ".claude-exec", ".claude-cx"];
const SEARCH_SKIP = new Set(["node_modules", ".git", ".claude", "target", "dist", "build", "vendor"]);

const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });

export function defaultSessionMoveEnv(dataDir: string, projects: () => string[]): SessionMoveEnv {
  return {
    home: process.env.HOME ?? "",
    stagingRoot: join(dataDir, "session-move"),
    run: runCommand,
    projects,
    isAlive: (pid, start) => sessionLiveness()(pid, start),
    commandLine: readCommandLine,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
  };
}

async function readCommandLine(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
  } catch {
    const ps = await runCommand("ps", ["-o", "args=", "-p", String(pid)], { timeoutMs: 5_000 });
    return ps.code === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
  }
}

function firstLine(text: string, fallback: string) {
  return (text.trim().split("\n").pop() ?? "").slice(0, 300) || fallback;
}

async function git(env: SessionMoveEnv, cwd: string, args: string[], timeoutMs = GIT_MS) {
  return env.run("git", ["-C", cwd, ...args], { timeoutMs, env: gitEnv() });
}

async function gitOut(env: SessionMoveEnv, cwd: string, args: string[], timeoutMs = GIT_MS) {
  const result = await git(env, cwd, args, timeoutMs);
  if (result.code !== 0) throw new Error(firstLine(result.stderr, `git ${args[0]} failed`));
  return result.stdout;
}

function projectKey(cwd: string) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
  return value;
}

function sessionIdParam(params: Record<string, unknown>) {
  const id = stringParam(params, "sessionId");
  if (!SESSION_ID.test(id)) throw new Error("Invalid session id");
  return id;
}

function moveFolder(env: SessionMoveEnv, params: Record<string, unknown>) {
  const id = stringParam(params, "moveId");
  if (!MOVE_ID.test(id)) throw new Error("Invalid move id");
  return join(env.stagingRoot, id);
}

function nameParam(params: Record<string, unknown>) {
  const name = stringParam(params, "name");
  if (!SESSION_NAME.test(name) || name.includes("..") || /\.lock$/i.test(name))
    throw new Error("Invalid session name");
  return name;
}

async function lexists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes the parents of `root/rel`, refusing any parent that is a link, so a
 * link carried earlier cannot lead a write outside `root`.
 */
async function safeTarget(root: string, rel: string): Promise<string> {
  const parts = rel.split("/");
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    let info;
    try {
      info = await lstat(at);
    } catch {
      await mkdir(at);
      continue;
    }
    if (!info.isDirectory()) throw new Error(`Refused a path through a link: ${rel}`);
  }
  return join(at, parts[parts.length - 1]);
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  let size = 0;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

/** Replaced whole, so a crash never leaves half a record to be read as none. */
async function saveMade(folder: string, made: Made) {
  await mkdir(folder, { recursive: true });
  const temp = join(folder, "made.json.tmp");
  await writeFile(temp, JSON.stringify(made));
  await rename(temp, join(folder, "made.json"));
}

/** Nothing made yet when there is no record; one it can't read is an error. */
async function loadMade(folder: string): Promise<Made> {
  let text: string;
  try {
    text = await readFile(join(folder, "made.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [] };
    throw error;
  }
  return { files: [], ...(JSON.parse(text) as Partial<Made>) };
}

async function dropStale(env: SessionMoveEnv) {
  let names: string[];
  try {
    names = await readdir(env.stagingRoot);
  } catch {
    return;
  }
  for (const name of names) {
    const folder = join(env.stagingRoot, name);
    // An unfinished move's record is what its undo needs, however old.
    if (await lexists(join(folder, "made.json"))) continue;
    const info = await stat(folder).catch(() => null);
    if (info && env.now() - info.mtimeMs > STALE_MS)
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- registry ----

type Live = {
  pid: number;
  procStart?: string;
  status?: string;
  statusUpdatedAt?: number;
  name?: string;
  cwd?: string;
  account: MoveAccount;
};

function accountOfDir(dir: string): MoveAccount {
  if (dir === ".claude") return "main";
  return "cx";
}

/** Every live registry entry for the conversation; a stale one's PID may be reused. */
async function liveRecords(env: SessionMoveEnv, sessionId: string): Promise<Live[]> {
  const found: Live[] = [];
  for (const dir of REGISTRY_DIRS) {
    const folder = join(env.home, dir, "sessions");
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readFile(join(folder, name), "utf8"));
      } catch {
        continue;
      }
      if (isRelayEntry(raw) || raw.sessionId !== sessionId) continue;
      const pid = Number(raw.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const procStart = raw.procStart == null || raw.procStart === "" ? undefined : String(raw.procStart);
      if (!(await env.isAlive(pid, procStart))) continue;
      found.push({
        pid,
        procStart,
        status: typeof raw.status === "string" ? raw.status : undefined,
        statusUpdatedAt: typeof raw.statusUpdatedAt === "number" ? raw.statusUpdatedAt : undefined,
        name: typeof raw.name === "string" ? raw.name : undefined,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
        account: accountOfDir(dir),
      });
    }
  }
  return found;
}

async function liveRecord(env: SessionMoveEnv, sessionId: string): Promise<Live | null> {
  return (await liveRecords(env, sessionId))[0] ?? null;
}

async function samePath(a: string | undefined, b: string) {
  if (!a) return false;
  const [x, y] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return x === y;
}

function toState(env: SessionMoveEnv, record: Live | null): SourceState {
  if (!record) return { state: "gone" };
  let state: SourceState["state"] = "waiting";
  if (record.status === "busy") state = "busy";
  else if (record.status === "idle") {
    // Just gone idle: a queued message may start the next turn.
    const settled = env.now() - (record.statusUpdatedAt ?? 0) >= SETTLE_MS;
    state = settled ? "idle" : "busy";
  }
  return { state, name: record.name, cwd: record.cwd, account: record.account };
}

async function sourceState(env: SessionMoveEnv, params: Record<string, unknown>): Promise<SourceState> {
  return toState(env, await liveRecord(env, sessionIdParam(params)));
}

async function stopSource(env: SessionMoveEnv, params: Record<string, unknown>) {
  const record = await liveRecord(env, sessionIdParam(params));
  if (!record) return { stopped: true };
  if (toState(env, record).state !== "idle") return { stopped: false };
  return { stopped: await endProcess(env, record) };
}

/**
 * Whether the PID is still that session: its start stamp matches, or with no
 * stamp, its command line is Claude's. A bare PID may be something else's by now.
 */
async function identity(env: SessionMoveEnv, record: Live): Promise<"it" | "other" | "unknown"> {
  if (record.procStart) return (await env.isAlive(record.pid, record.procStart)) ? "it" : "other";
  const line = await env.commandLine(record.pid);
  if (line === null) return "unknown";
  return /(^|[\s/])claude(\s|$)|claude-acct/.test(line) ? "it" : "other";
}

/**
 * SIGTERM, then SIGKILL after 15 s, as `claude-acct` stops a session. Each
 * signal waits on knowing it is still that session; not knowing is a refusal.
 */
async function endProcess(env: SessionMoveEnv, record: Live): Promise<boolean> {
  const signal = async (name: NodeJS.Signals): Promise<boolean | null> => {
    const who = await identity(env, record);
    if (who === "other") return true;
    if (who === "unknown") return false;
    try {
      env.kill(record.pid, name);
    } catch {
      // It ended on its own just now.
    }
    return null;
  };
  const first = await signal("SIGTERM");
  if (first !== null) return first;
  for (let poll = 0; poll < STOP_POLLS; poll++) {
    if (!(await env.isAlive(record.pid, record.procStart))) return true;
    await env.sleep(STOP_POLL_MS);
  }
  const last = await signal("SIGKILL");
  if (last !== null) return last;
  await env.sleep(500);
  return !(await env.isAlive(record.pid, record.procStart));
}

// ---- finding things ----

/**
 * The newest copy: after `claude-acct` moved a conversation between accounts,
 * both can hold it, and the older one is missing the latest turns.
 */
async function findTranscript(env: SessionMoveEnv, cwd: string, sessionId: string) {
  const wanted = `${sessionId}.jsonl`;
  const dirs: Array<[string, MoveAccount]> = [
    [".claude", "main"],
    [".claude-exec", "cx"],
    [".claude-cx", "cx"],
  ];
  let best: { home: string; project: string; account: MoveAccount; at: number } | null = null;
  const consider = async (dir: string, account: MoveAccount, project: string) => {
    const info = await stat(join(project, wanted)).catch(() => null);
    if (info && (!best || info.mtimeMs > best.at))
      best = { home: join(env.home, dir), project, account, at: info.mtimeMs };
  };
  for (const [dir, account] of dirs)
    await consider(dir, account, join(env.home, dir, "projects", projectKey(cwd)));
  if (best) return best as { home: string; project: string; account: MoveAccount; at: number };
  for (const [dir, account] of dirs) {
    const root = join(env.home, dir, "projects");
    for (const folder of await readdir(root).catch(() => [] as string[]))
      await consider(dir, account, join(root, folder));
  }
  return best as { home: string; project: string; account: MoveAccount; at: number } | null;
}

async function remotesOf(env: SessionMoveEnv, repo: string): Promise<MoveRemote[]> {
  const result = await git(env, repo, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (result.code !== 0) return [];
  const remotes: MoveRemote[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
    if (match) remotes.push({ name: match[1], url: match[2] });
  }
  return remotes;
}

/** Folders with their own `.git` folder under the projects folder. */
async function searchRepos(env: SessionMoveEnv): Promise<string[]> {
  const found = new Set(env.projects());
  const walk = async (folder: string, depth: number) => {
    if (found.size >= SEARCH_MAX) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === ".git" && entry.isDirectory())) {
      found.add(folder);
      return;
    }
    if (depth === 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SEARCH_SKIP.has(entry.name) && !entry.name.startsWith("."))
        await walk(join(folder, entry.name), depth - 1);
    }
  };
  await walk(join(env.home, "Documents", "projects"), SEARCH_DEPTH);
  return [...found];
}

function homeRelative(path: string) {
  const match = /(Documents\/projects\/.*)$/.exec(path);
  return match ? match[1] : path;
}

/**
 * "client" when the folder, its real path or its git folder is client work, so
 * a link from elsewhere into a client repository is refused too; "unknown"
 * when git can't say where its git folder is.
 */
async function repoKind(env: SessionMoveEnv, repo: string): Promise<"ok" | "client" | "unknown"> {
  const real = await realpath(repo).catch(() => repo);
  if (isClientPath(repo) || isClientPath(real)) return "client";
  const common = await git(env, repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0 || !common.stdout.trim()) return "unknown";
  const dir = common.stdout.trim();
  const realDir = await realpath(dir).catch(() => dir);
  return isClientPath(dir) || isClientPath(realDir) ? "client" : "ok";
}

async function findRepo(
  env: SessionMoveEnv,
  urls: string[],
  sourcePath: string,
): Promise<{ repo: string; remoteName: string; matchedUrl: string } | "client" | null> {
  const wanted = new Map(urls.map((url) => [normalizeRemoteUrl(url), url]));
  const hits: Array<{ repo: string; remoteName: string; matchedUrl: string }> = [];
  let client = false;
  for (const repo of await searchRepos(env)) {
    for (const remote of await remotesOf(env, repo)) {
      const matchedUrl = wanted.get(normalizeRemoteUrl(remote.url));
      if (matchedUrl === undefined) continue;
      const kind = await repoKind(env, repo);
      if (kind === "client") client = true;
      if (kind !== "ok") break;
      hits.push({ repo, remoteName: remote.name, matchedUrl });
      break;
    }
  }
  if (hits.length === 0) return client ? "client" : null;
  const same = hits.find((hit) => sourcePath.startsWith(homeRelative(hit.repo)) || homeRelative(sourcePath).startsWith(homeRelative(hit.repo)));
  return same ?? hits[0];
}

/** "queued" when the gate has no free place, which only means a wait. */
async function gateFull(env: SessionMoveEnv) {
  const gate = await env.run(join(env.home, ".local/bin/agent-gate"), ["status"], { timeoutMs: 10_000 });
  const match = /(\d+) of (\d+) running/.exec(gate.stdout);
  return match ? Number(match[1]) >= Number(match[2]) : false;
}

// ---- ops: source ----

async function inspect(env: SessionMoveEnv, params: Record<string, unknown>): Promise<InspectResult> {
  const cwd = stringParam(params, "cwd");
  const sessionId = sessionIdParam(params);
  const top = await git(env, cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("This session's folder is not a git repository");
  const repoRoot = top.stdout.trim();
  const common = (await gitOut(env, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  if (isClientPath(repoRoot) || isClientPath(common))
    throw new Error("Client work stays on the Mac");
  const found = await findTranscript(env, cwd, sessionId);
  return {
    repoRoot,
    remotes: await remotesOf(env, repoRoot),
    hasTranscript: Boolean(found),
    account: found?.account ?? "main",
  };
}

async function addFile(folder: string, rel: string, files: PackFile[], executable = false) {
  const { sha256, size } = await sha256File(join(folder, rel));
  files.push({ path: rel, size, sha256, ...(executable ? { executable: true } : {}) });
}

async function packTree(source: string, folder: string, rel: string, files: PackFile[]) {
  const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await packTree(from, folder, to, files);
    } else if (entry.isFile()) {
      await mkdir(dirname(join(folder, to)), { recursive: true });
      await copyFile(from, join(folder, to));
      await addFile(folder, to, files);
    }
  }
}

async function pack(env: SessionMoveEnv, params: Record<string, unknown>): Promise<MoveManifest> {
  await dropStale(env);
  const folder = moveFolder(env, params);
  const cwd = stringParam(params, "cwd");
  const sessionId = sessionIdParam(params);
  const remoteName = stringParam(params, "remoteName");
  if (!/^[A-Za-z0-9_.-]+$/.test(remoteName)) throw new Error("Invalid remote name");
  const root = (await gitOut(env, cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (isClientPath(root)) throw new Error("Client work stays on the Mac");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const files: PackFile[] = [];
  const links: PackLink[] = [];
  const head = (await gitOut(env, root, ["rev-parse", "HEAD"])).trim();
  const branch = (await git(env, root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();

  // Commits the remote doesn't have. Git refuses an empty bundle, so ask first.
  const local = await gitOut(env, root, ["rev-list", "--max-count=1", "HEAD", "--not", `--remotes=${remoteName}`]);
  if (local.trim()) {
    await gitOut(
      env,
      root,
      ["bundle", "create", join(folder, BUNDLE_FILE), "HEAD", "--not", `--remotes=${remoteName}`],
      GIT_LONG_MS,
    );
    await addFile(folder, BUNDLE_FILE, files);
  }

  // Staged and unstaged together, with deletions and binary files.
  await gitOut(
    env,
    root,
    [
      "diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--src-prefix=a/", "--dst-prefix=b/", `--output=${join(folder, PATCH_FILE)}`, "HEAD",
    ],
    GIT_LONG_MS,
  );
  const patchInfo = await stat(join(folder, PATCH_FILE));
  if (patchInfo.size > 0) await addFile(folder, PATCH_FILE, files);
  else await rm(join(folder, PATCH_FILE));

  const ignored: string[] = [];
  const untracked = await gitOut(env, root, ["ls-files", "--others", "--exclude-standard", "-z"], GIT_LONG_MS);
  for (const rel of untracked.split("\0").filter(Boolean)) {
    // A folder with its own repository: left behind and named on the card.
    if (rel.endsWith("/")) {
      ignored.push(rel);
      continue;
    }
    const packed = `${UNTRACKED_DIR}/${rel}`;
    if (!packPathOk(packed, sessionId)) {
      ignored.push(rel);
      continue;
    }
    const from = join(root, rel);
    const info = await lstat(from).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      links.push({ path: packed, target: await readlink(from) });
    } else if (info.isFile()) {
      await mkdir(dirname(join(folder, packed)), { recursive: true });
      await copyFile(from, join(folder, packed));
      await addFile(folder, packed, files, (info.mode & 0o111) !== 0);
    }
  }

  const names = await gitOut(
    env,
    root,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"],
    GIT_LONG_MS,
  );
  for (const rel of names.split("\0").filter(Boolean)) {
    if (!rel.startsWith(".claude/worktrees/")) ignored.push(rel);
  }

  const found = await findTranscript(env, cwd, sessionId);
  if (!found) throw new Error("Could not find this session's conversation");
  await packTree(join(found.project, sessionId), folder, `${CONVO_DIR}/session/${sessionId}`, files);
  await packTree(join(found.home, "file-history", sessionId), folder, `${CONVO_DIR}/history/${sessionId}`, files);
  const transcript = `${CONVO_DIR}/session/${sessionId}.jsonl`;
  await mkdir(dirname(join(folder, transcript)), { recursive: true });
  await copyFile(join(found.project, `${sessionId}.jsonl`), join(folder, transcript));
  await addFile(folder, transcript, files);

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > PACK_MAX_BYTES) throw new Error("This session's work is over 2 GB, too big to carry");
  const manifest: MoveManifest = {
    version: 1,
    sessionId,
    head,
    ...(branch ? { branch } : {}),
    sourcePath: cwd,
    files,
    links,
    ignored: ignored.slice(0, IGNORED_MAX),
    ignoredMore: Math.max(0, ignored.length - IGNORED_MAX),
  };
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

async function readPiece(env: SessionMoveEnv, params: Record<string, unknown>) {
  const folder = moveFolder(env, params);
  const path = stringParam(params, "path");
  const offset = Number(params.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")) as MoveManifest;
  if (!manifest.files.some((file) => file.path === path)) throw new Error("That file is not in this move");
  const handle = await open(join(folder, path), "r");
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, offset);
    return { data: buffer.subarray(0, bytesRead).toString("base64") };
  } finally {
    await handle.close();
  }
}

// ---- ops: target ----

async function check(env: SessionMoveEnv, params: Record<string, unknown>): Promise<CheckResult> {
  await dropStale(env);
  const sourcePath = stringParam(params, "sourcePath");
  if (isClientPath(sourcePath)) return { ok: false, reason: "Client work stays on the Mac" };
  const urls = Array.isArray(params.urls) ? params.urls.filter((url): url is string => typeof url === "string") : [];
  if (urls.length === 0) return { ok: false, reason: "This repository has no remote to match on the other machine" };
  const found = await findRepo(env, urls, sourcePath);
  if (found === "client") return { ok: false, reason: "Client work stays on the Mac" };
  if (!found) return { ok: false, reason: "This repository is not on that machine" };
  const queued = await gateFull(env);
  return { ok: true, ...found, ...(queued ? { queued: true } : {}) };
}

async function writePiece(env: SessionMoveEnv, params: Record<string, unknown>) {
  const folder = moveFolder(env, params);
  const sessionId = sessionIdParam(params);
  const path = stringParam(params, "path");
  if (!packPathOk(path, sessionId)) throw new Error(`Refused a file in the move: ${path}`);
  // An empty file has no data, and still has to arrive.
  const data = params.data;
  if (typeof data !== "string") throw new Error("Missing data");
  if (data.length > WRITE_MAX_BASE64) throw new Error("That piece is too big");
  const offset = Number(params.offset);
  await mkdir(folder, { recursive: true });
  const target = await safeTarget(folder, path);
  const size = await lstat(target).then((info) => info.size, () => 0);
  if (offset !== size) throw new Error("The move's pieces arrived out of order");
  await appendFile(target, Buffer.from(data, "base64"));
  return {};
}

async function verifyPack(folder: string, manifest: MoveManifest) {
  for (const file of manifest.files) {
    const { sha256, size } = await sha256File(join(folder, file.path)).catch(() => ({ sha256: "", size: -1 }));
    if (sha256 !== file.sha256 || size !== file.size)
      throw new Error(`A file did not arrive whole: ${file.path}`);
  }
}

async function hasCommit(env: SessionMoveEnv, repo: string, sha: string) {
  return (await git(env, repo, ["cat-file", "-e", `${sha}^{commit}`])).code === 0;
}

async function bringCommits(env: SessionMoveEnv, repo: string, remote: string, folder: string, manifest: MoveManifest) {
  const hasBundle = manifest.files.some((file) => file.path === BUNDLE_FILE);
  if (await hasCommit(env, repo, manifest.head)) return;
  // The remote's own commits first: the bundle builds on them.
  await git(env, repo, ["fetch", "--quiet", remote], GIT_LONG_MS);
  if (hasBundle) await gitOut(env, repo, ["fetch", "--quiet", join(folder, BUNDLE_FILE), "HEAD"], GIT_LONG_MS);
  if (!(await hasCommit(env, repo, manifest.head)))
    throw new Error(`This machine can't get commit ${manifest.head.slice(0, 8)}; push it first`);
}

/**
 * A free name, reserved by making its folder: only one move can make it, so a
 * folder in this move's record is this move's even if it crashed before the add.
 */
async function freePlace(env: SessionMoveEnv, repo: string, name: string) {
  await mkdir(join(repo, ".claude", "worktrees"), { recursive: true });
  for (let n = 1; n < 50; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const worktree = join(repo, ".claude", "worktrees", `moved-${name}${suffix}`);
    const branch = `moved/${name}${suffix}`;
    if ((await git(env, repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) continue;
    try {
      await mkdir(worktree);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    return { worktree, branch };
  }
  throw new Error("Too many moved copies of this session on that machine");
}

async function placeLinks(root: string, manifest: MoveManifest) {
  for (const link of manifest.links) {
    const rel = link.path.slice(UNTRACKED_DIR.length + 1);
    const target = await safeTarget(root, rel);
    if (await lexists(target)) throw new Error(`A carried file is already there: ${rel}`);
    await symlink(link.target, target);
  }
}

async function unpackCode(env: SessionMoveEnv, params: Record<string, unknown>): Promise<UnpackCodeResult> {
  const folder = moveFolder(env, params);
  const name = nameParam(params);
  const manifest = params.manifest as MoveManifest;
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(problem);
  if (!COMMIT_ID.test(manifest.head)) throw new Error("Invalid commit id");
  if (isClientPath(manifest.sourcePath)) throw new Error("Client work stays on the Mac");
  const urls = Array.isArray(params.urls) ? params.urls.filter((url): url is string => typeof url === "string") : [];
  // Found again here: what the app says the repository is isn't trusted.
  const found = await findRepo(env, urls, manifest.sourcePath);
  if (found === "client") throw new Error("Client work stays on the Mac");
  if (!found) throw new Error("This repository is not on that machine");
  await verifyPack(folder, manifest);
  await bringCommits(env, found.repo, found.remoteName, folder, manifest);
  // The real path: it is the one Claude's project key is made from.
  const repo = await realpath(found.repo);
  const { worktree, branch } = await freePlace(env, repo, name);
  const key = projectKey(worktree);
  if (key.length > PROJECT_KEY_MAX) {
    await rmdirQuiet(worktree);
    throw new Error("The new folder's path is too long for Claude to resume in");
  }
  // Saved before the add, so a crash just after it still leaves a record.
  const made: Made = {
    repo,
    remoteName: found.remoteName,
    sessionId: manifest.sessionId,
    files: [],
    pending: { worktree, branch, head: manifest.head },
  };
  await saveMade(folder, made);
  // No hooks: one failing would leave a worktree this move can't tell is its own.
  const added = await git(
    env,
    repo,
    ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "-b", branch, worktree, manifest.head],
    GIT_LONG_MS,
  );
  if (added.code !== 0) {
    // Another move may have taken the name first: that worktree is not this one's.
    // A timed-out add may still have made it, so the claim stays for undo to check.
    if (!added.timedOut) {
      delete made.pending;
      await saveMade(folder, made);
      // The reserved folder, if the add left it empty; never anyone's files.
      await rmdirQuiet(worktree);
    }
    throw new Error(firstLine(added.stderr, "git worktree failed"));
  }
  made.worktree = worktree;
  made.branch = branch;
  delete made.pending;
  await saveMade(folder, made);
  if (manifest.files.some((file) => file.path === PATCH_FILE)) {
    await gitOut(env, worktree, ["apply", "--binary", "--whitespace=nowarn", join(folder, PATCH_FILE)], GIT_LONG_MS);
  }
  for (const file of manifest.files) {
    if (!file.path.startsWith(`${UNTRACKED_DIR}/`)) continue;
    const rel = file.path.slice(UNTRACKED_DIR.length + 1);
    const target = await safeTarget(worktree, rel);
    if (await lexists(target)) throw new Error(`A carried file is already there: ${rel}`);
    await copyFile(join(folder, file.path), target);
    if (file.executable) await chmod(target, 0o755);
  }
  await placeLinks(worktree, manifest);
  return { repo, cwd: worktree, branch };
}

/** An account with room, by what `claude-acct status` prints. */
export function accountHasRoom(status: string, account: "main" | "cx"): boolean {
  for (const line of status.split("\n")) {
    const match = /^(main|cx)\s+(\S+)\s+\S+\s+(?:(\d+)%.*?\s+(\d+)%)?/.exec(line);
    if (!match || match[1] !== account) continue;
    if (match[2] !== "yes" || match[3] === undefined) return false;
    return Math.max(Number(match[3]), Number(match[4])) < ROOM_CAP;
  }
  return false;
}

/** Its own account when that has room, else what `claude-acct` picks. */
async function chooseAccount(env: SessionMoveEnv, wanted: unknown): Promise<"main" | "cx"> {
  const bin = join(env.home, ".local/bin/claude-acct");
  const own = wanted === "cx" ? "cx" : "main";
  const status = await env.run(bin, ["status"], { timeoutMs: 30_000 });
  if (status.code !== 0) return own;
  if (accountHasRoom(status.stdout, own)) return own;
  const pick = await env.run(bin, ["pick", "-q"], { timeoutMs: 30_000 });
  const picked = pick.stdout.trim();
  return picked === "main" || picked === "cx" ? picked : own;
}

async function unpackConversation(env: SessionMoveEnv, params: Record<string, unknown>) {
  const folder = moveFolder(env, params);
  const manifest = params.manifest as MoveManifest;
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(problem);
  const made = await loadMade(folder);
  if (!made.worktree || made.sessionId !== manifest.sessionId) throw new Error("The code has not been carried yet");
  const account = await chooseAccount(env, params.account);
  made.account = account;
  const home = join(env.home, ACCOUNT_DIRS[account]);
  const project = join(home, "projects", projectKey(made.worktree));
  await mkdir(project, { recursive: true });
  const id = manifest.sessionId;
  const transcriptRel = `${CONVO_DIR}/session/${id}.jsonl`;
  const place = async (from: string, root: string, rel: string) => {
    const target = await safeTarget(root, rel);
    if (await lexists(target)) {
      const replaced = (made.replaced ??= []);
      const backup = join(folder, "backup", String(replaced.length));
      await mkdir(dirname(backup), { recursive: true });
      await copyFile(target, backup);
      replaced.push({ path: target, backup });
    } else {
      made.files.push(target);
    }
    await saveMade(folder, made);
    await copyFile(from, target);
  };
  for (const file of manifest.files) {
    if (file.path === transcriptRel) continue;
    if (file.path.startsWith(`${CONVO_DIR}/session/`)) {
      await place(join(folder, file.path), project, file.path.slice(`${CONVO_DIR}/session/`.length));
    } else if (file.path.startsWith(`${CONVO_DIR}/history/`)) {
      const root = join(home, "file-history");
      await mkdir(root, { recursive: true });
      await place(join(folder, file.path), root, file.path.slice(`${CONVO_DIR}/history/`.length));
    }
  }
  // Last: it is what --resume looks for, so a partial copy never passes for whole.
  if (!manifest.files.some((file) => file.path === transcriptRel)) throw new Error("The conversation is missing from the move");
  await place(join(folder, transcriptRel), project, `${id}.jsonl`);
  await saveMade(folder, made);
  return { account };
}

function resumeCommand(env: SessionMoveEnv, sessionId: string, name: string, account: "main" | "cx") {
  const labSession = join(env.home, ".local/bin/lab-session");
  const acct = join(env.home, ".local/bin/claude-acct");
  // Validated ids and names only, so no word here needs more than these quotes.
  return (
    `'${labSession}' _trust "$PWD" || echo "could not mark $PWD trusted" >&2; ` +
    `CLAUDE_ACCT=${account} exec '${acct}' exec --resume '${sessionId}' --name '${name}' ` +
    `--remote-control '${name}' --dangerously-skip-permissions`
  );
}

async function startWindow(
  env: SessionMoveEnv,
  cwd: string,
  sessionId: string,
  base: string,
  account: "main" | "cx",
  trying: (name: string) => Promise<void> = async () => {},
) {
  const labSession = join(env.home, ".local/bin/lab-session");
  let last = "";
  for (let n = 1; n <= WINDOWS_TRIED; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    await trying(name);
    const result = await env.run(
      labSession,
      ["--cmd", resumeCommand(env, sessionId, name, account), name, cwd],
      { timeoutMs: 30_000, env: { ...process.env, PATH: `${join(env.home, ".local/bin")}:${process.env.PATH ?? ""}` } },
    );
    if (result.code === 0) return name;
    last = firstLine(result.stderr, "lab-session failed");
    if (!/already exists/.test(last)) break;
  }
  throw new Error(last || "lab-session failed");
}

/** Resumes on this machine through lab-session, so the gate's limits apply. */
async function start(env: SessionMoveEnv, params: Record<string, unknown>): Promise<StartResult> {
  const folder = moveFolder(env, params);
  const sessionId = sessionIdParam(params);
  const base = nameParam(params);
  const made = await loadMade(folder);
  if (!made.worktree || !made.account || made.sessionId !== sessionId)
    throw new Error("The conversation has not been carried yet");
  // A repeated start gets the launch already made: it may not have registered yet.
  if (made.window && ((await windowAlive(env, made.window)) || (await inGateQueue(env, made.window))))
    return { name: made.window };
  // Two copies must never write one conversation.
  if ((await liveRecord(env, sessionId)) !== null) throw new Error("This conversation is already running on that machine");
  // Recorded before it starts, so an undo can find a window whose start it never heard back from.
  const name = await startWindow(env, made.worktree, sessionId, base, made.account, async (next) => {
    made.window = next;
    await saveMade(folder, made);
  });
  return { name };
}

/**
 * The lab tmux session's windows as name and folder; none when it isn't
 * running. Any other failure throws: a window that couldn't be listed may be alive.
 */
async function labWindows(env: SessionMoveEnv): Promise<Array<{ name: string; path: string }>> {
  const list = await env.run(
    "tmux",
    ["list-windows", "-t", `=${LAB_TMUX}`, "-F", "#{window_name}\t#{pane_current_path}"],
    { timeoutMs: 10_000 },
  );
  if (list.code !== 0) {
    // No tmux on this machine, so no window can be alive.
    if (/spawn tmux ENOENT/.test(list.stderr)) return [];
    if (!list.timedOut && list.code !== null && /can't find session|no server running|error connecting to .*\(No such file or directory\)/i.test(list.stderr)) return [];
    throw new Error(`Could not list that machine's windows: ${firstLine(list.stderr, list.timedOut ? "tmux timed out" : "tmux failed")}`);
  }
  return list.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, path = ""] = line.split("\t");
      return { name, path };
    });
}

/** Whether the window of that name is this move's: another's may share the name. */
async function ownWindow(env: SessionMoveEnv, name: string, worktree: string) {
  for (const window of await labWindows(env)) {
    if (window.name === name && (await samePath(window.path, worktree))) return true;
  }
  return false;
}

async function windowAlive(env: SessionMoveEnv, name: string) {
  return (await labWindows(env)).some((window) => window.name === name);
}

async function inGateQueue(env: SessionMoveEnv, name: string) {
  const gate = await env.run(join(env.home, ".local/bin/agent-gate"), ["status"], { timeoutMs: 10_000 });
  const at = gate.stdout.indexOf(" pos ");
  if (at < 0) return false;
  // The gate keeps the first 40 characters of a name.
  const shown = name.slice(0, GATE_NAME_MAX);
  return gate.stdout
    .slice(at)
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[1] === shown);
}

/** Whether it came up on that session id, not just that a window opened. */
async function confirm(env: SessionMoveEnv, params: Record<string, unknown>): Promise<ConfirmResult> {
  const sessionId = sessionIdParam(params);
  const name = nameParam(params);
  const made = await loadMade(moveFolder(env, params));
  if (!made.worktree || made.sessionId !== sessionId) throw new Error("The conversation has not been carried yet");
  // This move's copy only: another process on the conversation is not it coming up.
  for (const record of await liveRecords(env, sessionId)) {
    if ((await samePath(record.cwd, made.worktree)) || (made.window !== undefined && record.name === made.window))
      return { state: "up" };
  }
  if (await inGateQueue(env, name)) return { state: "queued" };
  if (!(await windowAlive(env, name))) return { state: "failed", detail: "It stopped as it started" };
  return { state: "starting" };
}

/** Puts a lab session back after a failed move. Its transcript never left. */
async function restart(env: SessionMoveEnv, params: Record<string, unknown>): Promise<StartResult> {
  const sessionId = sessionIdParam(params);
  const base = nameParam(params);
  const cwd = stringParam(params, "cwd");
  if ((await liveRecord(env, sessionId)) !== null) return { name: base };
  const found = await findTranscript(env, cwd, sessionId);
  const account = found?.account === "cx" ? "cx" : "main";
  return { name: await startWindow(env, cwd, sessionId, base, account) };
}

/** Removes what this move made here. Only that: never anything older. */
async function undo(env: SessionMoveEnv, params: Record<string, unknown>) {
  const folder = moveFolder(env, params);
  const made = await loadMade(folder);
  if (made.pending) {
    if (await addedByThisMove(env, made.repo, made.pending)) {
      made.worktree = made.pending.worktree;
      made.branch = made.pending.branch;
    } else {
      await rmdirQuiet(made.pending.worktree);
    }
  }
  if (made.window) {
    // Gone first, and known to be: nothing is removed from under a live copy.
    for (const record of made.sessionId && made.worktree ? await liveRecords(env, made.sessionId) : []) {
      const ours = (await samePath(record.cwd, made.worktree!)) || record.name === made.window;
      if (ours && !(await endProcess(env, record))) throw new Error("The copy there would not stop");
    }
    if (made.worktree && (await ownWindow(env, made.window, made.worktree))) {
      await env.run("tmux", ["kill-window", "-t", `=${LAB_TMUX}:=${made.window}`], { timeoutMs: 10_000 });
      if (await ownWindow(env, made.window, made.worktree)) throw new Error("The copy's window there would not close");
    }
  }
  for (const file of made.files) await rm(file, { force: true }).catch(() => undefined);
  for (const old of made.replaced ?? []) await copyFile(old.backup, old.path);
  if (made.account && made.worktree) {
    const home = join(env.home, ACCOUNT_DIRS[made.account]);
    await removeEmpty(join(home, "projects", projectKey(made.worktree)));
    if (made.sessionId) await removeEmpty(join(home, "file-history", made.sessionId));
  }
  if (made.repo && made.worktree) {
    await git(env, made.repo, ["worktree", "remove", "--force", made.worktree], GIT_LONG_MS);
    await rm(made.worktree, { recursive: true, force: true }).catch(() => undefined);
    await git(env, made.repo, ["worktree", "prune"]);
  }
  if (made.repo && made.branch) await git(env, made.repo, ["branch", "-D", made.branch]);
  await rm(folder, { recursive: true, force: true });
  return {};
}

/**
 * A worktree add the record never heard back from is this move's only if git
 * lists it at that path, on that branch, still at the commit it was made from.
 */
async function addedByThisMove(env: SessionMoveEnv, repo: string | undefined, pending: NonNullable<Made["pending"]>) {
  if (!repo) return false;
  const tip = await git(env, repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${pending.branch}`]);
  if (tip.code !== 0 || tip.stdout.trim() !== pending.head) return false;
  const list = await git(env, repo, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return false;
  for (const block of list.stdout.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch (.+)$/m.exec(block)?.[1];
    if (branch === `refs/heads/${pending.branch}` && (await samePath(path, pending.worktree))) return true;
  }
  return false;
}

/** Removes a folder only if it is empty. */
async function rmdirQuiet(folder: string) {
  await rmdir(folder).catch(() => undefined);
}

async function removeEmpty(folder: string) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) if (entry.isDirectory()) await removeEmpty(join(folder, entry.name));
  await rm(folder).catch(() => undefined);
}

async function done(env: SessionMoveEnv, params: Record<string, unknown>) {
  await rm(moveFolder(env, params), { recursive: true, force: true });
  const job = jobs.get(stringParam(params, "moveId"));
  if (job?.settled) jobs.delete(stringParam(params, "moveId"));
  return {};
}

// The desktop gives up on a request after a minute, and these can take longer,
// so they start with `begin` and are asked after with `poll`. One at a time per
// move, and undo waits its turn, so it never races a step still running.
// A finished answer stays until the move's next step, its `done`, or an hour,
// so a poll whose reply was lost gets the same answer again.
type JobEnd = { done: true; result?: unknown; error?: string };
type Job = { op: string; end: Promise<JobEnd>; settled?: JobEnd; settledAt?: number };
const jobs = new Map<string, Job>();
const JOB_KEEP_MS = 60 * 60_000;

function sweepJobs(now: number) {
  for (const [moveId, job] of jobs) {
    if (job.settledAt !== undefined && now - job.settledAt > JOB_KEEP_MS) jobs.delete(moveId);
  }
}

function beginJob(env: SessionMoveEnv, params: Record<string, unknown>) {
  const inner = params.inner as Record<string, unknown> | undefined;
  const op = inner?.op;
  if (typeof op !== "string" || !LONG_OPS.has(op)) throw new Error("Unsupported session move step");
  const moveId = stringParam(inner as Record<string, unknown>, "moveId");
  if (!MOVE_ID.test(moveId)) throw new Error("Invalid move id");
  const before = jobs.get(moveId)?.end ?? Promise.resolve();
  const end: Promise<JobEnd> = before
    .then(() => handleNow(env, inner as Record<string, unknown>))
    .then(
      (result): JobEnd => ({ done: true, result }),
      (error: unknown): JobEnd => ({ done: true, error: error instanceof Error ? error.message : String(error) }),
    );
  const job: Job = { op, end };
  void end.then((settled) => {
    job.settled = settled;
    job.settledAt = Date.now();
  });
  sweepJobs(Date.now());
  jobs.set(moveId, job);
  return {};
}

function pollJob(params: Record<string, unknown>) {
  const moveId = stringParam(params, "moveId");
  const job = jobs.get(moveId);
  if (!job || job.op !== params.inner) throw new Error("That machine restarted during the move");
  if (!job.settled) return { done: false };
  return job.settled;
}

export async function handleSessionMove(env: SessionMoveEnv, params: Record<string, unknown>): Promise<unknown> {
  if (params.op === "begin") return beginJob(env, params);
  if (params.op === "poll") return pollJob(params);
  return handleNow(env, params);
}

async function handleNow(env: SessionMoveEnv, params: Record<string, unknown>): Promise<unknown> {
  switch (params.op) {
    case "state": return sourceState(env, params);
    case "inspect": return inspect(env, params);
    case "stop": return stopSource(env, params);
    case "pack": return pack(env, params);
    case "read": return readPiece(env, params);
    case "restart": return restart(env, params);
    case "check": return check(env, params);
    case "write": return writePiece(env, params);
    case "unpackCode": return unpackCode(env, params);
    case "unpackConversation": return unpackConversation(env, params);
    case "start": return start(env, params);
    case "confirm": return confirm(env, params);
    case "undo": return undo(env, params);
    case "done": return done(env, params);
    default: throw new Error("Unsupported session move step");
  }
}
