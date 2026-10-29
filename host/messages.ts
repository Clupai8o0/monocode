/**
 * Fork feature: the message log (host side). Reads what Claude sessions on
 * this machine said to each other from their transcripts, for
 * `messages.list`. The rules are in src/fork/messageLog/messageLogProtocol.ts;
 * the Mac's reader (src-tauri/src/fork_messages.rs) does the same.
 * Read-only: nothing here touches a session.
 */
import { randomUUID } from "node:crypto";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ERROR_MAX,
  EVENTS_MAX,
  KEY_MAX,
  LINE_HINTS,
  NOTICE_PREFIX,
  PREVIEW_MAX,
  SCRUB_QUOTED_PATH,
  SCRUB_SOCKET,
  SESSION_FILE,
  SUBAGENT_ID,
  SUMMARY_MAX,
  TAIL_MAX_BYTES,
  WINDOW_HOURS_DEFAULT,
  WINDOW_HOURS_MAX,
  type Address,
  type LogAccount,
  type LogEvent,
  type LogProxy,
  type LogSession,
  type MessageLogAnswer,
  type MessageLogParams,
  type ReceiveEvent,
  type Resolved,
  type SendEvent,
  type SendStatus,
} from "../src/fork/messageLog/messageLogProtocol";
import { sessionLiveness } from "./external-sessions";

export type MessageScanOptions = {
  home: string;
  /** This machine's relay name. */
  machine: string;
  now: number;
  isLive: (pid: number, procStart: string | undefined) => boolean | Promise<boolean>;
  tailMaxBytes?: number;
};

const HOUR_MS = 60 * 60 * 1000;
const ACCOUNTS: Array<[string, LogAccount]> = [
  [".claude", "main"],
  [".claude-exec", "cx"],
  [".claude-cx", "cx"],
];
const REGISTRY_FILE = /^\d+\.json$/;
const WS_RUN = /[\t\n\x0B\x0C\r ]+/g;
const WRAPPER = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/;
const NOTICE_ID = /msg_id: ([^\t\n\x0B\x0C\r ;)]{36})/;
const NOTICES: Array<[string, SendStatus, string?]> = [
  ["held by that session", "held"],
  ["approved and released", "released"],
  ["not approved before expiry", "expired"],
  ["denied by the recipient user", "failed", "Denied by that session's user"],
  ["refused", "failed", "Refused: that session is not accepting messages from other sessions"],
];

// ---- text ----

function isWs(char: string) {
  return char === " " || (char >= "\t" && char <= "\r");
}

function trimStart(text: string) {
  let at = 0;
  while (at < text.length && isWs(text[at])) at++;
  return text.slice(at);
}

function trimEnd(text: string) {
  let end = text.length;
  while (end > 0 && isWs(text[end - 1])) end--;
  return text.slice(0, end);
}

function trim(text: string) {
  return trimEnd(trimStart(text));
}

/** The first `max` code points. */
function codePoints(text: string, max: number) {
  let count = 0;
  let at = 0;
  while (at < text.length && count < max) {
    const code = text.codePointAt(at)!;
    at += code > 0xffff ? 2 : 1;
    count++;
  }
  return text.slice(0, at);
}

export function scrub(text: string) {
  return text.replace(SCRUB_SOCKET, "uds:…").replace(SCRUB_QUOTED_PATH, "'…'");
}

function clipped(text: string, max: number) {
  return trimEnd(codePoints(trim(scrub(text)), max));
}

export function previewOf(body: string) {
  return clipped(body, PREVIEW_MAX);
}

export function keyOf(body: string) {
  return trimEnd(codePoints(trim(scrub(body)).replace(WS_RUN, " "), KEY_MAX));
}

// ---- registries ----

type Entry = {
  relay: boolean;
  machine?: string;
  sessionId: string;
  account?: LogAccount;
  name?: string;
  socket?: string;
  bridge?: string;
  updatedAt: number;
  cwd?: string;
  status?: string;
  pid?: number;
  procStart?: string;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function relayAccount(value: unknown): LogAccount | undefined {
  if (value === ".claude") return "main";
  if (value === ".claude-exec" || value === ".claude-cx") return "cx";
  return undefined;
}

function toEntry(raw: unknown, account: LogAccount): Entry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const relayInfo =
    record.monocodeRelay && typeof record.monocodeRelay === "object"
      ? (record.monocodeRelay as Record<string, unknown>)
      : undefined;
  const domain = str(record.pidDomain);
  const relay = record.monocodeRelay !== undefined || !!domain?.startsWith("relay:");
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
  const base = {
    name: str(record.name),
    socket: str(record.messagingSocketPath),
    bridge: str(record.bridgeSessionId),
    updatedAt,
  };
  if (relay) {
    const machine = str(relayInfo?.machine) ?? (domain?.startsWith("relay:") ? domain.slice(6) : undefined);
    const sessionId = str(relayInfo?.remoteSessionId) ?? str(record.sessionId);
    if (!sessionId) return null;
    return { relay: true, machine, sessionId, account: relayAccount(relayInfo?.account), ...base };
  }
  const sessionId = str(record.sessionId);
  if (!sessionId) return null;
  const pid = Number(record.pid);
  return {
    relay: false,
    sessionId,
    account,
    cwd: str(record.cwd),
    status: str(record.status),
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    procStart: str(record.procStart),
    ...base,
  };
}

/** The account folders, each read once even when one links to another. */
async function accountRoots(home: string): Promise<Array<{ root: string; account: LogAccount }>> {
  const roots: Array<{ root: string; account: LogAccount }> = [];
  const seen = new Set<string>();
  for (const [dir, account] of ACCOUNTS) {
    const root = join(home, dir);
    let real: string;
    try {
      real = await realpath(root);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push({ root, account });
  }
  return roots;
}

async function readEntries(roots: Array<{ root: string; account: LogAccount }>): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const { root, account } of roots) {
    const folder = join(root, "sessions");
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!REGISTRY_FILE.test(name)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(folder, name), "utf8"));
      } catch {
        continue;
      }
      const entry = toEntry(raw, account);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

class Registry {
  private readonly real = new Map<string, Promise<string | null>>();

  constructor(
    readonly entries: Entry[],
    private readonly machine: string,
  ) {}

  private canonical(path: string) {
    let found = this.real.get(path);
    if (!found) {
      found = realpath(path).catch(() => null);
      this.real.set(path, found);
    }
    return found;
  }

  private resolved(entry: Entry, bridge: boolean): Resolved {
    const machine = entry.relay ? entry.machine : this.machine;
    return {
      ...(machine ? { machine } : {}),
      sessionId: entry.sessionId,
      ...(entry.account ? { account: entry.account } : {}),
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      route: bridge ? "bridge" : entry.relay ? "relay" : "local",
    };
  }

  async resolve(address: string, name: string | undefined): Promise<Resolved | undefined> {
    if (address.startsWith("uds:")) {
      const path = address.slice(4);
      for (const entry of this.entries) {
        if (entry.socket === path) return this.resolved(entry, false);
      }
      const wanted = await this.canonical(path);
      if (wanted) {
        for (const entry of this.entries) {
          if (entry.socket && (await this.canonical(entry.socket)) === wanted) return this.resolved(entry, false);
        }
      }
    } else if (address.startsWith("bridge:")) {
      const id = address.slice(7);
      for (const entry of this.entries) {
        if (entry.bridge === id) return this.resolved(entry, true);
      }
    }
    if (!name) return undefined;
    let best: Entry | undefined;
    for (const entry of this.entries) {
      if (entry.name === name && (!best || entry.updatedAt > best.updatedAt)) best = entry;
    }
    return best ? this.resolved(best, false) : undefined;
  }
}

// ---- transcripts ----

type FileState = {
  ino: number;
  dev: number;
  offset: number;
  sessionId: string;
  account: LogAccount;
  /** Sends waiting for their result: tool_use id -> event id. */
  pending: Map<string, string>;
  /** Sends by msg id, for delivery notices. */
  byMsgId: Map<string, string>;
  events: Set<string>;
};

type Stored = { event: LogEvent; address?: string; lookup?: string };

function addressOf(value: string): Address {
  if (value.startsWith("uds:")) return "socket";
  if (value.startsWith("bridge:")) return "bridge";
  return "name";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\t\\n\\x0B\\x0C\\r ])${name}="([^"]*)"`).exec(attrs);
  return match ? match[1] : undefined;
}

function partText(part: Record<string, unknown>): string | undefined {
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) {
    const text = part.content.find(
      (item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string",
    );
    return text ? (text.text as string) : undefined;
  }
  return undefined;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toNameOf(message: string): string | undefined {
  let rest: string | undefined;
  const arrow = message.indexOf("” → ");
  if (arrow >= 0) {
    rest = message.slice(arrow + 4);
  } else if (message.startsWith("→ ")) {
    rest = message.slice(2);
  }
  if (rest === undefined) return undefined;
  let end = rest.length;
  for (const stop of [" (", ";", "\n"]) {
    const at = rest.indexOf(stop);
    if (at >= 0 && at < end) end = at;
  }
  const name = trim(scrub(trim(rest.slice(0, end))));
  if (!name || name.startsWith("uds:") || name.startsWith("bridge:")) return undefined;
  return name;
}

export class MessageReader {
  readonly epoch = randomUUID();
  private counter = 0;
  private lastWindow?: number;
  private readonly files = new Map<string, FileState>();
  private readonly events = new Map<string, Stored>();

  async scan(params: MessageLogParams, options: MessageScanOptions): Promise<MessageLogAnswer> {
    const rev = ++this.counter;
    const now = options.now;
    const windowHours = clampWindow(params?.windowHours);
    const roots = await accountRoots(options.home);
    const entries = await readEntries(roots);
    const registry = new Registry(entries, options.machine);
    const changed = new Set<string>();

    const since = now - windowHours * HOUR_MS;
    for (const { root, account } of roots) {
      const projects = join(root, "projects");
      let dirs: string[];
      try {
        dirs = await readdir(projects);
      } catch {
        continue;
      }
      for (const dir of dirs.sort()) {
        let names: string[];
        try {
          names = await readdir(join(projects, dir));
        } catch {
          continue;
        }
        for (const name of names.sort()) {
          if (!name.endsWith(".jsonl")) continue;
          const sessionId = name.slice(0, -6);
          if (!SESSION_FILE.test(sessionId)) continue;
          const path = join(projects, dir, name);
          let info;
          try {
            info = await stat(path);
          } catch {
            continue;
          }
          if (!info.isFile() || info.mtimeMs < since) continue;
          try {
            await this.readFile(path, info, sessionId, account, options.tailMaxBytes ?? TAIL_MAX_BYTES, changed);
          } catch {
            // Gone or replaced since the stat; the next scan sees it again.
          }
        }
      }
    }

    for (const id of changed) {
      const stored = this.events.get(id);
      if (!stored) continue;
      stored.event.rev = rev;
      const found = await registry.resolve(stored.address ?? "", stored.lookup);
      if (stored.event.kind === "send") {
        if (found) stored.event.target = found;
        else delete stored.event.target;
      } else if (found) {
        stored.event.sender = found;
      } else {
        delete stored.event.sender;
      }
    }

    const forget = now - WINDOW_HOURS_MAX * HOUR_MS;
    for (const [id, stored] of this.events) {
      if (stored.event.at < forget) this.events.delete(id);
    }

    const full = !(params?.since && params.since.epoch === this.epoch && this.lastWindow === windowHours);
    const cursor = full ? 0 : Number(params.since!.cursor) || 0;
    this.lastWindow = windowHours;
    let events = [...this.events.values()]
      .map((stored) => stored.event)
      .filter((event) => event.at >= since && (full || event.rev > cursor))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let truncated = false;
    if (full && events.length > EVENTS_MAX) {
      events = events.slice(events.length - EVENTS_MAX);
      truncated = true;
    }

    return {
      version: 1,
      machine: options.machine,
      epoch: this.epoch,
      cursor: rev,
      full,
      ...(truncated ? { truncated } : {}),
      windowHours,
      scannedAt: now,
      sessions: await liveSessions(entries, options.isLive),
      proxies: proxiesOf(entries),
      events: events.map((event) => structuredClone(event)),
    };
  }

  private forgetFile(state: FileState) {
    for (const id of state.events) this.events.delete(id);
  }

  private async readFile(
    path: string,
    info: { ino: number; dev: number; size: number },
    sessionId: string,
    account: LogAccount,
    tailMax: number,
    changed: Set<string>,
  ) {
    let state = this.files.get(path);
    if (state && (state.ino !== info.ino || state.dev !== info.dev || info.size < state.offset)) {
      this.forgetFile(state);
      state = undefined;
    }
    let start: number;
    let skipFirst = false;
    if (!state) {
      state = {
        ino: info.ino,
        dev: info.dev,
        offset: 0,
        sessionId,
        account,
        pending: new Map(),
        byMsgId: new Map(),
        events: new Set(),
      };
      this.files.set(path, state);
      start = info.size > tailMax ? info.size - tailMax : 0;
      skipFirst = start > 0;
    } else {
      start = state.offset;
    }
    if (info.size <= start) return;
    const buffer = Buffer.alloc(info.size - start);
    const handle = await open(path, "r");
    let read = 0;
    try {
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
    } finally {
      await handle.close();
    }
    const data = buffer.subarray(0, read);
    let at = 0;
    if (skipFirst) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) return;
      at = newline + 1;
    }
    const last = data.lastIndexOf(0x0a);
    if (last < at) {
      if (skipFirst) state.offset = start + at;
      return;
    }
    while (at <= last) {
      const end = data.indexOf(0x0a, at);
      const line = data.toString("utf8", at, end);
      this.line(state, line, start + at, changed);
      at = end + 1;
    }
    state.offset = start + last + 1;
  }

  private needsParse(state: FileState, line: string) {
    if (LINE_HINTS.some((hint) => line.includes(hint))) return true;
    for (const id of state.pending.keys()) if (line.includes(id)) return true;
    return false;
  }

  private line(state: FileState, line: string, offset: number, changed: Set<string>) {
    if (!this.needsParse(state, line)) return;
    let record: Record<string, unknown> | undefined;
    try {
      record = objectOf(JSON.parse(line));
    } catch {
      return;
    }
    if (!record || typeof record.timestamp !== "string") return;
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) return;
    const message = objectOf(record.message);
    const content = message?.content;
    if (record.type === "assistant") {
      if (Array.isArray(content)) {
        for (const part of content) this.send(state, objectOf(part), at, changed);
      }
      return;
    }
    if (record.type !== "user") return;
    if (Array.isArray(content)) {
      for (const part of content) {
        const item = objectOf(part);
        if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
          this.result(state, record, item, at, changed);
        }
      }
    }
    const text = contentText(content);
    if (text.startsWith(NOTICE_PREFIX)) this.notice(state, text, at, changed);
    this.receive(state, record, text, at, offset, changed);
  }

  private send(state: FileState, part: Record<string, unknown> | undefined, at: number, changed: Set<string>) {
    if (!part || part.type !== "tool_use" || part.name !== "SendMessage" || typeof part.id !== "string") return;
    const input = objectOf(part.input) ?? {};
    const to = str(input.to) ?? str(input.recipient);
    if (to === undefined || SUBAGENT_ID.test(to) || input.recipient_kind === "agent") return;
    const text = str(input.message) ?? str(input.content) ?? "";
    if (!trim(text)) return;
    const address = addressOf(to);
    const id = `${state.sessionId}:${part.id}`;
    const summary = typeof input.summary === "string" ? clipped(input.summary, SUMMARY_MAX) : "";
    const event: SendEvent = {
      kind: "send",
      id,
      rev: 0,
      at,
      updatedAt: at,
      sessionId: state.sessionId,
      account: state.account,
      to: address === "name" ? scrub(to) : "",
      toAddress: address,
      ...(summary ? { summary } : {}),
      preview: previewOf(text),
      key: keyOf(text),
      status: "pending",
    };
    this.events.set(id, { event, address: to, lookup: address === "name" ? to : undefined });
    state.events.add(id);
    state.pending.set(part.id, id);
    changed.add(id);
  }

  private result(
    state: FileState,
    record: Record<string, unknown>,
    part: Record<string, unknown>,
    at: number,
    changed: Set<string>,
  ) {
    const toolUseId = part.tool_use_id as string;
    const id = state.pending.get(toolUseId);
    if (!id) return;
    state.pending.delete(toolUseId);
    const stored = this.events.get(id);
    if (!stored || stored.event.kind !== "send") return;
    const event = stored.event;
    const text = partText(part);
    let result = objectOf(record.toolUseResult);
    if (!result && text !== undefined) {
      try {
        result = objectOf(JSON.parse(text));
      } catch {
        result = undefined;
      }
    }
    const message = str(result?.message);
    if (
      (result && (result.pin != null || result.resumedAgentId != null)) ||
      message?.startsWith("Resuming agent") ||
      message?.startsWith("Message queued for delivery to")
    ) {
      this.events.delete(id);
      state.events.delete(id);
      changed.delete(id);
      return;
    }
    if (result?.success === false || part.is_error === true) {
      let words = message;
      if (!result && text !== undefined) {
        words = text.replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, "$1");
      }
      const error = words !== undefined ? clipped(words, ERROR_MAX) : "";
      event.status = "failed";
      event.error = error || "Not sent";
    } else {
      event.status = "sent";
      if (typeof result?.msg_id === "string") {
        event.msgId = result.msg_id;
        state.byMsgId.set(result.msg_id, id);
      }
      if (event.toAddress !== "name" && message) {
        const toName = toNameOf(message);
        if (toName) {
          event.toName = toName;
          stored.lookup = toName;
        }
      }
    }
    event.updatedAt = at;
    changed.add(id);
  }

  private notice(state: FileState, text: string, at: number, changed: Set<string>) {
    const match = NOTICE_ID.exec(text);
    if (!match) return;
    let found: [number, SendStatus, string?] | undefined;
    for (const [phrase, status, error] of NOTICES) {
      const index = text.indexOf(phrase);
      if (index >= 0 && (!found || index < found[0])) found = [index, status, error];
    }
    if (!found) return;
    const id = state.byMsgId.get(match[1]);
    const stored = id ? this.events.get(id) : undefined;
    if (!id || !stored || stored.event.kind !== "send") return;
    stored.event.status = found[1];
    if (found[2]) stored.event.error = found[2];
    else delete stored.event.error;
    stored.event.updatedAt = at;
    changed.add(id);
  }

  private receive(
    state: FileState,
    record: Record<string, unknown>,
    text: string,
    at: number,
    offset: number,
    changed: Set<string>,
  ) {
    const origin = objectOf(record.origin);
    let peer = false;
    if (origin) peer = origin.kind === "peer";
    else peer = text.includes("<cross-session-message");
    if (!peer) return;
    const wrapper = WRAPPER.exec(text);
    const attrs = wrapper?.[1] ?? "";
    const body = str(origin?.body) ?? wrapper?.[2];
    if (body === undefined) return;
    const from = str(origin?.from) ?? attr(attrs, "from") ?? "";
    const fromName = str(origin?.name) ?? attr(attrs, "from-name");
    const msgId = str(origin?.msg_id);
    const id = `${state.sessionId}:${typeof record.uuid === "string" ? record.uuid : `r${offset}`}`;
    const event: ReceiveEvent = {
      kind: "receive",
      id,
      rev: 0,
      at,
      updatedAt: at,
      sessionId: state.sessionId,
      account: state.account,
      ...(fromName !== undefined ? { fromName: scrub(fromName) } : {}),
      fromAddress: addressOf(from),
      preview: previewOf(body),
      key: keyOf(body),
      ...(msgId ? { msgId } : {}),
    };
    this.events.set(id, { event, address: from, lookup: fromName });
    state.events.add(id);
    changed.add(id);
  }
}

function clampWindow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WINDOW_HOURS_DEFAULT;
  return Math.min(WINDOW_HOURS_MAX, Math.max(1, Math.floor(value)));
}

async function liveSessions(entries: Entry[], isLive: MessageScanOptions["isLive"]): Promise<LogSession[]> {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.relay || !entry.cwd || !entry.pid) continue;
    const current = byId.get(entry.sessionId);
    if (current && current.updatedAt >= entry.updatedAt) continue;
    let live = false;
    try {
      live = await isLive(entry.pid, entry.procStart);
    } catch {
      live = false;
    }
    if (live) byId.set(entry.sessionId, entry);
  }
  return [...byId.values()]
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    .map((entry) => {
      const cwd = entry.cwd!;
      const parts = cwd.split(/[\\/]/).filter(Boolean);
      return {
        sessionId: entry.sessionId,
        account: entry.account!,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        cwd,
        project: parts[parts.length - 1] ?? cwd,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      };
    });
}

function proxiesOf(entries: Entry[]): LogProxy[] {
  const byKey = new Map<string, LogProxy>();
  for (const entry of entries) {
    if (!entry.relay || !entry.machine) continue;
    const key = `${entry.machine}\n${entry.sessionId}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      name: entry.name ?? "",
      machine: entry.machine,
      sessionId: entry.sessionId,
      ...(entry.account ? { account: entry.account } : {}),
    });
  }
  return [...byKey.values()].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.machine < b.machine ? -1 : 1,
  );
}

export function createMessageReader(): MessageReader {
  return new MessageReader();
}

let reader: MessageReader | undefined;

/** The process's reader, made on first use. */
export function messageReader(): MessageReader {
  reader ??= createMessageReader();
  return reader;
}

/** `messages.list`: this machine's message log, for a paired device. */
export async function listMessages(
  params: Record<string, unknown>,
  device: { id: string; name: string } | null,
  machine: string,
  options: Partial<MessageScanOptions> = {},
): Promise<MessageLogAnswer> {
  if (!device) throw new Error("This device is not paired");
  const since = params.since as { epoch?: unknown; cursor?: unknown } | undefined;
  const clean: MessageLogParams = {};
  if (since && typeof since === "object" && typeof since.epoch === "string" && typeof since.cursor === "number") {
    clean.since = { epoch: since.epoch, cursor: since.cursor };
  }
  if (typeof params.windowHours === "number") clean.windowHours = params.windowHours;
  return messageReader().scan(clean, {
    home: options.home ?? homedir(),
    machine,
    now: options.now ?? Date.now(),
    // A fresh checker each scan: one caches its process table for good.
    isLive: options.isLive ?? sessionLiveness(),
    ...(options.tailMaxBytes ? { tailMaxBytes: options.tailMaxBytes } : {}),
  });
}
