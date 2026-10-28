import { describe, expect, it } from "vitest";
import { fakeRunner } from "./lab-fake";
import {
  runCommand,
  systemdEnvironment,
  parseShow,
  parseUnixTimestamp,
} from "./lab-system";
import {
  parseMonitor,
  parsePidReply,
  UresourcedControl,
} from "./lab-uresourced";

// Trimmed from the vivobook, 28 Oct 2026.
const SHOW = `LoadState=loaded
ActiveState=active
ActiveEnterTimestamp=@1793205280
MainPID=1472655
`;
const CALL = (cookie: number, sender = ":1.58024") =>
  `{"type":"method_call","endian":"l","flags":0,"version":1,"cookie":${cookie},"timestamp-realtime":1793205401188982,"sender":"${sender}","destination":":1.46319","path":"/org/freedesktop/systemd1","interface":"org.freedesktop.systemd1.Manager","member":"SetUnitProperties","payload":{"type":"sba(sv)","data":["mindcraft.service",true,[["CPUWeight",{"type":"t","data":100}],["IOWeight",{"type":"t","data":100}]]]}}`;
const MONITOR_KEY = "timeout 2 busctl --user monitor";
const PID_KEY = "busctl --user call org.freedesktop.DBus";

function monitor(calls: number, other = 0) {
  const lines = [];
  for (let i = 0; i < calls; i += 1) lines.push(CALL(i));
  for (let i = 0; i < other; i += 1) lines.push(CALL(1000 + i, ":1.9"));
  // busctl is cut off mid-line when timeout ends it.
  return { code: 124, stdout: `${lines.join("\n")}\n{"type":"method_ca` };
}

describe("lab system helpers", () => {
  it("runs commands with a timeout and never throws", async () => {
    expect(
      await runCommand("sh", ["-c", "echo hi"], { timeoutMs: 5000 }),
    ).toMatchObject({
      code: 0,
      stdout: "hi\n",
      timedOut: false,
    });
    expect(await runCommand("sleep", ["5"], { timeoutMs: 100 })).toMatchObject({
      code: null,
      timedOut: true,
    });
    expect(
      (await runCommand("monocode-no-such-cmd", [], { timeoutMs: 1000 })).code,
    ).toBeNull();
  });

  it("adds the user bus only when missing", () => {
    expect(systemdEnvironment({ PATH: "/bin" }, 1000)).toMatchObject({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(
      systemdEnvironment(
        { XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "y" },
        1000,
      ),
    ).toMatchObject({ XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "y" });
  });

  it("parses systemctl show blocks and unix timestamps", () => {
    expect(
      parseShow("Id=a\nActiveState=active\n\nId=b\nActiveState=inactive\n"),
    ).toEqual([
      { Id: "a", ActiveState: "active" },
      { Id: "b", ActiveState: "inactive" },
    ]);
    expect(parseUnixTimestamp("@1793205280")).toBe(1793205280000);
    expect(parseUnixTimestamp("")).toBeNull();
  });

  it("parses busctl monitor and pid replies", () => {
    expect(parseMonitor(monitor(2).stdout)).toEqual([":1.58024", ":1.58024"]);
    expect(parsePidReply("u 1472655\n")).toBe(1472655);
    expect(parsePidReply("Call failed")).toBeNull();
  });
});

describe("uresourced", () => {
  it("reads its state and finds it looping", async () => {
    const { run, calls } = fakeRunner({
      "systemctl --user show uresourced.service": { stdout: SHOW },
      [MONITOR_KEY]: monitor(400, 4),
      [`${PID_KEY} /org/freedesktop/DBus org.freedesktop.DBus GetConnectionUnixProcessID s :1.58024`]:
        { stdout: "u 1472655\n" },
      [PID_KEY]: { stdout: "u 77\n" },
    });
    const control = new UresourcedControl({ run, now: () => 5 });
    expect(await control.status()).toEqual({
      installed: true,
      active: true,
      masked: false,
      pid: 1472655,
      since: 1793205280000,
      loop: null,
      looping: false,
    });
    await Promise.all([control.probe(), control.probe()]);
    expect(calls.filter((call) => call.startsWith(MONITOR_KEY))).toHaveLength(
      1,
    );
    expect(await control.status()).toMatchObject({
      loop: { callsPerSecond: 202, fromUresourced: 200, sampledAt: 5 },
      looping: true,
    });
  });

  it("turns off with stop then mask, and on with a reload only when masked", async () => {
    let load = "loaded";
    const { run, calls } = fakeRunner({
      "systemctl --user show uresourced.service": () => ({
        stdout: `LoadState=${load}\nActiveState=inactive\nMainPID=0\nActiveEnterTimestamp=\n`,
      }),
      "systemctl --user": { code: 0 },
      [MONITOR_KEY]: monitor(0),
    });
    const control = new UresourcedControl({ run, sleep: async () => {} });
    await control.set("off");
    expect(calls.filter((call) => !call.includes(" show "))).toEqual([
      "systemctl --user stop uresourced.service",
      "systemctl --user mask --no-reload uresourced.service",
    ]);
    calls.length = 0;
    load = "masked";
    await control.set("on");
    expect(
      calls.filter(
        (call) => call.startsWith("systemctl") && !call.includes(" show "),
      ),
    ).toEqual([
      "systemctl --user unmask --no-reload uresourced.service",
      "systemctl --user daemon-reload",
      "systemctl --user start uresourced.service",
    ]);
    calls.length = 0;
    load = "loaded";
    await control.set("on");
    expect(calls).not.toContain("systemctl --user daemon-reload");
    expect(calls.some((call) => call.includes("oomd"))).toBe(false);
  });

  it("restarts, waits, then looks again", async () => {
    const waits: number[] = [];
    const { run, calls } = fakeRunner({
      "systemctl --user show uresourced.service": { stdout: SHOW },
      "systemctl --user restart": {},
      [MONITOR_KEY]: monitor(2),
      [PID_KEY]: { stdout: "u 1472655\n" },
    });
    const control = new UresourcedControl({
      run,
      sleep: async (ms) => void waits.push(ms),
    });
    await control.set("restart");
    expect(waits).toEqual([3000]);
    expect(calls.some((call) => call.startsWith(MONITOR_KEY))).toBe(true);
    expect((await control.status()).looping).toBe(false);
  });

  it("says plainly when it is missing or a step fails", async () => {
    const missing = fakeRunner({
      "systemctl --user show": {
        stdout: "LoadState=not-found\nActiveState=inactive\nMainPID=0\n",
      },
    });
    await expect(
      new UresourcedControl({ run: missing.run }).set("off"),
    ).rejects.toThrow("uresourced is not installed");
    const failing = fakeRunner({
      "systemctl --user show": { stdout: SHOW },
      "systemctl --user stop": { code: 1 },
    });
    await expect(
      new UresourcedControl({ run: failing.run }).set("off"),
    ).rejects.toThrow("Could not stop uresourced");
  });
});
