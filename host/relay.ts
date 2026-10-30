import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { HostStore } from "./store";
import type {
  RelayDelivery,
  RelayNextResult,
  RelayRegistryEntry,
  RelaySendResult,
  RelayStatus,
  RelaySyncResult,
} from "../src/fork/lab/labProtocol";
import type { RelayTrafficAnswer } from "../src/fork/messageLog/messageLogProtocol";
import { sessionLiveness } from "./external-sessions";
import { RelayTraffic } from "./relay-traffic";
import {
  cleanMachine,
  cleanSession,
  cleanSockDir,
  DeliveryQueue,
  type QueueDrop,
  frameSender,
  LINE_MAX,
  NEXT_WAIT_MAX_MS,
  PEER_SESSIONS_MAX,
  PidTable,
  QUEUE_TTL_MS,
  readFrame,
  rewriteFrame,
  type PeerSession,
} from "./relay-core";
import {
  cleanHostEntries,
  discoverSessions,
  removeEntry,
  resolveSockDir,
  writeEntry,
  type HostRelayEntry,
  type Liveness,
  type LocalSession,
} from "./relay-registry";

export type RelayMethod = "relay.sync" | "relay.send" | "relay.next" | "relay.traffic";

export type HostRelayOptions = {
  dataDir: string;
  store: HostStore;
  /** The home folder holding the Claude account folders. */
  home?: string;
  /** Claude's socket folder here; found from live sessions when unset. */
  sockDir?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** This machine's name in relayed entries. */
  machine?: string;
  isAlive?: Liveness;
  /** How often to look for new sessions and silent peers; 0 never. */
  sweepMs?: number;
};

/** A peer that stops syncing for this long is gone. */
// Longer than a desktop's failed sync (30 s timeout, then 30 s backoff) twice
// over, so one bad patch of network does not drop its sessions and queues.
export const PEER_TTL_MS = 120_000;
const SYNC_ON_MS = 3_000;
const SYNC_OFF_MS = 20_000;
const SWEEP_MS = 3_000;
/** Look at the registries again when they are older than this. */
const DISCOVER_FRESH_MS = 1_000;
const CONNECT_TIMEOUT_MS = 2_000;
/** Claude's own senders keep the connection this long after writing. */
const LINGER_MS = 150;
const SOCKET_IDLE_MS = 10_000;
/** The target key of proxies on this machine; peers use their device id. */
const HOST = "host";

type Peer = {
  id: string;
  name: string;
  machine: string;
  sockDir: string;
  sessions: Map<string, PeerSession>;
  seen: Map<string, Seen>;
  lastSeen: number;
};

/** When a session was first seen and its status last changed, so its entry
 *  stays the same across syncs while nothing about it changes. */
type Seen = { firstSeen: number; status: string; statusAt: number };

function track(previous: Seen | undefined, status: string | undefined, now: number): Seen {
  const current = status ?? "idle";
  if (!previous) return { firstSeen: now, status: current, statusAt: now };
  if (previous.status === current) return previous;
  return { firstSeen: previous.firstSeen, status: current, statusAt: now };
}

type Proxy = {
  pid: number;
  peerId: string;
  sessionId: string;
  socket: string;
  server: Server;
  connections: Set<Socket>;
  signature: string;
  createdAt: number;
  updatedAt: number;
};

type State = { enabled: boolean; updatedAt: number };

/**
 * Lets Claude sessions on different machines and accounts message each
 * other: each session elsewhere gets a proxy socket and registry entry here,
 * and paired desktops do the same on their side through relay.*.
 */
export class HostRelay {
  private state: State;
  private readonly home: string;
  private readonly now: () => number;
  private readonly machine: string;
  private started?: Promise<void>;
  private running = false;
  private timer?: NodeJS.Timeout;
  private locals = new Map<string, LocalSession>();
  private localSeen = new Map<string, Seen>();
  private localsAt = 0;
  private sockDir: string | null = null;
  private readonly peers = new Map<string, Peer>();
  private readonly queues = new Map<string, DeliveryQueue>();
  /** Peers whose full queue is dropping lines, so the log says it once. */
  private readonly dropping = new Set<string>();
  /** Proxy pids by target machine: HOST, or a peer's device id. */
  private readonly pids = new Map<string, PidTable>();
  private readonly proxies = new Map<number, Proxy>();
  /** What happened to each line carried; peers' names outlive the peers so
   *  lines dropped as a peer goes still say whose they were. */
  private readonly traffic: RelayTraffic;
  private readonly peerNames = new Map<string, { name: string; machine: string }>();
  /** Why queued lines are being cleared, while they are. */
  private clearing = "The relay dropped it";
  private chain: Promise<unknown> = Promise.resolve();
  private seqValue: number;
  private readonly seq = {
    next: () => ++this.seqValue,
    current: () => this.seqValue,
  };

  constructor(readonly options: HostRelayOptions) {
    this.home = options.home ?? homedir();
    this.now = options.now ?? Date.now;
    this.machine = cleanMachine(options.machine ?? hostname().split(".")[0], "host");
    // Starts from the clock, so a desktop's cursor from an earlier run is
    // behind this run's deliveries rather than ahead of them.
    this.seqValue = this.now();
    this.traffic = new RelayTraffic(this.now);
    this.state = { enabled: false, updatedAt: 0 };
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof raw?.enabled === "boolean") {
        this.state = {
          enabled: raw.enabled,
          updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0,
        };
      }
    } catch {
      // Off until someone turns it on.
    }
  }

  /** This machine's name in relayed entries. */
  get machineName(): string {
    return this.machine;
  }

  /** The hops recorded since `params.since`. */
  trafficAnswer(params: Record<string, unknown>): RelayTrafficAnswer {
    const since = params.since as { epoch?: unknown; cursor?: unknown } | undefined;
    const valid =
      since && typeof since === "object" && typeof since.epoch === "string" && typeof since.cursor === "number"
        ? { epoch: since.epoch, cursor: since.cursor }
        : undefined;
    return this.traffic.answer(valid ? { since: valid } : {}, this.machine, this.state.enabled);
  }

  /** Switched on, and not closed. */
  private get on() {
    return this.state.enabled && this.running;
  }

  private get statePath() {
    return join(this.options.dataDir, "relay.json");
  }

  /** Loads the saved switch, clears copies an earlier run left, and starts
   *  when the relay is on. */
  async start(): Promise<void> {
    this.started ??= (async () => {
      await cleanHostEntries(this.home);
      if (this.state.enabled) await this.begin();
    })();
    return this.started;
  }

  status(): RelayStatus {
    const peers = [...this.peers.values()]
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        sessions: peer.sessions.size,
        lastSeen: peer.lastSeen,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      enabled: this.state.enabled,
      updatedAt: this.state.updatedAt,
      peers,
      sessions:
        (this.running ? this.locals.size : 0) +
        peers.reduce((total, peer) => total + peer.sessions, 0),
    };
  }

  async setEnabled(enabled: boolean): Promise<RelayStatus> {
    if (typeof enabled !== "boolean") throw new Error("Say on or off");
    await this.start();
    this.state = { enabled, updatedAt: this.now() };
    await this.save();
    if (enabled) {
      await this.begin();
    } else {
      await this.teardown();
    }
    return this.status();
  }

  async handle(
    method: RelayMethod,
    params: Record<string, unknown>,
    device: { id: string; name: string } | null,
  ): Promise<unknown> {
    if (!device) throw new Error("This device is not paired");
    await this.start();
    switch (method) {
      case "relay.sync":
        return this.sync(params, device);
      case "relay.send":
        return this.send(params, device);
      case "relay.next":
        return this.next(params, device);
      case "relay.traffic":
        return this.trafficAnswer(params);
      default:
        throw new Error("Unsupported relay method");
    }
  }

  /** Closes every proxy and removes the copies it wrote. */
  async close(): Promise<void> {
    await this.teardown();
  }

  /** Drops silent peers and picks up sessions that came or went here; runs
   *  every few seconds while the relay is on. */
  async sweep(): Promise<void> {
    if (!this.running) return;
    const oldest = this.now() - PEER_TTL_MS;
    for (const peer of [...this.peers.values()]) {
      if (peer.lastSeen >= oldest) continue;
      this.peers.delete(peer.id);
      this.pids.delete(peer.id);
      this.clearing = `${peer.name} stopped answering`;
      this.queues.get(peer.id)?.clear();
      this.queues.get(peer.id)?.wake();
    }
    await this.discover(true);
    await this.reconcile();
  }

  private async save(): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.statePath);
  }

  private async begin(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.discover(true);
    const every = this.options.sweepMs ?? SWEEP_MS;
    if (every > 0) {
      this.timer = setInterval(() => {
        void this.sweep().catch(() => undefined);
      }, every);
      this.timer.unref();
    }
  }

  private async teardown(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.peers.clear();
    this.pids.clear();
    this.locals.clear();
    this.localSeen.clear();
    this.localsAt = 0;
    this.clearing = "The relay was switched off";
    for (const queue of this.queues.values()) {
      queue.clear();
      queue.wake();
    }
    await this.exclusive(async () => {
      for (const proxy of [...this.proxies.values()]) await this.closeProxy(proxy);
    });
  }

  /** Runs `work` after every earlier proxy change has finished. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private table(target: string): PidTable {
    let table = this.pids.get(target);
    if (!table) {
      table = new PidTable();
      this.pids.set(target, table);
    }
    return table;
  }

  private queue(peerId: string): DeliveryQueue {
    let queue = this.queues.get(peerId);
    if (!queue) {
      queue = new DeliveryQueue(this.now, this.seq, (delivery, drop) => this.settled(peerId, delivery, drop));
      this.queues.set(peerId, queue);
    }
    return queue;
  }

  /** Records a queued line's fate: handed to the peer, or dropped. */
  private settled(peerId: string, delivery: RelayDelivery, drop?: QueueDrop): void {
    const known = this.peerNames.get(peerId);
    const name = known?.name ?? "the other machine";
    const reasons: Record<QueueDrop, string> = {
      expired: `Not picked up within ${QUEUE_TTL_MS / 1000} s`,
      full: `The queue for ${name} was full`,
      cleared: this.clearing,
    };
    const toName = this.peers.get(peerId)?.sessions.get(delivery.to)?.name;
    this.traffic.recordLine(delivery.line, {
      peer: known?.machine ?? "peer",
      direction: "out",
      outcome: drop ? "dropped" : "passed",
      ...(drop ? { reason: reasons[drop] } : {}),
      ...(toName ? { toName } : {}),
      toSessionId: delivery.to,
    });
  }

  /** Records a line for a peer dropped because it got too long to relay. */
  private tooLong(line: string, peer: Peer, to: string): void {
    const toName = peer.sessions.get(to)?.name;
    this.traffic.recordLine(line, {
      peer: peer.machine,
      direction: "out",
      outcome: "dropped",
      reason: "Too long to relay",
      ...(toName ? { toName } : {}),
      toSessionId: to,
    });
  }

  /** Queues a line for a peer. A full queue drops it, logged once until a
   *  line fits again. */
  private enqueue(peer: Peer, delivery: RelayDelivery): boolean {
    this.peerNames.set(peer.id, { name: peer.name, machine: peer.machine });
    if (this.queue(peer.id).push(delivery)) {
      this.dropping.delete(peer.id);
      return true;
    }
    this.traffic.recordLine(delivery.line, {
      peer: peer.machine,
      direction: "out",
      outcome: "dropped",
      reason: `The queue for ${peer.name} was full`,
      ...(peer.sessions.get(delivery.to)?.name ? { toName: peer.sessions.get(delivery.to)!.name } : {}),
      toSessionId: delivery.to,
    });
    if (!this.dropping.has(peer.id)) {
      this.dropping.add(peer.id);
      console.error(`The relay is dropping messages for ${peer.name}: too much is waiting`);
    }
    return false;
  }

  /** Reads this machine's live sessions again, unless that was just done. */
  private async discover(force = false): Promise<void> {
    if (!this.running) return;
    if (!force && this.now() - this.localsAt < DISCOVER_FRESH_MS) return;
    const isAlive = this.options.isAlive ?? sessionLiveness();
    const sessions = await discoverSessions(this.home, isAlive);
    this.locals = new Map(sessions.map((session) => [session.sessionId, session]));
    this.localsAt = this.now();
    const seen = new Map<string, Seen>();
    for (const session of sessions) {
      seen.set(session.sessionId, track(this.localSeen.get(session.sessionId), session.status, this.localsAt));
    }
    this.localSeen = seen;
    this.sockDir =
      this.options.sockDir ??
      (await resolveSockDir(sessions, {
        env: this.options.env ?? process.env,
        uid: this.options.uid ?? process.getuid?.() ?? 0,
      }));
  }

  private async sync(
    params: Record<string, unknown>,
    device: { id: string; name: string },
  ): Promise<RelaySyncResult> {
    if (!this.on) return { enabled: false, entries: [], nextSyncMs: SYNC_OFF_MS };
    const sockDir = cleanSockDir(params.sockDir);
    if (!sockDir) throw new Error("Give a plain socket folder");
    if (!Array.isArray(params.sessions)) throw new Error("Give the sessions");
    const sessions = new Map<string, PeerSession>();
    for (const value of params.sessions.slice(0, PEER_SESSIONS_MAX)) {
      const session = cleanSession(value);
      if (session && !sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
    }
    const now = this.now();
    const known = this.peers.get(device.id);
    const seen = new Map<string, Seen>();
    for (const [id, session] of sessions) seen.set(id, track(known?.seen.get(id), session.status, now));
    if (known && known.sockDir !== sockDir) this.pids.delete(device.id);
    this.peers.set(device.id, {
      id: device.id,
      name: device.name,
      machine: cleanMachine(params.machine, cleanMachine(device.name, "peer")),
      sockDir,
      sessions,
      seen,
      lastSeen: now,
    });
    await this.discover();
    await this.reconcile();
    const peer = this.peers.get(device.id);
    if (!peer || !this.on) return { enabled: false, entries: [], nextSyncMs: SYNC_OFF_MS };
    return { enabled: true, entries: this.entriesFor(peer), nextSyncMs: SYNC_ON_MS };
  }

  /** The entries a peer writes on its side: one per session elsewhere. */
  private entriesFor(peer: Peer): RelayRegistryEntry[] {
    const table = this.table(peer.id);
    const entries: RelayRegistryEntry[] = [];
    for (const session of this.locals.values()) {
      const pid = table.pid(HOST, session.sessionId);
      const seen = this.localSeen.get(session.sessionId);
      const firstSeen = seen?.firstSeen ?? this.localsAt;
      const statusAt = seen?.statusAt ?? firstSeen;
      entries.push(
        this.entry(pid, peer.sockDir, this.machine, session, {
          startedAt: session.startedAt ?? firstSeen,
          updatedAt: session.updatedAt ?? statusAt,
          statusUpdatedAt: session.statusUpdatedAt ?? statusAt,
        }),
      );
    }
    for (const other of this.peers.values()) {
      if (other.id === peer.id) continue;
      for (const session of other.sessions.values()) {
        const pid = table.pid(other.id, session.sessionId);
        const seen = other.seen.get(session.sessionId);
        entries.push(
          this.entry(pid, peer.sockDir, other.machine, session, {
            startedAt: seen?.firstSeen ?? 0,
            updatedAt: seen?.statusAt ?? 0,
            statusUpdatedAt: seen?.statusAt ?? 0,
          }),
        );
      }
    }
    table.retain((sourceKey, sessionId) =>
      sourceKey === HOST
        ? this.locals.has(sessionId)
        : !!this.peers.get(sourceKey)?.sessions.has(sessionId),
    );
    return entries.sort((a, b) => a.pid - b.pid);
  }

  private entry(
    pid: number,
    sockDir: string,
    machine: string,
    session: PeerSession | LocalSession,
    times: { startedAt: number; updatedAt: number; statusUpdatedAt: number },
  ): RelayRegistryEntry {
    return {
      pid,
      sessionId: session.sessionId,
      cwd: session.cwd,
      startedAt: times.startedAt,
      version: session.version ?? "relay",
      peerProtocol: 1,
      peerFeatures: [],
      kind: session.kind ?? "interactive",
      entrypoint: "relay",
      pidDomain: `relay:${machine}`,
      messagingSocketPath: `${sockDir}/${pid}.sock`,
      name: session.name,
      nameSource: "derived",
      status: session.status ?? "idle",
      updatedAt: times.updatedAt,
      statusUpdatedAt: times.statusUpdatedAt,
      ...(session.bridgeSessionId ? { bridgeSessionId: session.bridgeSessionId } : {}),
      monocodeRelay: { machine, account: session.account, remoteSessionId: session.sessionId },
    };
  }

  /** Makes this machine's proxies match the peers' sessions. */
  private reconcile(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.running || !this.sockDir) {
        for (const proxy of [...this.proxies.values()]) await this.closeProxy(proxy);
        return;
      }
      const sockDir = this.sockDir;
      const table = this.table(HOST);
      table.retain((peerId, sessionId) => !!this.peers.get(peerId)?.sessions.has(sessionId));
      const wanted = new Map<number, { peer: Peer; session: PeerSession }>();
      for (const peer of this.peers.values()) {
        for (const session of peer.sessions.values()) {
          wanted.set(table.pid(peer.id, session.sessionId), { peer, session });
        }
      }
      for (const proxy of [...this.proxies.values()]) {
        const want = wanted.get(proxy.pid);
        if (
          !want ||
          want.peer.id !== proxy.peerId ||
          want.session.sessionId !== proxy.sessionId ||
          proxy.socket !== `${sockDir}/${proxy.pid}.sock`
        ) {
          await this.closeProxy(proxy);
        }
      }
      await mkdir(sockDir, { recursive: true, mode: 0o700 });
      for (const [pid, { peer, session }] of wanted) {
        try {
          await this.openProxy(pid, sockDir, peer, session);
        } catch (error) {
          console.error(
            `The relay could not listen for ${session.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
  }

  private hostEntry(proxy: Proxy, peer: Peer, session: PeerSession): HostRelayEntry {
    const entry = this.entry(
      proxy.pid,
      proxy.socket.slice(0, proxy.socket.lastIndexOf("/")),
      peer.machine,
      session,
      {
        startedAt: peer.seen.get(session.sessionId)?.firstSeen ?? proxy.createdAt,
        updatedAt: proxy.updatedAt,
        statusUpdatedAt: proxy.updatedAt,
      },
    );
    return {
      ...entry,
      monocodeRelay: { ...entry.monocodeRelay, writer: "host" },
    };
  }

  private async openProxy(pid: number, sockDir: string, peer: Peer, session: PeerSession) {
    const signature = JSON.stringify([peer.machine, session]);
    const current = this.proxies.get(pid);
    if (current) {
      if (current.signature === signature) return;
      current.signature = signature;
      current.updatedAt = this.now();
      await writeEntry(this.home, this.hostEntry(current, peer, session));
      return;
    }
    const socket = `${sockDir}/${pid}.sock`;
    await unlink(socket).catch(() => undefined);
    const connections = new Set<Socket>();
    const server = createServer((connection) => {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
      this.accept(connection, pid);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", () => undefined);
    const now = this.now();
    const proxy: Proxy = {
      pid,
      peerId: peer.id,
      sessionId: session.sessionId,
      socket,
      server,
      connections,
      signature,
      createdAt: now,
      updatedAt: now,
    };
    this.proxies.set(pid, proxy);
    try {
      await chmod(socket, 0o600);
      await writeEntry(this.home, this.hostEntry(proxy, peer, session));
    } catch (error) {
      await this.closeProxy(proxy);
      throw error;
    }
  }

  private async closeProxy(proxy: Proxy): Promise<void> {
    this.proxies.delete(proxy.pid);
    const closed = new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    for (const connection of proxy.connections) connection.destroy();
    await closed;
    await unlink(proxy.socket).catch(() => undefined);
    await removeEntry(this.home, proxy.pid).catch(() => undefined);
  }

  /** Reads NDJSON lines a local session writes to a proxy. */
  private accept(connection: Socket, pid: number): void {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.setTimeout(SOCKET_IDLE_MS, () => connection.destroy());
    connection.on("error", () => undefined);
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.fromLocal(pid, line).catch(() => undefined);
      }
      if (buffer.length > LINE_MAX) {
        buffer = "";
        connection.destroy();
      }
    });
    connection.on("end", () => {
      if (buffer.trim()) void this.fromLocal(pid, buffer).catch(() => undefined);
      buffer = "";
      connection.end();
    });
  }

  /** A line a local session wrote to the proxy `pid`: queued for the peer
   *  whose session that proxy stands for. */
  private async fromLocal(pid: number, line: string): Promise<void> {
    const proxy = this.proxies.get(pid);
    if (!proxy || !this.running) return;
    const peer = this.peers.get(proxy.peerId);
    const target = peer?.sessions.get(proxy.sessionId);
    if (!peer || !target) return;
    const frame = readFrame(line);
    if (!frame) return;
    const senderSocket = frameSender(frame);
    if (!senderSocket) return;
    let sender = this.localBySocket(senderSocket);
    if (!sender) {
      await this.discover();
      sender = this.localBySocket(senderSocket);
    }
    if (!sender) return;
    const fromPid = this.table(peer.id).pid(HOST, sender.sessionId);
    const rewritten = rewriteFrame(frame, `${peer.sockDir}/${fromPid}.sock`);
    if (!rewritten) {
      this.tooLong(line, peer, target.sessionId);
      return;
    }
    // Nothing to answer here.
    this.enqueue(peer, { to: target.sessionId, fromPid, line: rewritten });
  }

  private localBySocket(socket: string): LocalSession | undefined {
    for (const session of this.locals.values()) if (session.socket === socket) return session;
    return undefined;
  }

  private async send(
    params: Record<string, unknown>,
    device: { id: string; name: string },
  ): Promise<RelaySendResult> {
    if (!this.on) return { accepted: false, reason: "The relay is off" };
    const peer = this.peers.get(device.id);
    if (!peer) return { accepted: false, reason: "Sync first" };
    const sender = typeof params.from === "string" ? peer.sessions.get(params.from) : undefined;
    if (!sender) return { accepted: false, reason: "Unknown sender" };
    const to = Number(params.to);
    const target = Number.isSafeInteger(to) ? this.table(peer.id).lookup(to) : undefined;
    if (!target) return { accepted: false, reason: "Unknown target" };
    if (typeof params.line !== "string") return { accepted: false, reason: "No line" };
    const frame = readFrame(params.line);
    if (!frame) return { accepted: false, reason: "Not a message" };

    if (target.sourceKey !== HOST) {
      const other = this.peers.get(target.sourceKey);
      const session = other?.sessions.get(target.sessionId);
      if (!other || !session) return { accepted: false, reason: "Unknown target" };
      const fromPid = this.table(other.id).pid(peer.id, sender.sessionId);
      const line = rewriteFrame(frame, `${other.sockDir}/${fromPid}.sock`);
      if (!line) {
        this.tooLong(params.line, other, session.sessionId);
        return { accepted: false, reason: "Too long" };
      }
      if (!this.enqueue(other, { to: session.sessionId, fromPid, line })) {
        return { accepted: false, reason: "Too much is waiting" };
      }
      return { accepted: true };
    }

    let local = this.locals.get(target.sessionId);
    if (!local) {
      await this.discover();
      local = this.locals.get(target.sessionId);
    }
    const handed = (outcome: "passed" | "dropped", reason?: string) =>
      this.traffic.recordLine(params.line as string, {
        peer: peer.machine,
        direction: "in",
        outcome,
        ...(reason ? { reason } : {}),
        ...(local ? { toName: local.name } : {}),
        toSessionId: target.sessionId,
      });
    if (!local) {
      handed("dropped", "That session has closed");
      return { accepted: false, reason: "That session has ended" };
    }
    // Replies and receipts come back to the proxy standing for the sender,
    // which must be this process, listening, before the line goes out.
    const proxyPid = this.table(HOST).pid(peer.id, sender.sessionId);
    if (!this.proxies.has(proxyPid)) await this.reconcile();
    const proxy = this.proxies.get(proxyPid);
    if (!proxy) {
      handed("dropped", "The relay was not ready for it");
      return { accepted: false, reason: "Not ready" };
    }
    const line = rewriteFrame(frame, proxy.socket);
    if (!line) {
      handed("dropped", "Too long to relay");
      return { accepted: false, reason: "Too long" };
    }
    try {
      await deliver(local.socket, line);
    } catch {
      handed("dropped", "The session did not answer");
      return { accepted: false, reason: "The session did not answer" };
    }
    handed("passed");
    return { accepted: true };
  }

  private async next(
    params: Record<string, unknown>,
    device: { id: string; name: string },
  ): Promise<RelayNextResult> {
    const cursor =
      typeof params.cursor === "number" && Number.isSafeInteger(params.cursor) && params.cursor > 0
        ? params.cursor
        : 0;
    if (!this.on) return { cursor, deliveries: [], enabled: false };
    const waitMs =
      typeof params.waitMs === "number" && Number.isFinite(params.waitMs) && params.waitMs > 0
        ? Math.min(params.waitMs, NEXT_WAIT_MAX_MS)
        : 0;
    const answer = await this.queue(device.id).next(cursor, waitMs);
    if (!this.on) return { cursor, deliveries: [], enabled: false };
    return { ...answer, enabled: true };
  }
}

/** Writes one line to a session's real socket and keeps the connection a
 *  moment, as Claude's own senders do. */
function deliver(socketPath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => fail(new Error("Timed out")), CONNECT_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("data", () => undefined);
    socket.once("connect", () => {
      socket.write(`${line}\n`, (error) => {
        if (error) return fail(error);
        clearTimeout(timer);
        settled = true;
        resolve();
        setTimeout(() => socket.end(), LINGER_MS).unref();
      });
    });
  });
}

let active: HostRelay | undefined;

/** The host's relay, made on first use. */
export function hostRelay(options: HostRelayOptions): HostRelay {
  if (!active || active.options.dataDir !== options.dataDir) {
    active = new HostRelay(options);
  }
  return active;
}
