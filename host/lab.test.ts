import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayStatus } from "../src/fork/lab/labProtocol";
import { fakeRunner } from "./lab-fake";
import {
  HostLab,
  agentTimeZone,
  validZoneName,
  type LabCaller,
  type LabRelay,
} from "./lab";
import type { HostStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const phone: LabCaller = {
  device: { id: "d1", name: "Pixel" },
  surface: "mobile",
};
const mac: LabCaller = {
  device: { id: "d2", name: "Sam's Mac" },
  surface: "rpc",
};

function fakeRelay(): LabRelay & { sets: boolean[] } {
  let state: RelayStatus = {
    enabled: false,
    updatedAt: 0,
    peers: [],
    sessions: 0,
  };
  const sets: boolean[] = [];
  return {
    sets,
    status: () => state,
    async setEnabled(enabled) {
      sets.push(enabled);
      state = { ...state, enabled, updatedAt: 9 };
      return state;
    },
  };
}

function setup(platform: NodeJS.Platform = "darwin", table = {}) {
  const root = mkdtempSync(join(tmpdir(), "monocode-lab-test-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir);
  const zoneInfo = join(root, "zoneinfo");
  mkdirSync(join(zoneInfo, "Asia"), { recursive: true });
  mkdirSync(join(zoneInfo, "Australia", "Sydney"), { recursive: true });
  writeFileSync(join(zoneInfo, "Asia", "Kolkata"), "TZif");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude-exec"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ remoteControlAtStartup: true }),
  );
  let clock = 1000;
  const relay = fakeRelay();
  const { run, calls } = fakeRunner(table);
  const lab = new HostLab({
    dataDir,
    store: {} as HostStore,
    run,
    platform,
    machine: "clupai",
    home,
    now: () => clock,
    relay,
    zoneInfo,
    hostZone: () => "Australia/Melbourne",
  });
  return { lab, relay, dataDir, zoneInfo, calls, tick: (ms: number) => (clock += ms) };
}

describe("host lab", () => {
  it("answers the whole status, with the host itself as a machine", async () => {
    const { lab } = setup("darwin");
    expect(await lab.handle("lab.status", {}, phone)).toEqual({
      version: 1,
      machine: "clupai",
      platform: "darwin",
      remoteControl: {
        desired: { scope: "all", updatedAt: 0, by: "default" },
        machines: [
          {
            machine: "clupai",
            lab: false,
            scope: "all",
            accounts: [
              { account: ".claude", enabled: true },
              { account: ".claude-exec", enabled: false },
            ],
            reportedAt: 1000,
          },
        ],
      },
      relay: { enabled: false, updatedAt: 0, peers: [], sessions: 0 },
      uresourced: null,
      remoteDesktop: null,
      timeZone: { zone: null, updatedAt: 0, hostZone: "Australia/Melbourne", installed: true },
    });
  });

  it("keeps the newest Remote Control choice, by the caller's name", async () => {
    const { lab, dataDir } = setup();
    let status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "lab", updatedAt: 50 },
      phone,
    );
    expect(status.remoteControl.desired).toEqual({
      scope: "lab",
      updatedAt: 50,
      by: "Pixel",
    });
    status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "all", updatedAt: 40 },
      mac,
    );
    expect(status.remoteControl.desired.scope).toBe("lab");
    status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "all" },
      { device: null, surface: "rpc" },
    );
    expect(status.remoteControl.desired).toEqual({
      scope: "all",
      updatedAt: 1000,
      by: "unknown",
    });
    expect(
      JSON.parse(readFileSync(join(dataDir, "lab.json"), "utf8")).desired.scope,
    ).toBe("all");
    expect(readdirSync(dataDir)).toEqual(["lab.json"]);
    await expect(
      lab.handle("lab.remoteControl.set", { scope: "some" }, phone),
    ).rejects.toThrow("Choose all or lab");
  });

  it("serializes writes so none is lost", async () => {
    const { lab } = setup();
    await Promise.all(
      ["a", "b", "c", "d"].map((machine) =>
        lab.handle(
          "lab.report",
          {
            machine,
            platform: "darwin",
            remoteControl: {
              scope: "all",
              updatedAt: 1,
              by: "x",
              accounts: [],
            },
          },
          mac,
        ),
      ),
    );
    const status = await lab.handle("lab.status", {}, mac);
    expect(status.remoteControl.machines.map((m) => m.machine)).toEqual([
      "a",
      "b",
      "c",
      "clupai",
      "d",
    ]);
  });

  it("stores reports per machine, desktops only", async () => {
    const { lab, tick } = setup("linux", {});
    tick(5);
    const status = await lab.handle(
      "lab.report",
      {
        machine: "Sams-MacBook",
        platform: "darwin",
        remoteControl: {
          scope: "lab",
          updatedAt: 7,
          by: "Sam",
          accounts: [{ account: ".claude", enabled: false }, { bad: 1 }],
        },
      },
      mac,
    );
    expect(status.remoteControl.machines).toContainEqual({
      machine: "Sams-MacBook",
      lab: false,
      scope: "lab",
      accounts: [{ account: ".claude", enabled: false }],
      reportedAt: 1005,
    });
    expect(
      status.remoteControl.machines.find((m) => m.machine === "clupai")?.lab,
    ).toBe(true);
    await expect(lab.handle("lab.report", {}, phone)).rejects.toThrow(
      "Only desktops report",
    );
  });

  it("never overwrites a damaged lab.json", async () => {
    const { lab, dataDir } = setup();
    writeFileSync(join(dataDir, "lab.json"), "{not json");
    expect(
      (await lab.handle("lab.status", {}, phone)).remoteControl.desired.by,
    ).toBe("default");
    await expect(
      lab.handle(
        "lab.remoteControl.set",
        { scope: "lab", updatedAt: 5 },
        phone,
      ),
    ).rejects.toThrow("The saved lab settings are damaged");
    expect(readFileSync(join(dataDir, "lab.json"), "utf8")).toBe("{not json");
  });

  it("refuses to save over a lab.json it could not read", async () => {
    const { lab, dataDir } = setup();
    // A directory in its place fails the read with EISDIR, not ENOENT.
    mkdirSync(join(dataDir, "lab.json"));
    expect(
      (await lab.handle("lab.status", {}, phone)).remoteControl.desired.by,
    ).toBe("default");
    await expect(
      lab.handle(
        "lab.remoteControl.set",
        { scope: "lab", updatedAt: 5 },
        phone,
      ),
    ).rejects.toThrow("Could not read the saved lab settings");
  });

  it("drops damaged machine entries instead of failing", async () => {
    const { lab, dataDir } = setup();
    const good = {
      machine: "vivobook",
      lab: true,
      scope: "lab",
      accounts: [],
      reportedAt: 3,
    };
    writeFileSync(
      join(dataDir, "lab.json"),
      JSON.stringify({
        desired: { scope: "all", updatedAt: 0, by: "default" },
        machines: {
          vivobook: {
            ...good,
            accounts: [null, 3, { account: ".claude", enabled: true }],
          },
          a: null,
          b: 7,
          c: { ...good, machine: 1 },
          d: { ...good, scope: "some" },
          e: { ...good, accounts: "x" },
          f: { ...good, reportedAt: "now" },
          g: { ...good, lab: "yes" },
        },
      }),
    );
    const status = await lab.handle("lab.status", {}, phone);
    expect(status.remoteControl.machines.map((m) => m.machine)).toEqual([
      "clupai",
      "vivobook",
    ]);
    expect(status.remoteControl.machines[1]?.accounts).toEqual([
      { account: ".claude", enabled: true },
    ]);
  });

  it("never lets a clock running ahead lock the choice", async () => {
    const { lab, dataDir, tick } = setup();
    const day = 24 * 60 * 60 * 1000;
    // A click stamped an hour ahead is kept as now.
    let status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "lab", updatedAt: 1000 + 3_600_000 },
      phone,
    );
    expect(status.remoteControl.desired.updatedAt).toBe(1000);
    tick(1);
    status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "all", updatedAt: 1001 },
      mac,
    );
    expect(status.remoteControl.desired).toMatchObject({
      scope: "all",
      updatedAt: 1001,
    });
    // One already saved far ahead counts as 0.
    writeFileSync(
      join(dataDir, "lab.json"),
      JSON.stringify({
        desired: { scope: "lab", updatedAt: 1001 + day + 1, by: "x" },
        machines: {},
      }),
    );
    status = await lab.handle("lab.status", {}, phone);
    expect(status.remoteControl.desired).toEqual({
      scope: "lab",
      updatedAt: 0,
      by: "x",
    });
    status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "all", updatedAt: 500 },
      mac,
    );
    expect(status.remoteControl.desired.scope).toBe("all");
    // Within a day ahead, newest still wins.
    writeFileSync(
      join(dataDir, "lab.json"),
      JSON.stringify({
        desired: { scope: "lab", updatedAt: 1001 + day, by: "x" },
        machines: {},
      }),
    );
    status = await lab.handle(
      "lab.remoteControl.set",
      { scope: "all", updatedAt: 900 },
      mac,
    );
    expect(status.remoteControl.desired.scope).toBe("lab");
  });

  it("switches the relay", async () => {
    const { lab, relay } = setup();
    const status = await lab.handle("lab.relay.set", { enabled: true }, phone);
    expect(relay.sets).toEqual([true]);
    expect(status.relay.enabled).toBe(true);
    await expect(lab.handle("lab.relay.set", {}, phone)).rejects.toThrow(
      "Say on or off",
    );
  });

  it("keeps uresourced and remote desktop to Linux", async () => {
    const { lab, calls } = setup("darwin");
    await expect(
      lab.handle("lab.uresourced.set", { action: "off" }, phone),
    ).rejects.toThrow("Only on Linux");
    await expect(
      lab.handle("lab.remoteDesktop.set", { enabled: true }, phone),
    ).rejects.toThrow("Only on Linux");
    await lab.handle("lab.status", { probe: true }, phone);
    expect(calls).toEqual([]);
  });

  it("probes uresourced on Linux when asked", async () => {
    const { lab, calls } = setup("linux", {
      "systemctl --user show uresourced.service": {
        stdout:
          "LoadState=loaded\nActiveState=active\nMainPID=10\nActiveEnterTimestamp=@100\n",
      },
      "timeout 2 busctl": { code: 124, stdout: "" },
    });
    const status = await lab.handle("lab.status", { probe: true }, phone);
    expect(calls.some((call) => call.startsWith("timeout 2 busctl"))).toBe(
      true,
    );
    expect(status.uresourced).toMatchObject({
      active: true,
      pid: 10,
      since: 100000,
      loop: { callsPerSecond: 0, fromUresourced: 0, sampledAt: 1000 },
      looping: false,
    });
  });

  it("stores the agent time zone, from a desktop or a phone", async () => {
    const { lab, dataDir, zoneInfo, tick } = setup();
    let status = await lab.handle("lab.timeZone.set", { zone: "Asia/Kolkata" }, mac);
    expect(status.timeZone).toEqual({
      zone: "Asia/Kolkata",
      updatedAt: 1000,
      hostZone: "Australia/Melbourne",
      installed: true,
    });
    expect(agentTimeZone(dataDir, zoneInfo)).toBe("Asia/Kolkata");
    tick(5);
    status = await lab.handle("lab.timeZone.set", { zone: null }, phone);
    expect(status.timeZone).toMatchObject({ zone: null, updatedAt: 1005 });
    expect(agentTimeZone(dataDir, zoneInfo)).toBeNull();
  });

  it("keeps the time zone when other settings are saved", async () => {
    const { lab, dataDir } = setup();
    await lab.handle("lab.timeZone.set", { zone: "Asia/Kolkata" }, mac);
    await lab.handle("lab.remoteControl.set", { scope: "lab" }, mac);
    const saved = JSON.parse(readFileSync(join(dataDir, "lab.json"), "utf8"));
    expect(saved.timeZone).toEqual({ zone: "Asia/Kolkata", updatedAt: 1000 });
  });

  it("refuses bad zone names and saves nothing", async () => {
    const { lab, dataDir } = setup();
    for (const zone of ["../etc/passwd", "Asia/", "Asia//Kolkata", "a.b", "", 7, "x".repeat(65)]) {
      await expect(lab.handle("lab.timeZone.set", { zone }, mac)).rejects.toThrow();
    }
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("keeps a zone this host lacks, says so, and spawns keep the host's zone", async () => {
    const { lab, dataDir, zoneInfo } = setup();
    let status = await lab.handle("lab.timeZone.set", { zone: "Foo/Bar" }, mac);
    expect(status.timeZone).toMatchObject({ zone: "Foo/Bar", installed: false });
    expect(agentTimeZone(dataDir, zoneInfo)).toBeNull();
    // A folder is not a zone file.
    status = await lab.handle("lab.timeZone.set", { zone: "Australia/Sydney" }, mac);
    expect(status.timeZone).toMatchObject({ zone: "Australia/Sydney", installed: false });
    expect(agentTimeZone(dataDir, zoneInfo)).toBeNull();
  });

  it("reads an older lab.json with no time zone", async () => {
    const { lab, dataDir } = setup();
    writeFileSync(
      join(dataDir, "lab.json"),
      JSON.stringify({
        desired: { scope: "lab", updatedAt: 5, by: "Mac" },
        machines: {},
      }),
    );
    expect((await lab.status()).timeZone).toEqual({
      zone: null,
      updatedAt: 0,
      hostZone: "Australia/Melbourne",
      installed: true,
    });
  });

  it("gives spawns no zone once it is uninstalled or the file is bad", () => {
    const { dataDir, zoneInfo } = setup();
    expect(agentTimeZone(dataDir, zoneInfo)).toBeNull();
    writeFileSync(join(dataDir, "lab.json"), "{bad");
    expect(agentTimeZone(dataDir, zoneInfo)).toBeNull();
    writeFileSync(
      join(dataDir, "lab.json"),
      JSON.stringify({ timeZone: { zone: "Europe/Gone", updatedAt: 1 } }),
    );
    expect(agentTimeZone(dataDir, zoneInfo)).toBeNull();
    expect(validZoneName("Etc/GMT+5")).toBe(true);
  });
});
