import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import type {
  RelayNextResult,
  RelayRegistryEntry,
  RelaySendResult,
  RelaySyncResult,
} from "../src/fork/lab/labProtocol";
import type { HostStore } from "./store";
import { HostRelay, PEER_TTL_MS } from "./relay";
import { discoverSessions, resolveSockDir, type LocalSession } from "./relay-registry";

const S1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const S2 = "22222222-bbbb-4bbb-8bbb-000000000002";
const T1 = "33333333-cccc-4ccc-8ccc-000000000003";
const U1 = "44444444-dddd-4ddd-8ddd-000000000004";
const MAC = { id: "dev-mac", name: "Sam's Mac" };
const AIR = { id: "dev-air", name: "Air" };
const PEER_SOCKS = "/tmp/cc-socks";

type FakeSession = { server: Server; lines: string[]; socket: string };

let root: string;
let home: string;
let socks: string;
let clock: number;
let fakes: FakeSession[];
let relay: HostRelay;

function write(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function listen(socket: string): Promise<FakeSession> {
  const lines: string[] = [];
  const server = createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    connection.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const fake = { server, lines, socket };
  fakes.push(fake);
  return fake;
}

/** A fake Claude session: a registry entry plus a socket that records lines. */
async function claude(account: string, pid: number, sessionId: string, name: string) {
  const socket = join(socks, `${pid}.sock`);
  write(join(home, account, "sessions", `${pid}.json`), {
    pid,
    sessionId,
    cwd: `/home/clupai/${name}`,
    startedAt: 1,
    procStart: "123",
    version: "2.1.312",
    peerProtocol: 1,
    peerFeatures: ["notify_idle"],
    kind: "interactive",
    entrypoint: "sdk-cli",
    pidDomain: "linux",
    messagingSocketPath: socket,
    name,
    nameSource: "derived",
    status: "idle",
    updatedAt: 1,
    statusUpdatedAt: 1,
  });
  return listen(socket);
}

/** Writes one line to a socket the way Claude's senders do. */
function sendTo(socket: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket, () => {
      connection.end(`${line}\n`, () => resolve());
    });
    connection.on("error", reject);
  });
}

async function until<T>(check: () => T | undefined | false, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function userFrame(from: string, body: string, id = "m-1") {
  return JSON.stringify({
    msgV: 1,
    msg_id: id,
    type: "user",
    message: {
      role: "user",
      content: `<cross-session-message from="uds:${from}" from-session="x" hop-chain="" from-name="n" from-mode="default">\n${body}\n</cross-session-message>`,
    },
    priority: "next",
    from: `uds:${from}`,
    session_id: "someone",
    file_attachments: [{ path: "/etc/hosts" }],
  });
}

const sync = (device: { id: string; name: string }, machine: string, sessions: unknown[]) =>
  relay.handle("relay.sync", { machine, sockDir: PEER_SOCKS, sessions }, device) as Promise<RelaySyncResult>;
const send = (device: { id: string; name: string }, params: Record<string, unknown>) =>
  relay.handle("relay.send", params, device) as Promise<RelaySendResult>;
const next = (device: { id: string; name: string }, cursor: number, waitMs = 0) =>
  relay.handle("relay.next", { cursor, waitMs }, device) as Promise<RelayNextResult>;

function pidOf(entries: RelayRegistryEntry[], sessionId: string): number {
  const entry = entries.find((item) => item.sessionId === sessionId);
  if (!entry) throw new Error(`No entry for ${sessionId}`);
  return entry.pid;
}

function hostFiles(pid: number) {
  return [
    join(home, ".claude/sessions", `${pid}.json`),
    join(home, ".claude-exec/sessions", `${pid}.json`),
    join(socks, `${pid}.sock`),
  ];
}

beforeEach(() => {
  // Short: a Mac socket path must fit in 104 bytes.
  root = mkdtempSync("/tmp/mcr-");
  home = join(root, "h");
  socks = join(root, "s");
  mkdirSync(socks, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude-exec"), { recursive: true });
  clock = 1_800_000_000_000;
  fakes = [];
});

afterEach(async () => {
  await relay?.close();
  for (const fake of fakes) await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function makeRelay(alive: number[]) {
  relay = new HostRelay({
    dataDir: join(root, "d"),
    store: {} as HostStore,
    home,
    uid: 1000,
    env: {},
    now: () => clock,
    machine: "vivobook",
    isAlive: (pid) => alive.includes(pid),
    sweepMs: 0,
  });
  return relay;
}

describe("HostRelay", () => {
  it("relays between host sessions and peers, both ways, with receipts", async () => {
    const s1 = await claude(".claude", 101, S1, "vivo-main");
    const s2 = await claude(".claude-exec", 102, S2, "vivo-cx");
    // A dead session and a copy an earlier run left behind.
    write(join(home, ".claude/sessions/103.json"), { pid: 103, sessionId: "deaddead-0000", cwd: "/x", peerProtocol: 1, messagingSocketPath: join(socks, "103.sock") });
    const stale = join(home, ".claude/sessions/1500000000.json");
    write(stale, { pid: 1_500_000_000, sessionId: "old", pidDomain: "relay:mac", messagingSocketPath: join(socks, "1500000000.sock"), monocodeRelay: { machine: "mac", account: ".claude", remoteSessionId: "old", writer: "host" } });
    writeFileSync(join(socks, "1500000000.sock"), "");
    // A desktop's own copy on this machine is not the host's to clean.
    const desktopCopy = join(home, ".claude/sessions/1600000000.json");
    write(desktopCopy, { pid: 1_600_000_000, sessionId: "theirs", pidDomain: "relay:vivobook", monocodeRelay: { machine: "vivobook", account: ".claude", remoteSessionId: "theirs" } });

    makeRelay([101, 102]);
    await relay.start();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(socks, "1500000000.sock"))).toBe(false);
    expect(existsSync(desktopCopy)).toBe(true);
    expect(existsSync(join(home, ".claude/sessions/101.json"))).toBe(true);

    // Off by default.
    expect(await sync(MAC, "mac", [])).toEqual({ enabled: false, entries: [], nextSyncMs: 20_000 });
    expect(await next(MAC, 0, 20_000)).toEqual({ cursor: 0, deliveries: [], enabled: false });
    expect(await send(MAC, { from: T1, to: 1, line: "{}" })).toEqual({ accepted: false, reason: "The relay is off" });

    await relay.setEnabled(true);
    expect(JSON.parse(readFileSync(join(root, "d/relay.json"), "utf8"))).toEqual({ enabled: true, updatedAt: clock });

    const macSync = await sync(MAC, "Sams-Mac", [
      { sessionId: T1, account: ".claude", name: "@mac-work*", cwd: "/Users/sam/proj", status: "busy", version: "2.1.312", bridgeSessionId: "session_01X" },
    ]);
    expect(macSync.enabled).toBe(true);
    expect(macSync.nextSyncMs).toBe(3_000);
    expect(macSync.entries.map((entry) => entry.sessionId).sort()).toEqual([S1, S2]);
    const pS1 = pidOf(macSync.entries, S1);
    const pS2 = pidOf(macSync.entries, S2);
    const e1 = macSync.entries.find((entry) => entry.sessionId === S1)!;
    expect(e1).toMatchObject({
      pid: pS1,
      cwd: "/home/clupai/vivo-main",
      version: "2.1.312",
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      entrypoint: "relay",
      pidDomain: "relay:vivobook",
      messagingSocketPath: `${PEER_SOCKS}/${pS1}.sock`,
      name: "vivo-main",
      nameSource: "derived",
      monocodeRelay: { machine: "vivobook", account: ".claude", remoteSessionId: S1 },
    });
    expect(e1.monocodeRelay).not.toHaveProperty("writer");
    expect(macSync.entries.find((entry) => entry.sessionId === S2)!.monocodeRelay.account).toBe(".claude-exec");
    expect(pS1).toBeGreaterThanOrEqual(1e9);
    expect(pS1).toBeLessThan(2e9);

    // The host's proxy for the Mac session: json in both accounts, a socket.
    const proxyFiles = await until(() => {
      const names = readdirJson(join(home, ".claude/sessions")).filter((name) => Number(name.split(".")[0]) >= 1e9 && name !== "1600000000.json");
      return names.length === 1 ? names : undefined;
    });
    const pT1 = Number(proxyFiles[0].split(".")[0]);
    for (const path of hostFiles(pT1)) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const written = JSON.parse(readFileSync(hostFiles(pT1)[1], "utf8"));
    expect(written).toMatchObject({
      pid: pT1,
      sessionId: T1,
      name: "mac-work",
      pidDomain: "relay:Sams-Mac",
      messagingSocketPath: join(socks, `${pT1}.sock`),
      version: "2.1.312",
      status: "busy",
      bridgeSessionId: "session_01X",
      monocodeRelay: { machine: "Sams-Mac", account: ".claude", remoteSessionId: T1, writer: "host" },
    });
    // Readers of the registries never see relay copies as sessions.
    expect((await discoverSessions(home, (pid) => pid !== 103)).map((session) => session.sessionId).sort()).toEqual([S1, S2]);
    // A mirror copy of S1 in the other account does not change its account.
    const copy = join(home, ".claude-exec/sessions/101.json");
    write(copy, { ...JSON.parse(readFileSync(join(home, ".claude/sessions/101.json"), "utf8")), updatedAt: 99 });
    write(join(home, ".local/state/session-mirror.json"), { [copy]: join(home, ".claude/sessions/101.json") });
    expect((await discoverSessions(home, () => true)).find((session) => session.sessionId === S1)?.account).toBe(".claude");

    // Host to peer: S1 writes to the proxy; the Mac's long poll wakes.
    const waiting = next(MAC, 0, 20_000);
    await sendTo(join(socks, `${pT1}.sock`), JSON.stringify({ type: "auth", token: "secret" }) + "\n" + userFrame(s1.socket, "hello mac"));
    const got = await waiting;
    expect(got.enabled).toBe(true);
    expect(got.deliveries).toHaveLength(1);
    expect(got.deliveries[0]).toMatchObject({ to: T1, fromPid: pS1 });
    const toMac = JSON.parse(got.deliveries[0].line);
    expect(toMac.from).toBe(`uds:${PEER_SOCKS}/${pS1}.sock`);
    expect(toMac.message.content).toContain(`from="uds:${PEER_SOCKS}/${pS1}.sock"`);
    expect(toMac.message.content).toContain("hello mac");
    expect(toMac.msg_id).toBe("m-1");
    expect(toMac).not.toHaveProperty("session_id");
    expect(toMac).not.toHaveProperty("file_attachments");
    expect(got.deliveries[0].line).not.toContain("secret");

    // A line from something that is not a live session here goes nowhere.
    await sendTo(join(socks, `${pT1}.sock`), userFrame("/tmp/elsewhere/9.sock", "spoof"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await next(MAC, got.cursor)).deliveries).toEqual([]);

    // Peer to host: the Mac session writes to its proxy for S2.
    expect(await send(MAC, { from: T1, to: pS2, line: userFrame("/tmp/cc-socks/555.sock", "hello cx", "m-2") })).toEqual({ accepted: true });
    const inS2 = await until(() => s2.lines[0]);
    const atS2 = JSON.parse(inS2);
    expect(atS2.from).toBe(`uds:${join(socks, `${pT1}.sock`)}`);
    expect(atS2.message.content).toContain(`from="uds:${join(socks, `${pT1}.sock`)}"`);
    expect(atS2.msg_id).toBe("m-2");
    expect(atS2).not.toHaveProperty("session_id");

    // S2's receipt goes to the proxy it came from and back to the Mac.
    await sendTo(
      join(socks, `${pT1}.sock`),
      JSON.stringify({ type: "control", action: "peer_message_status", status: "delivered", from: `uds:${s2.socket}`, orig_msg_id: "m-2" }),
    );
    const receipt = await next(MAC, got.cursor, 5_000);
    expect(receipt.deliveries).toHaveLength(1);
    expect(receipt.deliveries[0]).toMatchObject({ to: T1, fromPid: pS2 });
    expect(JSON.parse(receipt.deliveries[0].line)).toMatchObject({
      type: "control",
      orig_msg_id: "m-2",
      from: `uds:${PEER_SOCKS}/${pS2}.sock`,
    });

    // Refusals.
    expect(await send(MAC, { from: "unknown-session", to: pS2, line: userFrame("/x/1.sock", "x") })).toEqual({ accepted: false, reason: "Unknown sender" });
    expect(await send(MAC, { from: T1, to: 1_234, line: userFrame("/x/1.sock", "x") })).toEqual({ accepted: false, reason: "Unknown target" });
    expect(await send(MAC, { from: T1, to: pS2, line: JSON.stringify({ type: "auth", token: "t" }) })).toEqual({ accepted: false, reason: "Not a message" });
    expect(await send(AIR, { from: T1, to: pS2, line: userFrame("/x/1.sock", "x") })).toEqual({ accepted: false, reason: "Sync first" });
    await expect(relay.handle("relay.sync", { sockDir: "/tmp/../etc", sessions: [] }, MAC)).rejects.toThrow("socket folder");
    await expect(relay.handle("relay.next", { cursor: 0 }, null)).rejects.toThrow("not paired");

    // Peer to peer: the Air's session gets the Mac's, and the other way.
    const airSync = await sync(AIR, "air", [{ sessionId: U1, account: ".claude-exec", name: "air-work", cwd: "/Users/sam/air" }]);
    expect(airSync.entries.map((entry) => entry.sessionId).sort()).toEqual([S1, S2, T1].sort());
    expect(airSync.entries.find((entry) => entry.sessionId === T1)!.pidDomain).toBe("relay:Sams-Mac");
    const macAgain = await sync(MAC, "Sams-Mac", [{ sessionId: T1, account: ".claude", name: "mac-work", cwd: "/Users/sam/proj" }]);
    expect(pidOf(macAgain.entries, S1)).toBe(pS1);
    const pU1 = pidOf(macAgain.entries, U1);
    const pT1onAir = pidOf(airSync.entries, T1);
    expect(await send(MAC, { from: T1, to: pU1, line: userFrame("/tmp/cc-socks/555.sock", "hi air", "m-3") })).toEqual({ accepted: true });
    const toAir = await next(AIR, 0);
    expect(toAir.deliveries).toHaveLength(1);
    expect(toAir.deliveries[0]).toMatchObject({ to: U1, fromPid: pT1onAir });
    expect(JSON.parse(toAir.deliveries[0].line).from).toBe(`uds:${PEER_SOCKS}/${pT1onAir}.sock`);

    // Status reaches the phone: counts only, no pids or socket paths.
    const status = relay.status();
    expect(status).toMatchObject({ enabled: true, sessions: 4 });
    expect(status.peers.map((peer) => [peer.id, peer.name, peer.sessions])).toEqual([
      ["dev-air", "Air", 1],
      ["dev-mac", "Sam's Mac", 1],
    ]);
    const text = JSON.stringify(status);
    expect(text).not.toContain(".sock");
    expect(text).not.toContain(String(pS1));
    expect(text).not.toContain(String(pT1));

    // The Mac goes silent: its proxies here go after 45 s.
    clock += PEER_TTL_MS / 2;
    await sync(AIR, "air", [{ sessionId: U1, account: ".claude-exec", name: "air-work", cwd: "/Users/sam/air" }]);
    clock += PEER_TTL_MS / 2 + 1;
    await relay.sweep();
    for (const path of hostFiles(pT1)) expect(existsSync(path)).toBe(false);
    expect(relay.status().peers.map((peer) => peer.id)).toEqual(["dev-air"]);

    // Off: every proxy goes and the methods refuse.
    const airProxy = readdirJson(join(home, ".claude/sessions")).filter((name) => Number(name.split(".")[0]) >= 1e9 && name !== "1600000000.json");
    expect(airProxy).toHaveLength(1);
    const offWait = next(AIR, 0, 20_000);
    await relay.setEnabled(false);
    expect((await offWait).enabled).toBe(false);
    for (const path of hostFiles(Number(airProxy[0].split(".")[0]))) expect(existsSync(path)).toBe(false);
    expect(existsSync(desktopCopy)).toBe(true);
    expect(await sync(AIR, "air", [])).toEqual({ enabled: false, entries: [], nextSyncMs: 20_000 });
    expect(relay.status()).toEqual({ enabled: false, updatedAt: clock, peers: [], sessions: 0 });
    expect(JSON.parse(readFileSync(join(root, "d/relay.json"), "utf8")).enabled).toBe(false);
  });

  it("drops a session that ends and starts on when it was left on", async () => {
    await claude(".claude", 101, S1, "vivo-main");
    write(join(root, "d/relay.json"), { enabled: true, updatedAt: 5 });
    const alive = [101];
    makeRelay(alive);
    await relay.start();
    expect(relay.status()).toMatchObject({ enabled: true, updatedAt: 5, sessions: 1 });
    const first = await sync(MAC, "mac", []);
    expect(first.entries.map((entry) => entry.sessionId)).toEqual([S1]);
    alive.length = 0;
    await relay.sweep();
    expect((await sync(MAC, "mac", [])).entries).toEqual([]);
  });

  it("closes without forgetting the switch, and cleans up again on start", async () => {
    await claude(".claude", 101, S1, "vivo-main");
    makeRelay([101]);
    await relay.setEnabled(true);
    await sync(MAC, "mac", [{ sessionId: T1, account: ".claude", name: "w", cwd: "/p" }]);
    const proxies = () => readdirJson(join(home, ".claude/sessions")).filter((name) => Number(name.split(".")[0]) >= 1e9);
    expect(proxies()).toHaveLength(1);
    await relay.close();
    expect(proxies()).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root, "d/relay.json"), "utf8")).enabled).toBe(true);
  });
});

describe("resolveSockDir", () => {
  const session = (socket: string) => ({ socket }) as LocalSession;

  it("prefers live sessions' folder, then XDG_RUNTIME_DIR, /run/user/<uid>, /tmp", async () => {
    expect(await resolveSockDir([session("/run/user/1000/cc-socks/1.sock"), session("/a/2.sock"), session("/a/3.sock")], { env: {}, uid: 1 })).toBe("/a");
    expect(await resolveSockDir([], { env: { XDG_RUNTIME_DIR: "/run/user/7" }, uid: 1 })).toBe("/run/user/7/cc-socks");
    const runRoot = mkdtempSync("/tmp/mcr-");
    try {
      mkdirSync(join(runRoot, "1000"));
      expect(await resolveSockDir([], { env: {}, uid: 1000, runUserRoot: runRoot })).toBe(join(runRoot, "1000/cc-socks"));
      expect(await resolveSockDir([], { env: {}, uid: 1001, runUserRoot: runRoot })).toBe("/tmp/cc-socks");
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });
});

function readdirJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}
