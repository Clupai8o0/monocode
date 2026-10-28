import { describe, expect, it } from "vitest";
import {
  accountFolder,
  accountLabel,
  accountsLine,
  buildReport,
  choiceLine,
  decideSync,
  errorText,
  formatFingerprint,
  hasLabCapability,
  localRelayLine,
  machineRows,
  parseLocalRelay,
  parseLocalRemoteControl,
  relayLine,
  remoteDesktopView,
  timeAgo,
  uresourcedView,
  type LocalRemoteControl,
} from "./labModel";
import type { LabStatus } from "./labProtocol";

const NOW = 1_800_000_000_000;

function status(overrides: Partial<LabStatus> = {}): LabStatus {
  return {
    version: 1,
    machine: "vivobook",
    platform: "linux",
    remoteControl: {
      desired: { scope: "lab", updatedAt: NOW - 60_000, by: "Pixel" },
      machines: [
        {
          machine: "vivobook",
          lab: true,
          scope: "lab",
          accounts: [{ account: ".claude", enabled: true }],
          reportedAt: NOW - 5 * 60_000,
        },
        {
          machine: "Sams-Mac",
          lab: false,
          scope: "lab",
          accounts: [{ account: ".claude", enabled: false }],
          reportedAt: NOW,
        },
      ],
    },
    relay: { enabled: false, updatedAt: 0, peers: [], sessions: 0 },
    uresourced: null,
    remoteDesktop: null,
    ...overrides,
  };
}

const local: LocalRemoteControl = {
  scope: "all",
  updatedAt: NOW - 120_000,
  by: "Sams-Mac",
  lab: false,
  wanted: true,
  accounts: [
    { account: "main", enabled: true },
    { account: "cx", enabled: true },
  ],
};

describe("hasLabCapability", () => {
  it("needs lab.v1 in the capabilities", () => {
    expect(hasLabCapability({ capabilities: ["shows", "lab.v1"] })).toBe(true);
    expect(hasLabCapability({ capabilities: ["shows"] })).toBe(false);
    expect(hasLabCapability(null)).toBe(false);
    expect(hasLabCapability({ capabilities: "lab.v1" })).toBe(false);
  });
});

describe("parseLocalRemoteControl", () => {
  it("reads the script's status", () => {
    expect(
      parseLocalRemoteControl({
        scope: "lab",
        updatedAt: 5,
        by: "me",
        lab: false,
        wanted: false,
        accounts: [{ account: "main", enabled: false }, { account: "cx", enabled: true, dir: ".claude-cx" }, { nope: 1 }],
        changed: true,
      }),
    ).toEqual({
      scope: "lab",
      updatedAt: 5,
      by: "me",
      lab: false,
      wanted: false,
      accounts: [
        { account: "main", enabled: false },
        { account: "cx", enabled: true, dir: ".claude-cx" },
      ],
      changed: true,
      machine: undefined,
    });
  });

  it("refuses anything else", () => {
    expect(parseLocalRemoteControl({ error: "boom" })).toBeUndefined();
    expect(parseLocalRemoteControl({ scope: "some", updatedAt: 1 })).toBeUndefined();
    expect(parseLocalRemoteControl("x")).toBeUndefined();
  });
});

describe("decideSync", () => {
  const at = (scope: "all" | "lab", updatedAt: number) => ({ scope, updatedAt, by: "x" });
  const T = 1_000_000_000;

  it("pushes a newer local choice", () => {
    expect(decideSync(at("lab", 10), at("all", 5), T)).toEqual({
      kind: "push",
      params: { scope: "lab", updatedAt: 10 },
    });
  });

  it("pulls a newer host choice", () => {
    expect(decideSync(at("lab", 5), { scope: "all", updatedAt: 10, by: "Pixel" }, T)).toEqual({
      kind: "pull",
      choice: { scope: "all", updatedAt: 10, by: "Pixel" },
    });
  });

  it("does nothing when both agree", () => {
    expect(decideSync(at("all", 10), at("all", 10), T)).toEqual({ kind: "none" });
  });

  it("does nothing when the scopes match, whatever the stamps", () => {
    expect(decideSync(at("all", 10), at("all", T * 2), T)).toEqual({ kind: "none" });
    expect(decideSync(at("lab", T * 2), at("lab", 10), T)).toEqual({ kind: "none" });
  });

  it("counts a stamp far in the future as now", () => {
    // The host's stamp is a day ahead, the local one a minute old.
    expect(decideSync(at("lab", T - 60_000), at("all", T + 86_400_000), T).kind).toBe("pull");
    // The local stamp is a day ahead; the host chose a minute ago, local counts as now.
    expect(decideSync(at("lab", T + 86_400_000), at("all", T - 60_000), T).kind).toBe("push");
    // Both far ahead: both count as now, the host wins the tie.
    expect(decideSync(at("lab", T + 86_400_000), at("all", T + 60 * 60_000), T).kind).toBe("pull");
    // Within five minutes a stamp counts as it is.
    expect(decideSync(at("lab", T + 4 * 60_000), at("all", T), T).kind).toBe("push");
  });

  it("lets the host win a tie with different scopes", () => {
    expect(decideSync(at("all", 10), at("lab", 10), T).kind).toBe("pull");
  });
});

describe("accounts", () => {
  it("maps the script's names to folders and back", () => {
    expect(accountFolder("main")).toBe(".claude");
    expect(accountFolder("cx")).toBe(".claude-exec");
    expect(accountFolder(".claude-cx")).toBe(".claude-cx");
    expect(accountLabel(".claude")).toBe("main");
    expect(accountLabel(".claude-exec")).toBe("cx");
    expect(accountLabel(".claude-cx")).toBe("cx");
    expect(accountLabel("cx")).toBe("cx");
  });

  it("writes one line", () => {
    expect(accountsLine(local.accounts)).toBe("main on · cx on");
    expect(accountsLine([])).toBe("No Claude accounts");
  });
});

describe("buildReport", () => {
  it("sends folder names and the current choice", () => {
    expect(buildReport("Sams-Mac", "darwin", local)).toEqual({
      machine: "Sams-Mac",
      platform: "darwin",
      remoteControl: {
        scope: "all",
        updatedAt: NOW - 120_000,
        by: "Sams-Mac",
        accounts: [
          { account: ".claude", enabled: true },
          { account: ".claude-exec", enabled: true },
        ],
      },
    });
  });

  it("uses the folder the script names when it gives one", () => {
    const withDirs = {
      ...local,
      accounts: [
        { account: "main", enabled: true, dir: ".claude" },
        { account: "cx", enabled: false, dir: ".claude-cx" },
      ],
    };
    expect(buildReport("Sams-Mac", "darwin", withDirs).remoteControl.accounts).toEqual([
      { account: ".claude", enabled: true },
      { account: ".claude-cx", enabled: false },
    ]);
  });
});

describe("text", () => {
  it("says how long ago", () => {
    expect(timeAgo(0, NOW)).toBe("never");
    expect(timeAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(timeAgo(NOW - 48 * 3_600_000, NOW)).toBe("2 days ago");
  });

  it("says who chose", () => {
    expect(choiceLine({ scope: "lab", updatedAt: NOW - 60_000, by: "Pixel" }, NOW)).toBe(
      "Chosen by Pixel, 1 min ago",
    );
    expect(choiceLine({ scope: "all", updatedAt: 0, by: "default" }, NOW)).toMatch(/Not chosen yet/);
  });

  it("formats fingerprints", () => {
    expect(formatFingerprint("abcd01")).toBe("AB:CD:01");
    expect(formatFingerprint(null)).toBeNull();
  });

  it("puts errors in plain words", () => {
    expect(errorText(new Error("Command fork_lab_rc_status not found"), "Reading it")).toBe(
      "Reading it needs a newer MonoCode on this Mac.",
    );
    expect(errorText("unknown method lab.status")).toBe("That needs a newer host on that machine.");
    expect(errorText({ error: "Only on Linux" })).toBe("Only on Linux");
    expect(errorText(undefined)).toBe("That didn't work.");
    expect(errorText(new Error("request timed out"))).toBe("The machine took too long to answer.");
  });
});

describe("machineRows", () => {
  it("puts this Mac first and skips its own report", () => {
    const rows = machineRows(status(), local, "Sams-Mac", NOW);
    expect(rows.map((row) => row.name)).toEqual(["This Mac", "vivobook"]);
    // Scope "lab" on a Mac wants off, but both accounts are on.
    expect(rows[0].pending).toBe(true);
    expect(rows[1]).toMatchObject({ pending: false, accounts: "main on" });
    expect(rows[1].detail).toBe("Lab machine · reported 5 min ago");
  });

  it("shows every reported machine without local status", () => {
    expect(machineRows(status(), undefined, "Mac", NOW)).toHaveLength(2);
  });
});

describe("uresourcedView", () => {
  const base = {
    installed: true,
    active: true,
    masked: false,
    pid: 900,
    since: NOW - 10 * 60_000,
    loop: { callsPerSecond: 42.4, fromUresourced: 40, sampledAt: NOW },
    looping: true,
  };

  it("warns when it loops", () => {
    const view = uresourcedView(base, NOW);
    expect(view).toMatchObject({
      state: "Running, started 10 min ago",
      tone: "warn",
      looping: true,
      canTurnOff: true,
      canTurnOn: false,
      canRestart: true,
    });
    expect(view.calls).toBe("42 calls a second, 40 from uresourced · checked just now");
  });

  it("offers Turn on when masked", () => {
    const view = uresourcedView({ ...base, active: false, masked: true, loop: null, looping: false }, NOW);
    expect(view).toMatchObject({ state: "Turned off", canTurnOff: false, canTurnOn: true, canRestart: false, calls: null });
  });

  it("offers nothing when not installed", () => {
    const view = uresourcedView({ ...base, installed: false, active: false, looping: false }, NOW);
    expect(view.state).toBe("Not installed");
    expect(view.canTurnOff || view.canTurnOn || view.canRestart).toBe(false);
  });
});

describe("remoteDesktopView", () => {
  const base: NonNullable<LabStatus["remoteDesktop"]> = {
    installed: true,
    running: true,
    via: "monocode",
    lanExposed: false,
    address: "100.64.0.2",
    port: 3389,
    username: "clupai",
    certificate: { present: true, sha256: "aabb" },
    systemUser: true,
    preauthorized: true,
    rdpFile: "full address:s:100.64.0.2:3389\r\n",
    uri: "rdp://x",
  };

  it("shows the address and fingerprint", () => {
    expect(remoteDesktopView(base)).toEqual({
      state: "On, Tailscale only",
      on: true,
      address: "100.64.0.2:3389",
      username: "clupai",
      fingerprint: "AA:BB",
      warnings: [],
      notes: [],
    });
  });

  it("warns about the local network and Tailscale", () => {
    const view = remoteDesktopView({ ...base, via: "kde", lanExposed: true, address: null, preauthorized: false });
    expect(view.state).toBe("On, run by KDE");
    expect(view.address).toBeNull();
    expect(view.warnings).toHaveLength(2);
    expect(view.notes).toEqual(["Someone may need to allow screen sharing on the laptop itself."]);
  });
});

describe("relay", () => {
  it("counts peers and sessions", () => {
    expect(relayLine({ enabled: false, updatedAt: 0, peers: [], sessions: 0 })).toBe("Off");
    expect(
      relayLine({ enabled: true, updatedAt: 1, peers: [{ id: "a", name: "Mac", sessions: 2, lastSeen: NOW }], sessions: 3 }),
    ).toBe("1 computer linked · 3 sessions shared");
  });

  it("reads this Mac's side", () => {
    const parsed = parseLocalRelay({
      enabled: true,
      hosts: [
        { machineId: "m1", name: "vivobook", connected: true, proxies: 2, lastSyncAt: NOW, lastError: null, enabled: true },
        { machineId: "m3", name: "pi", connected: false, proxies: 0, lastSyncAt: null, lastError: null },
        5,
      ],
    });
    expect(parsed?.hosts).toHaveLength(2);
    expect(parsed?.hosts[1].enabled).toBe(false);
    expect(localRelayLine(parsed, "m3", NOW)).toBe("The relay is off there.");
    expect(localRelayLine(parsed, "m1", NOW)).toBe("This Mac is linked, 2 sessions from elsewhere · synced just now");
    expect(localRelayLine(parsed, "m2", NOW)).toBe("This Mac is not linked to it yet.");
    expect(localRelayLine(undefined, "m1", NOW)).toBeNull();
    expect(
      localRelayLine({ enabled: true, hosts: [{ ...parsed!.hosts[0], lastError: "refused" }] }, "m1", NOW),
    ).toBe("This Mac couldn't reach it: refused");
  });
});
