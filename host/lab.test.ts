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
import { HostLab, type LabCaller, type LabRelay } from "./lab";
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
  });
  return { lab, relay, dataDir, calls, tick: (ms: number) => (clock += ms) };
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
});
