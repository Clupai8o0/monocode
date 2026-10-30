import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostLabHealth,
  TranscriptTail,
  cpuPercent,
  parseCpuTimes,
  parseGateStatus,
  parseMeminfo,
  parsePressure,
} from "./lab-health";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GATE = `agent-gate: 10 of 10 running, 1 waiting
memory:     9.9 GB available of 23.2 GB (keep 3 GB spare); pressure some 0.00  full 0.00
agents.slice: using 2.8 GB (+ 1.2 GB file cache), slowed above 7G, hard cap 7.5G, swap 0.8 GB of 4G

  slot name                 gate-pid age        mem-GB  procs
  0    clupai               1534651  47h54m        0.1  2
  4    monocode-agents-board 2142757  1h37m         0.2  2
  7    t3-phases            2189422  1h26m         0.8  17
  -    orphan-scope         gone     -             1.5  3 (gate killed; counted; stop: systemctl --user stop x)

  pos  name                 gate-pid waiting    est-GB  held-by
  1    monocode-ask-chat    2620540  4m35s         1.2  count

limits: MAX=10 MEM_GB=1.2 RESERVE_GB=3 AGENT_MAX=5G+1G swap HEAVY_MAX=2  (/home/x/.config/agent-gate.conf)
`;

describe("parsing", () => {
  it("reads pressure files", () => {
    expect(
      parsePressure(
        "some avg10=1.50 avg60=2.25 avg300=0.03 total=108\nfull avg10=0.10 avg60=0.20 avg300=0.01 total=80\n",
      ),
    ).toEqual({ someAvg10: 1.5, someAvg60: 2.25, fullAvg10: 0.1, fullAvg60: 0.2 });
    expect(parsePressure("some avg10=3.00 avg60=4.00 avg300=0 total=1\n")).toEqual({
      someAvg10: 3,
      someAvg60: 4,
      fullAvg10: 0,
      fullAvg60: 0,
    });
    expect(parsePressure("")).toBeNull();
  });

  it("reads meminfo", () => {
    expect(
      parseMeminfo(
        "MemTotal:       24000000 kB\nMemFree: 1 kB\nMemAvailable:    9789128 kB\nSwapTotal:       8388604 kB\nSwapFree:        5535772 kB\n",
      ),
    ).toEqual({ totalMb: 23438, availableMb: 9560, swapTotalMb: 8192, swapUsedMb: 2786 });
  });

  it("works out CPU use between two samples", () => {
    const before = parseCpuTimes("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1\n")!;
    const after = parseCpuTimes("cpu  200 0 200 1000 100 0 0 0 0 0\n")!;
    expect(cpuPercent(before, after)).toBe(40);
    expect(cpuPercent(before, before)).toBeNull();
    expect(parseCpuTimes("nothing")).toBeNull();
  });

  it("reads agent-gate status, long names and killed scopes too", () => {
    const gate = parseGateStatus(GATE, 5);
    expect(gate).toMatchObject({ running: 10, max: 10, waiting: 1, sampledAt: 5 });
    expect(gate?.agents).toEqual([
      { name: "clupai", memoryGb: 0.1 },
      { name: "monocode-agents-board", memoryGb: 0.2 },
      { name: "t3-phases", memoryGb: 0.8 },
      { name: "orphan-scope", memoryGb: 1.5 },
    ]);
    expect(parseGateStatus("agent-gate: 0 of 10 running, 0 waiting\n\nlimits: x\n", 1)?.agents).toEqual([]);
    expect(parseGateStatus("command not found", 1)).toBeNull();
  });
});

function user(at: number, extra = {}): string {
  return JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "x" }, ...extra });
}

function assistant(at: number, id: string, output: number, tool = false, extra = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      usage: { output_tokens: output },
      content: tool ? [{ type: "tool_use", id: "t" }] : [{ type: "text", text: "hi" }],
    },
    ...extra,
  });
}

const T0 = 1_800_000_000_000;

describe("transcript usage", () => {
  it("counts one reply's several lines once", () => {
    const tail = new TranscriptTail();
    tail.line(user(T0));
    tail.line(assistant(T0 + 5000, "m1", 100));
    tail.line(assistant(T0 + 10_000, "m1", 300, true));
    expect(tail.rate(T0 + 11_000)).toEqual({ tokensPerSecond: 30, modelSeconds: 10 });
    expect(tail.waitingOn()).toBe("tool");
  });

  it("doesn't charge tool time to the model", () => {
    const tail = new TranscriptTail();
    tail.line(user(T0));
    tail.line(assistant(T0 + 2000, "m1", 200, true));
    tail.line(user(T0 + 42_000, { message: { content: [{ type: "tool_result" }] } }));
    expect(tail.waitingOn()).toBe("model");
    tail.line(assistant(T0 + 44_000, "m2", 200));
    expect(tail.rate(T0 + 45_000)).toEqual({ tokensPerSecond: 100, modelSeconds: 4 });
  });

  it("forgets what fell out of the minute", () => {
    const tail = new TranscriptTail();
    tail.line(user(T0));
    tail.line(assistant(T0 + 2000, "m1", 200));
    expect(tail.rate(T0 + 120_000)).toEqual({ tokensPerSecond: null, modelSeconds: 0 });
  });

  it("only counts the part of a wait inside the minute", () => {
    const tail = new TranscriptTail();
    tail.line(user(T0));
    tail.line(assistant(T0 + 100_000, "m1", 600));
    expect(tail.rate(T0 + 110_000)).toEqual({ tokensPerSecond: 6, modelSeconds: 50 });
  });

  it("spreads a long reply's total over its time, even with tools between its lines", () => {
    const tail = new TranscriptTail();
    tail.line(user(T0));
    tail.line(assistant(T0 + 9000, "m1", 29_000));
    tail.line(assistant(T0 + 200_000, "m1", 29_000, true));
    tail.line(user(T0 + 200_500));
    tail.line(assistant(T0 + 201_000, "m1", 29_000, true));
    const { tokensPerSecond } = tail.rate(T0 + 202_000);
    expect(tokensPerSecond).toBeGreaterThan(140);
    expect(tokensPerSecond).toBeLessThan(150);
  });

  it("skips noise, sidechains and broken lines", () => {
    const tail = new TranscriptTail();
    tail.line('{"type":"attachment","x":"assistant"}');
    tail.line('{"type":"assistant"');
    tail.line(assistant(T0, "side", 500, false, { isSidechain: true }));
    expect(tail.lastAt).toBeNull();
    expect(tail.waitingOn()).toBeNull();
  });
});

function tree() {
  const dir = mkdtempSync(join(tmpdir(), "lab-health-"));
  dirs.push(dir);
  const root = join(dir, "root");
  const home = join(dir, "home");
  const file = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  file(join(root, "proc/stat"), "cpu  100 0 100 800 0 0 0 0 0 0\n");
  file(join(root, "proc/loadavg"), "3.50 2.00 1.00 1/100 5\n");
  file(join(root, "proc/meminfo"), "MemTotal: 1024000 kB\nMemAvailable: 512000 kB\nSwapTotal: 102400 kB\nSwapFree: 51200 kB\n");
  file(join(root, "proc/pressure/memory"), "some avg10=1.00 avg60=2.00 avg300=0 total=1\nfull avg10=0.00 avg60=0.50 avg300=0 total=1\n");
  file(join(root, "sys/class/thermal/thermal_zone0/type"), "acpitz\n");
  file(join(root, "sys/class/thermal/thermal_zone0/temp"), "40000\n");
  file(join(root, "sys/class/thermal/thermal_zone1/type"), "SEN1\n");
  file(join(root, "sys/class/thermal/thermal_zone1/temp"), "50\n");
  file(join(root, "sys/class/thermal/thermal_zone2/type"), "x86_pkg_temp\n");
  file(join(root, "sys/class/thermal/thermal_zone2/temp"), "71000\n");
  file(join(root, "sys/class/power_supply/AC0/type"), "Mains\n");
  file(join(root, "sys/class/power_supply/AC0/online"), "1\n");
  file(join(root, "sys/class/power_supply/BAT0/type"), "Battery\n");
  file(join(root, "sys/class/power_supply/BAT0/capacity"), "79\n");
  return { root, home, file };
}

describe("a read", () => {
  it("gathers the machine and its sessions", async () => {
    const { root, home, file } = tree();
    let now = T0;
    const registry = (pid: number, sessionId: string, cwd: string, status: string, extra = {}) =>
      JSON.stringify({ pid, sessionId, cwd, status, name: `s-${pid}`, statusUpdatedAt: T0 - 30_000, ...extra });
    file(join(home, ".claude/sessions/1.json"), registry(1, "busy-one", "/w/a", "busy"));
    file(join(home, ".claude-exec/sessions/2.json"), registry(2, "idle-one", "/w/b", "idle"));
    file(join(home, ".claude/sessions/3.json"), registry(3, "dead-one", "/w/c", "busy"));
    file(join(home, ".claude/sessions/4.json"), registry(4, "copy", "/w/d", "busy", { monocodeRelay: { machine: "m" } }));
    file(join(home, ".claude/sessions/note.key"), "secret");
    const transcript = join(home, ".claude/projects/-w-a/busy-one.jsonl");
    file(transcript, `${user(T0 - 20_000)}\n${assistant(T0 - 10_000, "m1", 200)}\n`);
    const health = new HostLabHealth({
      root,
      home,
      now: () => now,
      machine: "vivobook",
      cores: 20,
      sampleTimer: false,
      isAlive: (pid) => pid !== 3,
      gateStatus: async () => GATE,
    });
    const first = await health.read();
    expect(first.machine).toBe("vivobook");
    expect(first.cpu).toEqual({ percent: null, load1: 3.5, load5: 2, cores: 20 });
    expect(first.memory).toEqual({ totalMb: 1000, availableMb: 500 });
    expect(first.pressure.memory?.fullAvg60).toBe(0.5);
    expect(first.pressure.cpu).toBeNull();
    expect(first.swap).toMatchObject({ totalMb: 100, usedMb: 50, climbMbPerMin: 0 });
    expect(first.temperatureC).toBe(71);
    expect(first.power).toEqual({ source: "ac", batteryPercent: 79 });
    expect(first.sessions.map((s) => s.sessionId).sort()).toEqual(["busy-one", "idle-one"]);
    const busy = first.sessions.find((s) => s.sessionId === "busy-one")!;
    expect(busy).toMatchObject({
      name: "s-1",
      busy: true,
      quietMs: 10_000,
      tokensPerSecond: 20,
      modelSeconds: 10,
      turnMs: 30_000,
      waitingOn: "model",
    });
    const idle = first.sessions.find((s) => s.sessionId === "idle-one")!;
    expect(idle).toMatchObject({ busy: false, quietMs: null, turnMs: null, waitingOn: null });

    // The transcript's new end, with half a line left over for next time.
    now += 20_000;
    file(join(root, "proc/stat"), "cpu  200 0 200 1000 100 0 0 0 0 0\n");
    const line = assistant(now - 1000, "m2", 400, true);
    appendFileSync(transcript, `${user(now - 3000)}\n${line.slice(0, 20)}`);
    const second = await health.read();
    expect(second.cpu.percent).toBe(40);
    expect(second.gate?.running).toBe(10);
    expect(second.history.length).toBe(2);
    expect(second.sessions.find((s) => s.sessionId === "busy-one")?.waitingOn).toBe("model");
    appendFileSync(transcript, `${line.slice(20)}\n`);
    now += 1000;
    const third = await health.read();
    const after = third.sessions.find((s) => s.sessionId === "busy-one")!;
    expect(after.waitingOn).toBe("tool");
    expect(after.quietMs).toBe(2000);
    health.stop();
  });

  it("notices swap climbing", async () => {
    const { root, home, file } = tree();
    let now = T0;
    const health = new HostLabHealth({ root, home, now: () => now, cores: 4, sampleTimer: false, gateStatus: async () => null });
    await health.read();
    now += 120_000;
    file(join(root, "proc/meminfo"), "MemTotal: 1024000 kB\nMemAvailable: 512000 kB\nSwapTotal: 102400 kB\nSwapFree: 10240 kB\n");
    const read = await health.read();
    expect(read.swap.climbMbPerMin).toBe(20);
  });

  it("answers without waiting for a slow agent-gate, and keeps its last answer", async () => {
    const { root, home } = tree();
    let now = T0;
    let finish: (text: string | null) => void = () => {};
    const health = new HostLabHealth({
      root,
      home,
      now: () => now,
      cores: 4,
      sampleTimer: false,
      gateStatus: () => new Promise((resolve) => (finish = resolve)),
    });
    expect((await health.read()).gate).toBeNull();
    finish(GATE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await health.read()).gate?.waiting).toBe(1);
    now += 60_000;
    await health.read();
    finish(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await health.read()).gate?.waiting).toBe(1);
  });

  it("copes with a machine that has none of this", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-health-"));
    dirs.push(dir);
    const health = new HostLabHealth({ root: dir, home: dir, cores: 4, sampleTimer: false, gateStatus: async () => null });
    const read = await health.read();
    expect(read.temperatureC).toBeNull();
    expect(read.power).toEqual({ source: null, batteryPercent: null });
    expect(read.sessions).toEqual([]);
    expect(read.gate).toBeNull();
  });
});
