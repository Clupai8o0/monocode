import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { cpus, homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  isRelayEntry,
  type LabHealth,
  type LabHealthGate,
  type LabHealthPoint,
  type LabHealthSession,
  type LabPressure,
} from "../src/fork/lab/labProtocol";

/**
 * Fork: how the machine and its Claude sessions are doing, for the Home lab
 * popover. A read takes a few milliseconds: /proc, /sys and the new end of each
 * transcript. agent-gate is slow (most of a second), so it runs in the
 * background and a read answers with its last result.
 */

const ACCOUNTS = [".claude", ".claude-exec"];
const SAMPLE_MS = 10_000;
const HISTORY_MS = 10 * 60_000;
/** Nobody asked for this long: stop sampling until someone does. */
const WATCH_MS = 15 * 60_000;
const GATE_EVERY_MS = 15_000;
const GATE_TIMEOUT_MS = 5000;
const RATE_WINDOW_MS = 60_000;
const SWAP_MIN_AGE_MS = 60_000;
const SWAP_MAX_AGE_MS = 5 * 60_000;
/** A new transcript: only its end matters. Also after a burst too big to read. */
const TAIL_BYTES = 256 * 1024;
const DELTA_MAX_BYTES = 2 * 1024 * 1024;
const PARTIAL_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 40;
/** Best first; the other thermal zones on these machines aren't the CPU. */
const THERMAL_ZONES = ["x86_pkg_temp", "TCPU", "cpu-thermal", "acpitz"];

export function parsePressure(text: string): LabPressure | null {
  const some = /^some avg10=([\d.]+) avg60=([\d.]+)/m.exec(text);
  if (!some) {
    return null;
  }
  // Older kernels have no "full" line for cpu.
  const full = /^full avg10=([\d.]+) avg60=([\d.]+)/m.exec(text);
  return {
    someAvg10: Number(some[1]),
    someAvg60: Number(some[2]),
    fullAvg10: full ? Number(full[1]) : 0,
    fullAvg60: full ? Number(full[2]) : 0,
  };
}

export function parseMeminfo(text: string): {
  totalMb: number;
  availableMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
} {
  const kb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  };
  const mb = (value: number) => Math.round(value / 1024);
  return {
    totalMb: mb(kb("MemTotal")),
    availableMb: mb(kb("MemAvailable")),
    swapTotalMb: mb(kb("SwapTotal")),
    swapUsedMb: mb(Math.max(0, kb("SwapTotal") - kb("SwapFree"))),
  };
}

export type CpuTimes = { idle: number; total: number };

/** The first line of /proc/stat. */
export function parseCpuTimes(text: string): CpuTimes | null {
  const match = /^cpu\s+(.+)$/m.exec(text);
  if (!match) {
    return null;
  }
  // user nice system idle iowait irq softirq steal; guest is already in user.
  const fields = match[1].trim().split(/\s+/).slice(0, 8).map(Number);
  return {
    idle: (fields[3] ?? 0) + (fields[4] ?? 0),
    total: fields.reduce((sum, value) => sum + value, 0),
  };
}

export function cpuPercent(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  if (total <= 0) {
    return null;
  }
  const busy = total - (after.idle - before.idle);
  return Math.round((busy / total) * 1000) / 10;
}

/** `agent-gate status`: the headline and both tables. */
export function parseGateStatus(text: string, now: number): LabHealthGate | null {
  const head = /^agent-gate: (\d+) of (\d+) running, (\d+) waiting/m.exec(text);
  if (!head) {
    return null;
  }
  const agents: LabHealthGate["agents"] = [];
  let inSlots = false;
  for (const line of text.split("\n")) {
    if (/^\s+slot\s+name\b/.test(line)) {
      inSlots = true;
      continue;
    }
    if (!inSlots) {
      continue;
    }
    if (!line.trim()) {
      break;
    }
    // slot name gate-pid age mem-GB procs; a long name leaves one space.
    const row = /^\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s/.exec(line);
    if (row) {
      agents.push({ name: row[2], memoryGb: Number(row[5]) });
    }
  }
  return {
    running: Number(head[1]),
    max: Number(head[2]),
    waiting: Number(head[3]),
    agents,
    sampledAt: now,
  };
}

/** One reply: its tokens and the stretches the model spent on it. A reply's
 * lines all carry its final total, written once it's finished, so its tokens
 * are spread over its whole time rather than landing on one moment. */
type TranscriptReply = { tokens: number; spans: { from: number; to: number }[] };

/** What the tail of one transcript says: reads whole lines, in order. */
export class TranscriptTail {
  private readonly replies = new Map<string, TranscriptReply>();
  /** Tools started and not answered yet; several can run side by side. */
  private readonly tools = new Set<string>();
  private currentReply: string | null = null;
  private waiting: "model" | "tool" | null = null;
  lastAt: number | null = null;

  /** One JSONL line. Anything that isn't a user or assistant message is skipped. */
  line(text: string): void {
    // Some lines are megabytes of request body; don't parse what can't match.
    if (!text.includes('"assistant"') && !text.includes('"user"')) {
      return;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      (entry.type !== "user" && entry.type !== "assistant") ||
      entry.isSidechain === true ||
      typeof entry.timestamp !== "string"
    ) {
      return;
    }
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) {
      return;
    }
    if (entry.type === "user") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const results = Array.isArray(content)
        ? content.filter((block) => (block as { type?: unknown } | null)?.type === "tool_result")
        : [];
      if (results.length === 0) {
        // A new prompt: anything still open was interrupted.
        this.tools.clear();
      }
      for (const block of results) {
        const id = (block as { tool_use_id?: unknown }).tool_use_id;
        if (typeof id === "string") {
          this.tools.delete(id);
        }
      }
      this.waiting = this.tools.size > 0 ? "tool" : "model";
      this.lastAt = at;
      return;
    }
    const message = (entry.message ?? {}) as {
      id?: unknown;
      usage?: { output_tokens?: unknown };
      content?: unknown;
    };
    const output = message.usage?.output_tokens;
    const id = typeof message.id === "string" ? message.id : `${at}`;
    const reply = this.replies.get(id) ?? { tokens: 0, spans: [] };
    this.replies.set(id, reply);
    this.currentReply = id;
    reply.tokens = Math.max(reply.tokens, typeof output === "number" ? output : 0);
    if (this.waiting === "model" && this.lastAt !== null && at > this.lastAt) {
      reply.spans.push({ from: this.lastAt, to: at });
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const item = block as { type?: unknown; id?: unknown } | null;
        if (item?.type === "tool_use") {
          this.tools.add(typeof item.id === "string" ? item.id : `${at}`);
        }
      }
    }
    this.waiting = this.tools.size > 0 ? "tool" : "model";
    this.lastAt = at;
  }

  waitingOn(): "model" | "tool" | null {
    return this.waiting;
  }

  /** Tokens per second of model time over the last minute. */
  rate(now: number): { tokensPerSecond: number | null; modelSeconds: number } {
    const from = now - RATE_WINDOW_MS;
    let tokens = 0;
    let modelMs = 0;
    for (const [id, reply] of this.replies) {
      const newest = reply.spans[reply.spans.length - 1];
      if (!newest || newest.to < from) {
        // The newest may still gain lines, and needs its whole time when it does.
        if (id !== this.currentReply) {
          this.replies.delete(id);
        }
        continue;
      }
      let total = 0;
      let inside = 0;
      for (const span of reply.spans) {
        total += span.to - span.from;
        inside += Math.max(0, span.to - Math.max(span.from, from));
      }
      tokens += reply.tokens * (inside / total);
      modelMs += inside;
    }
    const modelSeconds = modelMs / 1000;
    if (modelSeconds <= 0) {
      return { tokensPerSecond: null, modelSeconds: 0 };
    }
    return {
      tokensPerSecond: Math.round((tokens / Math.max(1, modelSeconds)) * 10) / 10,
      modelSeconds: Math.round(modelSeconds),
    };
  }
}

type Tracked = {
  path: string;
  tail: TranscriptTail;
  offset: number;
  partial: Buffer;
  /** Who it was read for: an entry in no list this read gets dropped. */
  seenAt: number;
};

type RegistryEntry = {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;
  statusUpdatedAt?: number;
  account: string;
};

export type LabHealthOptions = {
  /** Where /proc and /sys are; tests point it at a fake tree. */
  root?: string;
  home?: string;
  now?: () => number;
  machine?: string;
  cores?: number;
  /** `agent-gate status`'s output, or null when it can't be run. */
  gateStatus?: () => Promise<string | null>;
  /** Whether the process is still the one that wrote the record. */
  isAlive?: (pid: number, procStart: string | undefined) => boolean;
  /** Tests take samples themselves. */
  sampleTimer?: boolean;
};

export class HostLabHealth {
  private readonly root: string;
  private readonly home: string;
  private readonly now: () => number;
  private readonly machine: string;
  private readonly cores: number;
  private readonly gateStatus: () => Promise<string | null>;
  private readonly isAlive: (pid: number, procStart: string | undefined) => boolean;
  private readonly sampleTimer: boolean;
  private history: (LabHealthPoint & { swapUsedMb: number })[] = [];
  private cpuBefore: CpuTimes | null = null;
  private cpuNow: number | null = null;
  private lastPointAt = -Infinity;
  private thermal: string | null | undefined;
  private gate: LabHealthGate | null = null;
  private gateAt = -Infinity;
  private gateRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private askedAt = -Infinity;
  private readonly tracked = new Map<string, Tracked>();
  private reading: Promise<LabHealth> | null = null;

  constructor(options: LabHealthOptions = {}) {
    this.root = options.root ?? "/";
    this.home = options.home ?? homedir();
    this.now = options.now ?? Date.now;
    this.machine = options.machine ?? hostname();
    this.cores = options.cores ?? (cpus().length || 1);
    this.gateStatus = options.gateStatus ?? (() => runGateStatus(this.home));
    this.isAlive = options.isAlive ?? ((pid, start) => this.processAlive(pid, start));
    this.sampleTimer = options.sampleTimer ?? true;
  }

  private text(...path: string[]): string {
    try {
      return readFileSync(join(this.root, ...path), "utf8");
    } catch {
      return "";
    }
  }

  private processAlive(pid: number, procStart: string | undefined): boolean {
    const stat = this.text("proc", String(pid), "stat");
    if (!stat) {
      return false;
    }
    if (!procStart) {
      return true;
    }
    // Field 22, counted after the command name, which may hold spaces.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return after[19] === procStart;
  }

  /** One sample: the CPU's use since the last one, and a history point. */
  sample(): void {
    const now = this.now();
    const times = parseCpuTimes(this.text("proc", "stat"));
    if (times) {
      if (this.cpuBefore) {
        this.cpuNow = cpuPercent(this.cpuBefore, times) ?? this.cpuNow;
      }
      this.cpuBefore = times;
    }
    if (now - this.lastPointAt < SAMPLE_MS - 1000) {
      return;
    }
    this.lastPointAt = now;
    const memory = parseMeminfo(this.text("proc", "meminfo"));
    this.history.push({
      at: now,
      cpu: this.cpuNow,
      memoryAvailable: memory.totalMb
        ? Math.round((memory.availableMb / memory.totalMb) * 1000) / 10
        : 0,
      swapUsedMb: memory.swapUsedMb,
    });
    this.history = this.history.filter((point) => now - point.at <= HISTORY_MS);
  }

  private watch(now: number): void {
    this.askedAt = now;
    if (!this.sampleTimer || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.now() - this.askedAt > WATCH_MS) {
        this.stop();
        return;
      }
      this.sample();
    }, SAMPLE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Starts a look at agent-gate if the last one is old; never waits for it. */
  refreshGate(now: number): Promise<void> {
    if (this.gateRunning || now - this.gateAt < GATE_EVERY_MS) {
      return Promise.resolve();
    }
    this.gateRunning = true;
    this.gateAt = now;
    return this.gateStatus()
      .then((text) => {
        const parsed = text ? parseGateStatus(text, this.now()) : null;
        // A failed look keeps the last answer; its sampledAt shows its age.
        this.gate = parsed ?? this.gate;
      })
      .catch(() => {})
      .finally(() => {
        this.gateRunning = false;
      });
  }

  private climb(now: number, usedMb: number): number {
    const before = this.history.find(
      (point) => now - point.at <= SWAP_MAX_AGE_MS && now - point.at >= SWAP_MIN_AGE_MS,
    );
    if (!before) {
      return 0;
    }
    const minutes = (now - before.at) / 60_000;
    return Math.max(0, Math.round((usedMb - before.swapUsedMb) / minutes));
  }

  private temperature(): number | null {
    if (this.thermal === undefined) {
      this.thermal = null;
      try {
        const zones = readdirSync(join(this.root, "sys/class/thermal")).filter((name) =>
          name.startsWith("thermal_zone"),
        );
        const types = zones.map((zone) => ({
          zone,
          type: this.text("sys/class/thermal", zone, "type").trim(),
        }));
        for (const wanted of THERMAL_ZONES) {
          const hit = types.find((entry) => entry.type === wanted);
          if (hit) {
            this.thermal = hit.zone;
            break;
          }
        }
      } catch {
        // No thermal zones here.
      }
    }
    if (!this.thermal) {
      return null;
    }
    const milli = Number(this.text("sys/class/thermal", this.thermal, "temp").trim());
    return Number.isFinite(milli) && milli > 0 ? Math.round(milli / 1000) : null;
  }

  private power(): LabHealth["power"] {
    let source: "ac" | "battery" | null = null;
    let batteryPercent: number | null = null;
    let names: string[] = [];
    try {
      names = readdirSync(join(this.root, "sys/class/power_supply"));
    } catch {
      return { source, batteryPercent };
    }
    for (const name of names) {
      const type = this.text("sys/class/power_supply", name, "type").trim();
      if (type === "Mains") {
        source = this.text("sys/class/power_supply", name, "online").trim() === "1" ? "ac" : "battery";
      } else if (type === "Battery") {
        const percent = Number(this.text("sys/class/power_supply", name, "capacity").trim());
        batteryPercent = Number.isFinite(percent) ? percent : null;
      }
    }
    return { source, batteryPercent };
  }

  private async registry(): Promise<RegistryEntry[]> {
    const found = new Map<string, RegistryEntry>();
    for (const account of ACCOUNTS) {
      const dir = join(this.home, account, "sessions");
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        try {
          const entry = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;
          if (
            isRelayEntry(entry) ||
            typeof entry.pid !== "number" ||
            typeof entry.sessionId !== "string" ||
            typeof entry.cwd !== "string" ||
            found.has(entry.sessionId) ||
            !this.isAlive(entry.pid, typeof entry.procStart === "string" ? entry.procStart : undefined)
          ) {
            continue;
          }
          found.set(entry.sessionId, {
            pid: entry.pid,
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            name: typeof entry.name === "string" ? entry.name : undefined,
            status: typeof entry.status === "string" ? entry.status : undefined,
            statusUpdatedAt:
              typeof entry.statusUpdatedAt === "number" ? entry.statusUpdatedAt : undefined,
            account,
          });
        } catch {
          // A registry file mid-write, or another agent's: next time.
        }
      }
    }
    return [...found.values()];
  }

  private async findTranscript(entry: RegistryEntry): Promise<string | null> {
    const folder = entry.cwd.replace(/[^A-Za-z0-9]/g, "-");
    const accounts = [entry.account, ...ACCOUNTS.filter((account) => account !== entry.account)];
    for (const account of accounts) {
      const path = join(this.home, account, "projects", folder, `${entry.sessionId}.jsonl`);
      if (existsSync(path)) {
        return path;
      }
    }
    return null;
  }

  /** Reads what a transcript gained. Returns its modified time; null if gone. */
  private async readTail(sessionId: string, path: string, now: number): Promise<{ tracked: Tracked; mtime: number } | null> {
    let tracked = this.tracked.get(sessionId);
    if (!tracked || tracked.path !== path) {
      tracked = { path, tail: new TranscriptTail(), offset: -1, partial: Buffer.alloc(0), seenAt: now };
      this.tracked.set(sessionId, tracked);
    }
    tracked.seenAt = now;
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    const size = info.size;
    if (size < tracked.offset) {
      tracked.offset = -1;
    }
    let from = tracked.offset;
    let skipFirst = false;
    if (from < 0 || size - from > DELTA_MAX_BYTES) {
      from = Math.max(0, size - TAIL_BYTES);
      skipFirst = from > 0;
      tracked.partial = Buffer.alloc(0);
      // Lines were skipped, maybe a tool's answer: what it knew may be wrong.
      tracked.tail = new TranscriptTail();
    }
    if (size > from) {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(size - from);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        tracked.offset = from + bytesRead;
        let data = Buffer.concat([tracked.partial, buffer.subarray(0, bytesRead)]);
        if (skipFirst) {
          const first = data.indexOf(0x0a);
          data = first < 0 ? Buffer.alloc(0) : data.subarray(first + 1);
        }
        const end = data.lastIndexOf(0x0a);
        if (end >= 0) {
          for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
            tracked.tail.line(line);
          }
        }
        const rest = data.subarray(end + 1);
        tracked.partial = rest.length > PARTIAL_MAX_BYTES ? Buffer.alloc(0) : Buffer.from(rest);
      } finally {
        await handle.close();
      }
    } else {
      tracked.offset = from;
    }
    return { tracked, mtime: info.mtimeMs };
  }

  private async session(entry: RegistryEntry, now: number): Promise<LabHealthSession> {
    const busy = entry.status === "busy";
    const base: LabHealthSession = {
      sessionId: entry.sessionId,
      name: entry.name || entry.cwd.split("/").pop() || entry.sessionId.slice(0, 8),
      busy,
      quietMs: null,
      tokensPerSecond: null,
      modelSeconds: 0,
      turnMs: busy && entry.statusUpdatedAt ? Math.max(0, now - entry.statusUpdatedAt) : null,
      waitingOn: null,
    };
    const path = await this.findTranscript(entry);
    if (!path) {
      return base;
    }
    let read;
    try {
      read = await this.readTail(entry.sessionId, path, now);
    } catch {
      return base;
    }
    if (!read) {
      return base;
    }
    const { tail } = read.tracked;
    const rate = tail.rate(now);
    return {
      ...base,
      // Messages, not the file's time: housekeeping lines keep touching the file.
      quietMs: Math.max(0, now - (tail.lastAt ?? read.mtime)),
      tokensPerSecond: rate.tokensPerSecond,
      modelSeconds: rate.modelSeconds,
      waitingOn: busy ? tail.waitingOn() : null,
    };
  }

  /** Callers at the same moment share one read: two at once would read the
   * same new end of a transcript and count it twice. */
  read(): Promise<LabHealth> {
    this.reading ??= this.readNow().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readNow(): Promise<LabHealth> {
    const now = this.now();
    this.watch(now);
    void this.refreshGate(now);
    this.sample();

    const loadavg = this.text("proc", "loadavg").trim().split(/\s+/);
    const memory = parseMeminfo(this.text("proc", "meminfo"));
    const entries = (await this.registry()).slice(0, MAX_SESSIONS);
    const sessions = await Promise.all(entries.map((entry) => this.session(entry, now)));
    for (const [id, tracked] of this.tracked) {
      if (tracked.seenAt !== now) {
        this.tracked.delete(id);
      }
    }
    return {
      version: 1,
      machine: this.machine,
      at: now,
      cpu: {
        percent: this.cpuNow,
        load1: Number(loadavg[0]) || 0,
        load5: Number(loadavg[1]) || 0,
        cores: this.cores,
      },
      memory: { totalMb: memory.totalMb, availableMb: memory.availableMb },
      pressure: {
        memory: parsePressure(this.text("proc", "pressure", "memory")),
        cpu: parsePressure(this.text("proc", "pressure", "cpu")),
        io: parsePressure(this.text("proc", "pressure", "io")),
      },
      swap: {
        totalMb: memory.swapTotalMb,
        usedMb: memory.swapUsedMb,
        climbMbPerMin: this.climb(now, memory.swapUsedMb),
      },
      temperatureC: this.temperature(),
      power: this.power(),
      gate: this.gate,
      sessions,
      history: this.history.map(({ at, cpu, memoryAvailable }) => ({ at, cpu, memoryAvailable })),
    };
  }
}

function runGateStatus(home: string): Promise<string | null> {
  const path = join(home, ".local/bin/agent-gate");
  if (!existsSync(path)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(path, ["status"], { timeout: GATE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

let active: HostLabHealth | null = null;

/** One per host process: it keeps the history and each transcript's place. */
export function hostLabHealth(): HostLabHealth {
  active ??= new HostLabHealth();
  return active;
}
