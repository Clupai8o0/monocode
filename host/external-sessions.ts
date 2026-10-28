import { execFile } from "node:child_process";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ExternalSession,
  ExternalTranscriptPage,
  ExternalTurn,
} from "../src/fork/externalSessions/externalSessionsModel";
import { isRelayEntry } from "../src/fork/lab/labProtocol";

/**
 * "Elsewhere": agent sessions on this machine's projects that MonoCode did
 * not start, read from the agents' session registries, the shared claims
 * history and handoff files. Read-only; nothing here touches a session.
 */

export type ExternalProject = { id: string; path: string };

export type ExternalSessionsOptions = {
  home?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Whether the process is still the one that wrote the record. */
  isAlive?: (pid: number, procStart: string | undefined) => boolean | Promise<boolean>;
  /** The absolute git common dir of a folder, or null. */
  gitCommonDir?: (path: string) => Promise<string | null>;
  /** `ps -Ao pid=,etime=,args=` output (Mac, and other agents on Linux). */
  processTable?: () => Promise<string>;
  /** `/proc/<pid>/stat`, or null when the process is gone (Linux). */
  readProcStat?: (pid: number) => Promise<string | null>;
  /** Provider session ids of MonoCode's own sessions. */
  excludeIds?: Iterable<string>;
};

type Record_ = {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  procStart?: string;
  name?: string;
  status?: string;
  updatedAt: number;
  source: string;
};

type HistoryLine = {
  at: number;
  event: string;
  session: string;
  name?: string;
  worktree?: string;
  branch?: string;
  text?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;
const MAX_HANDED_OVER = 20;
const HISTORY_TAIL = 1024 * 1024;
const HANDOFF_MAX = 64 * 1024;
const CHUNK = 512 * 1024;
const SCAN_MAX = 16 * 1024 * 1024;
const PAGE_MAX = 200 * 1024;
const TURN_MAX = 4000;
// Kimi and OpenCode ids carry underscores ("session_…", "ses_…").
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HANDOFF_ID = /^handoff:(\.claude\/handoff[A-Za-z0-9._-]*\.md)$/;
const HANDOFF_FILE = /^handoff[A-Za-z0-9._-]*\.md$/;
/** A handoff file's path in a project: `.claude/handoff*.md`, maybe in a worktree. */
const HANDOFF_REL = /(?:^|\/)\.claude\/handoff[A-Za-z0-9._-]*\.md$/;
/** The agent a claims name such as "monocode-cx79" belongs to. */
const NAME_AGENT: Record<string, string> = {
  cx: "codex",
  oc: "opencode",
  ds: "dsh",
  km: "kimi",
  gk: "grok",
};
const AGENT_ARGS =
  /(?:^|[\/\s])(?:claude|codex|opencode|dsh|kimi|grok(?:-macos-[A-Za-z0-9_]+)?)(?:\s|$)/i;
const SKIPPED_USER = [
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<task-notification>",
];

/** The second Claude account's folders: ~/.claude-exec everywhere, and on
 *  Linux also an older ~/.claude-cx (missing folders are skipped). */
function cxAccounts(platform: NodeJS.Platform) {
  return platform === "darwin" ? [".claude-exec"] : [".claude-exec", ".claude-cx"];
}

function registries(platform: NodeJS.Platform): Array<[string, string]> {
  return [
    [".claude/sessions", "claude"],
    ...cxAccounts(platform).map((account): [string, string] => [`${account}/sessions`, "claude-cx"]),
    [".codex/agent-sessions", "codex"],
    [".local/state/opencode/agent-sessions", "opencode"],
    [".dsh/agent-sessions", "dsh"],
    [".kimi-code/agent-sessions", "kimi"],
    [".grok/agent-sessions", "grok"],
  ];
}

const commonDirs = new Map<string, Promise<string | null>>();

/** Cached for the process lifetime, failures too. */
function defaultGitCommonDir(path: string): Promise<string | null> {
  let found = commonDirs.get(path);
  if (!found) {
    found = new Promise((done) => {
      execFile(
        "git",
        ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeout: 3_000 },
        (error, stdout) => done(error ? null : String(stdout).trim() || null),
      );
    });
    commonDirs.set(path, found);
  }
  return found;
}

function defaultProcessTable(): Promise<string> {
  return new Promise((done) => {
    execFile(
      "ps",
      ["-Ao", "pid=,etime=,args="],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => done(error ? "" : String(stdout)),
    );
  });
}

/** Seconds from `[[dd-]hh:]mm:ss`. */
export function etimeSeconds(value: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A UTC time like "Wed Oct 28 08:34:18 2026", in ms. */
export function macProcStart(value: string): number | null {
  const match = /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return null;
  return Date.UTC(
    Number(match[6]), month, Number(match[2]),
    Number(match[3]), Number(match[4]), Number(match[5]),
  );
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultReadProcStat(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
}

function makeLiveness(
  platform: NodeJS.Platform,
  now: () => number,
  processTable: () => Promise<string>,
  readProcStat: (pid: number) => Promise<string | null>,
) {
  let table: Promise<Map<number, { start: number; args: string }>> | undefined;
  const processes = () => {
    table ??= processTable().then((text) => {
      const at = now();
      const rows = new Map<number, { start: number; args: string }>();
      for (const line of text.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const elapsed = etimeSeconds(match[2]);
        if (elapsed === null) continue;
        rows.set(Number(match[1]), { start: at - elapsed * 1000, args: match[3] });
      }
      return rows;
    });
    return table;
  };
  const sameStart = async (pid: number, procStart: string) => {
    const row = (await processes()).get(pid);
    const start = macProcStart(procStart);
    return (
      !!row && start !== null && Math.abs(row.start - start) <= 5_000 && AGENT_ARGS.test(row.args)
    );
  };
  return async (pid: number, procStart: string | undefined) => {
    if (platform === "darwin") {
      if (!procStart) return (await processes()).has(pid);
      return sameStart(pid, procStart);
    }
    if (platform === "linux" && procStart) {
      const stamp = procStart.trim();
      // Other agents' records hold a UTC time here too, written by agent_hook.py.
      if (!/^\d+$/.test(stamp)) return sameStart(pid, stamp);
      const text = await readProcStat(pid);
      if (text === null) return false;
      const fields = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
      return fields[19] === stamp;
    }
    return pidAlive(pid);
  };
}

/** Whether a registry entry's process is still the one that wrote it. Each
 *  call reads the process table afresh, at most once. */
export function sessionLiveness(
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now,
): (pid: number, procStart: string | undefined) => Promise<boolean> {
  return makeLiveness(platform, now, defaultProcessTable, defaultReadProcStat);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function toRecord(value: unknown, source: string): Record_ | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const pid = Number(raw.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof raw.sessionId !== "string" || !raw.sessionId) return null;
  if (typeof raw.cwd !== "string" || !raw.cwd) return null;
  const num = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) ? field : undefined;
  return {
    pid,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    startedAt: num(raw.startedAt),
    procStart:
      raw.procStart === undefined || raw.procStart === null || raw.procStart === ""
        ? undefined
        : String(raw.procStart),
    name: typeof raw.name === "string" ? raw.name : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    updatedAt: num(raw.updatedAt) ?? num(raw.startedAt) ?? 0,
    source,
  };
}

async function readRegistries(home: string, platform: NodeJS.Platform) {
  const mirror = await readJson(join(home, ".local/state/session-mirror.json"));
  const copies = new Set(
    mirror && typeof mirror === "object" ? Object.keys(mirror as object).map((path) => resolve(path)) : [],
  );
  const bySession = new Map<string, Record_>();
  for (const [dir, source] of registries(platform)) {
    const folder = join(home, dir);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    const records: Record_[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(folder, name);
      if (copies.has(resolve(path))) continue;
      const raw = await readJson(path);
      // The session relay's copies of sessions on other machines.
      if (isRelayEntry(raw)) continue;
      const record = toRecord(raw, source);
      if (record) records.push(record);
    }
    let kept = records;
    // One process may leave several files; its newest is the current one.
    if (dir.endsWith("agent-sessions")) {
      const byPid = new Map<number, Record_>();
      for (const record of records) {
        const current = byPid.get(record.pid);
        if (!current || record.updatedAt > current.updatedAt) byPid.set(record.pid, record);
      }
      kept = [...byPid.values()];
    }
    for (const record of kept) {
      const current = bySession.get(record.sessionId);
      if (!current || record.updatedAt > current.updatedAt) bySession.set(record.sessionId, record);
    }
  }
  return [...bySession.values()];
}

function within(parent: string, child: string) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function readTail(path: string, bytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function readHistory(commonDir: string, now: number): Promise<HistoryLine[]> {
  const text = await readTail(join(commonDir, "claude-claims-history.jsonl"), HISTORY_TAIL);
  const lines: HistoryLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || value.event !== "note" || typeof value.session !== "string") continue;
    const at = Number(value.at);
    if (!Number.isFinite(at) || now - at * 1000 > WINDOW_MS) continue;
    const str = (field: unknown) => (typeof field === "string" && field ? field : undefined);
    lines.push({
      at,
      event: "note",
      session: value.session,
      // claims.py writes "?" when it has no name for the session.
      name: value.name === "?" ? undefined : str(value.name),
      worktree: str(value.worktree),
      branch: str(value.branch),
      text: typeof value.text === "string" ? value.text : undefined,
    });
  }
  return lines;
}

function sanitize(cwd: string) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

async function exists(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Where a Claude session's transcript is, and which account holds it. */
async function locateTranscript(
  home: string,
  platform: NodeJS.Platform,
  source: string,
  cwd: string,
  sessionId: string,
): Promise<{ path: string; source: string } | null> {
  const accounts: Array<[string, string]> = [
    [".claude", "claude"],
    ...cxAccounts(platform).map((account): [string, string] => [account, "claude-cx"]),
  ];
  for (const [account, name] of accounts) {
    if (name !== source) continue;
    const path = join(home, account, "projects", sanitize(cwd), `${sessionId}.jsonl`);
    if (await exists(path)) return { path, source };
  }
  for (const [account, name] of accounts) {
    const root = join(home, account, "projects");
    let folders: string[];
    try {
      folders = await readdir(root);
    } catch {
      continue;
    }
    for (const folder of folders) {
      const path = join(root, folder, `${sessionId}.jsonl`);
      if (await exists(path)) return { path, source: name };
    }
  }
  return null;
}

function handoffTarget(text: string) {
  const match = /handed over:\s*(\S+)/i.exec(text);
  return match ? match[1].replace(/[.,;:!?)\]}'"`>]+$/, "") : undefined;
}

/**
 * The real path of a project's handoff file, or null when the path is not a
 * handoff file inside the project. A link may point anywhere, so the real
 * path has to be a handoff file too.
 */
async function handoffFile(projectPath: string, rel: string): Promise<string | null> {
  if (!HANDOFF_REL.test(rel)) return null;
  try {
    const root = await realpath(projectPath);
    const file = await realpath(join(root, rel));
    if (!within(root, file) || file === root || !HANDOFF_REL.test(file.split(sep).join("/")))
      return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** The agent a claims name belongs to when it is not Claude. */
function agentOfName(name: string | undefined) {
  const match = name ? /-(cx|oc|ds|km|gk)[0-9a-f]{2}$/.exec(name) : null;
  return match ? NAME_AGENT[match[1]] : undefined;
}

type Row = ExternalSession & { transcriptPath?: string };

/**
 * The external sessions of every project, or of `only`, transcript paths
 * included. Folders match against every project either way, so a nested
 * project keeps its own sessions.
 */
async function buildRows(
  projects: ExternalProject[],
  options: ExternalSessionsOptions,
  only?: string,
): Promise<Row[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const at = now();
  const gitCommonDir = options.gitCommonDir ?? defaultGitCommonDir;
  const isAlive =
    options.isAlive ??
    makeLiveness(
      platform,
      now,
      options.processTable ?? defaultProcessTable,
      options.readProcStat ?? defaultReadProcStat,
    );
  const excluded = new Set(options.excludeIds ?? []);
  const scope = only === undefined ? projects : projects.filter((project) => project.id === only);
  const wanted = (project: ExternalProject | undefined): project is ExternalProject =>
    !!project && (only === undefined || project.id === only);

  const commonOf = new Map<string, string | null>();
  for (const project of projects)
    commonOf.set(project.id, await gitCommonDir(project.path));

  const match = async (cwd: string): Promise<ExternalProject | undefined> => {
    let best: ExternalProject | undefined;
    for (const project of projects)
      if (within(project.path, cwd) && (!best || project.path.length > best.path.length))
        best = project;
    if (best) return best;
    const common = await gitCommonDir(cwd);
    if (!common) return undefined;
    return projects.find((project) => commonOf.get(project.id) === common);
  };

  const rows: Row[] = [];
  const live = new Set<string>();
  for (const record of await readRegistries(home, platform)) {
    if (excluded.has(record.sessionId) || !SESSION_ID.test(record.sessionId)) continue;
    if (!(await isAlive(record.pid, record.procStart))) continue;
    live.add(record.sessionId);
    const project = await match(record.cwd);
    if (!wanted(project)) continue;
    const claude = record.source === "claude" || record.source === "claude-cx";
    const found = claude
      ? await locateTranscript(home, platform, record.source, record.cwd, record.sessionId)
      : null;
    rows.push({
      id: record.sessionId,
      projectId: project.id,
      source: found?.source ?? record.source,
      ...(record.name ? { name: record.name } : {}),
      cwd: record.cwd,
      state: record.status === "idle" ? "idle" : "running",
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      updatedAt: record.updatedAt,
      hasTranscript: Boolean(found),
      ...(found ? { transcriptPath: found.path } : {}),
    });
  }

  // Notes and hand-overs, one history file per repository.
  const histories = new Map<string, Promise<HistoryLine[]>>();
  for (const project of scope) {
    const common = commonOf.get(project.id);
    if (common && !histories.has(common)) histories.set(common, readHistory(common, at));
  }
  const latest = new Map<string, HistoryLine>();
  for (const lines of await Promise.all(histories.values()))
    for (const line of lines) {
      const current = latest.get(line.session);
      if (!current || line.at >= current.at) latest.set(line.session, line);
    }
  for (const row of rows) {
    const note = latest.get(row.id);
    if (!note) continue;
    if (note.text) row.note = note.text;
    if (!row.branch && note.branch) row.branch = note.branch;
  }

  const handedOver: Row[] = [];
  for (const line of latest.values()) {
    if (live.has(line.session) || excluded.has(line.session)) continue;
    if (!SESSION_ID.test(line.session)) continue;
    const text = line.text ?? "";
    if (!/^handed over/i.test(text.trim())) continue;
    const worktree = line.worktree;
    if (!worktree) continue;
    const project = await match(worktree);
    if (!wanted(project)) continue;
    let handoffPath: string | undefined;
    const target = handoffTarget(text);
    if (target) {
      const expanded = target.startsWith("~/") ? join(home, target.slice(2)) : target;
      const absolute = resolve(worktree, expanded);
      const rel = relative(project.path, absolute).split(sep).join("/");
      // Only a handoff file is ever shown, never another file a note names.
      if (!rel.startsWith("..") && !isAbsolute(rel) && (await handoffFile(project.path, rel)))
        handoffPath = rel;
    }
    const agent = agentOfName(line.name);
    const found = agent
      ? null
      : await locateTranscript(home, platform, "claude", worktree, line.session);
    handedOver.push({
      id: line.session,
      projectId: project.id,
      source: found?.source ?? agent ?? "claude",
      ...(line.name ? { name: line.name } : {}),
      cwd: worktree,
      ...(line.branch ? { branch: line.branch } : {}),
      state: "handed-over",
      updatedAt: Math.round(line.at * 1000),
      note: text,
      ...(handoffPath ? { handoffPath } : {}),
      hasTranscript: Boolean(found),
      ...(found ? { transcriptPath: found.path } : {}),
    });
  }

  // Handoff files no row names yet.
  for (const project of scope) {
    const named = new Set(
      [...rows, ...handedOver]
        .filter((row) => row.projectId === project.id && row.handoffPath)
        .map((row) => row.handoffPath),
    );
    let names: string[];
    try {
      names = await readdir(join(project.path, ".claude"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!HANDOFF_FILE.test(name)) continue;
      const rel = `.claude/${name}`;
      if (named.has(rel)) continue;
      const file = await handoffFile(project.path, rel);
      if (!file) continue;
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (at - info.mtimeMs > WINDOW_MS) continue;
      handedOver.push({
        id: `handoff:${rel}`,
        projectId: project.id,
        source: "claude",
        name,
        cwd: project.path,
        state: "handed-over",
        updatedAt: Math.round(info.mtimeMs),
        handoffPath: rel,
        hasTranscript: false,
      });
    }
  }

  const byUpdate = (a: Row, b: Row) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const result: Row[] = [];
  for (const project of scope) {
    result.push(...rows.filter((row) => row.projectId === project.id).sort(byUpdate));
    result.push(
      ...handedOver
        .filter((row) => row.projectId === project.id)
        .sort(byUpdate)
        .slice(0, MAX_HANDED_OVER),
    );
  }
  return result;
}

function publicRow({ transcriptPath: _, ...row }: Row): ExternalSession {
  return row;
}

export async function listExternalSessions(
  projects: ExternalProject[],
  options: ExternalSessionsOptions = {},
  params: { projectId?: unknown } = {},
): Promise<{ sessions: ExternalSession[] }> {
  let only: string | undefined;
  if (params.projectId !== undefined && params.projectId !== null) {
    if (typeof params.projectId !== "string") throw new Error("Invalid project id");
    if (!projects.some((project) => project.id === params.projectId))
      throw new Error("Project is not registered on this machine");
    only = params.projectId;
  }
  return { sessions: (await buildRows(projects, options, only)).map(publicRow) };
}

function clip(text: string, page: { truncated: boolean }) {
  if (text.length <= TURN_MAX) return text;
  page.truncated = true;
  return text.slice(0, TURN_MAX - 1) + "…";
}

/** The turns one transcript line gives, in order. */
export function transcriptTurns(line: string, page: { truncated: boolean }): ExternalTurn[] {
  let value: Record<string, any>;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!value || typeof value !== "object" || value.isSidechain === true || value.isMeta === true)
    return [];
  const parsed = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
  const at = Number.isFinite(parsed) ? { at: parsed } : {};
  const content = value.message?.content;
  if (value.type === "user") {
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content))
      text = content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!text || SKIPPED_USER.some((tag) => text.startsWith(tag))) return [];
    return [{ role: "user", text: clip(text, page), ...at }];
  }
  if (value.type === "assistant" && Array.isArray(content)) {
    const turns: ExternalTurn[] = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        turns.push({ role: "assistant", text: clip(part.text, page), ...at });
      } else if (part?.type === "tool_use" && typeof part.name === "string") {
        const input = part.input && typeof part.input === "object" ? part.input : {};
        const detail = ["command", "file_path", "path", "pattern", "description", "prompt"]
          .map((key) => input[key])
          .find((field) => typeof field === "string" && field) as string | undefined;
        const text = detail
          ? `${part.name}: ${detail.split("\n")[0].slice(0, 200)}`
          : part.name;
        turns.push({ role: "tool", text: clip(text, page), ...at });
      }
    }
    return turns;
  }
  return [];
}

/** One page of a transcript, read backward from `before` (or the end). */
export async function readTranscriptPage(
  path: string,
  before: number | undefined,
  limit: number,
): Promise<Omit<ExternalTranscriptPage, "handoff">> {
  const handle = await open(path, "r");
  const page = { truncated: false };
  const lines: Array<{ offset: number; turns: ExternalTurn[] }> = [];
  let cursor = 0;
  try {
    const { size } = await handle.stat();
    const end = before === undefined ? size : Math.min(before, size);
    cursor = end;
    let pos = end;
    let carry = Buffer.alloc(0);
    let count = 0;
    let scanned = 0;
    let done = false;
    while (!done && pos > 0 && scanned < SCAN_MAX) {
      const length = Math.min(CHUNK, pos);
      pos -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, pos);
      scanned += length;
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let upto = data.length;
      for (;;) {
        const newline = upto >= 2 ? data.lastIndexOf(0x0a, upto - 2) : -1;
        if (newline < 0 && pos > 0) {
          carry = data.subarray(0, upto);
          break;
        }
        const start = newline + 1;
        const turns = transcriptTurns(data.subarray(start, upto).toString("utf8"), page);
        cursor = pos + start;
        if (turns.length) {
          lines.push({ offset: cursor, turns });
          count += turns.length;
        }
        upto = start;
        if (count >= limit || start === 0) {
          done = true;
          break;
        }
      }
    }
    // A line longer than the whole scan is skipped, or paging would stop on it.
    if (!done && pos > 0 && cursor === end) {
      cursor = pos;
      page.truncated = true;
    }
  } finally {
    await handle.close();
  }
  // Newest first here. Whole lines only, up to the turn limit and the size
  // cap; the rest waits for the next page. Only a newest line too big for a
  // page on its own is cut, keeping its newest turns.
  const kept: ExternalTurn[][] = [];
  let total = 0;
  let bytes = 0;
  for (const line of lines) {
    const size = line.turns.reduce((sum, turn) => sum + Buffer.byteLength(turn.text), 0);
    if (total + line.turns.length <= limit && bytes + size <= PAGE_MAX) {
      kept.push(line.turns);
      total += line.turns.length;
      bytes += size;
      continue;
    }
    if (kept.length) {
      cursor = lines[kept.length - 1].offset;
    } else {
      const part: ExternalTurn[] = [];
      for (let i = line.turns.length - 1; i >= 0 && part.length < limit; i--) {
        const turnSize = Buffer.byteLength(line.turns[i].text);
        if (part.length && bytes + turnSize > PAGE_MAX) break;
        part.unshift(line.turns[i]);
        bytes += turnSize;
      }
      kept.push(part);
      cursor = line.offset;
      page.truncated = true;
    }
    break;
  }
  const turns = kept.reverse().flat();
  return {
    turns,
    ...(cursor > 0 ? { before: cursor } : {}),
    ...(page.truncated ? { truncated: true } : {}),
  };
}

async function readHandoff(projectPath: string, handoffPath: string) {
  const file = await handoffFile(projectPath, handoffPath);
  if (!file) return undefined;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HANDOFF_MAX);
    const { bytesRead } = await handle.read(buffer, 0, HANDOFF_MAX, 0);
    return { path: handoffPath, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

export async function readExternalSession(
  projects: ExternalProject[],
  options: ExternalSessionsOptions,
  params: { projectId?: unknown; sessionId?: unknown; before?: unknown; limit?: unknown },
): Promise<ExternalTranscriptPage> {
  const project = projects.find((item) => item.id === params.projectId);
  if (!project) throw new Error("Project is not registered on this machine");
  const sessionId = params.sessionId;
  if (typeof sessionId !== "string" || !(SESSION_ID.test(sessionId) || HANDOFF_ID.test(sessionId)))
    throw new Error("Invalid session id");
  let before: number | undefined;
  if (params.before !== undefined && params.before !== null) {
    if (typeof params.before !== "number" || !Number.isInteger(params.before) || params.before < 0)
      throw new Error("Invalid before");
    before = params.before;
  }
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.min(200, Math.max(1, Math.floor(params.limit)))
      : 60;
  const row = (await buildRows(projects, options, project.id)).find((item) => item.id === sessionId);
  if (!row) throw new Error("Session not found");
  const handoff =
    before === undefined && row.handoffPath
      ? await readHandoff(project.path, row.handoffPath)
      : undefined;
  const extra = handoff ? { handoff } : {};
  if (!row.transcriptPath) return { turns: [], ...extra };
  return { ...(await readTranscriptPage(row.transcriptPath, before, limit)), ...extra };
}

/** The host's projects and the ids of its own sessions, as call arguments. */
export function externalSessionsOptions(store: {
  projects(): Array<{ id: string; cwd: string }>;
  sessions(): Array<{ session: { providerSessionId?: string } }>;
}): [ExternalProject[], ExternalSessionsOptions] {
  return [
    store.projects().map((project) => ({ id: project.id, path: project.cwd })),
    {
      excludeIds: store
        .sessions()
        .map((value) => value.session.providerSessionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    },
  ];
}
