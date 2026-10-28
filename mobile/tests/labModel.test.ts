import { describe, expect, it, vi } from "vitest";

import {
  accountName,
  accountsLine,
  ago,
  callLab,
  callsLine,
  choiceLine,
  fingerprintText,
  isLabStatus,
  isTailscaleIpv4,
  LAB_SLOW_TIMEOUT_MS,
  labTimeout,
  rdpAddress,
  rdpLink,
  rdpOpenUrls,
  relayLine,
  scopeStamp,
  uresourcedActions,
  uresourcedState,
} from "@/features/lab/labModel";
import type {
  LabStatus,
  RemoteDesktopStatus,
  UresourcedStatus,
} from "@/features/lab/types";

const NOW = 1_800_000_000_000;

function status(overrides: Partial<LabStatus> = {}): LabStatus {
  return {
    version: 1,
    machine: "vivobook",
    platform: "linux",
    remoteControl: {
      desired: { scope: "lab", updatedAt: NOW - 5 * 60_000, by: "Pixel" },
      machines: [],
    },
    relay: { enabled: true, updatedAt: 0, peers: [], sessions: 0 },
    uresourced: null,
    remoteDesktop: null,
    ...overrides,
  };
}

const uresourced: UresourcedStatus = {
  installed: true,
  active: true,
  masked: false,
  pid: 1234,
  since: null,
  loop: { callsPerSecond: 42.26, fromUresourced: 40, sampledAt: NOW },
  looping: true,
};

describe("lab calls", () => {
  it("asks the host and answers its status", async () => {
    const command = vi.fn(async () => status());
    const got = await callLab(command as never, "lab.relay.set", {
      enabled: false,
    });
    expect(command).toHaveBeenCalledWith(
      "lab.relay.set",
      { enabled: false },
      undefined,
      undefined,
    );
    expect(got.machine).toBe("vivobook");
  });

  it("refuses lab.report and a reply that is not a status", async () => {
    const command = vi.fn(async () => ({ nope: true }));
    await expect(
      callLab(command as never, "lab.report" as never, {} as never),
    ).rejects.toThrow("Not a phone lab method");
    expect(command).not.toHaveBeenCalled();
    await expect(callLab(command as never, "lab.status", {})).rejects.toThrow(
      "no lab status",
    );
  });

  it("passes the host's error through", async () => {
    const command = vi.fn(async () => {
      throw new Error("Only on Linux");
    });
    await expect(
      callLab(command as never, "lab.uresourced.set", { action: "off" }),
    ).rejects.toThrow("Only on Linux");
  });
});

describe("lab words", () => {
  it("names accounts main and cx", () => {
    expect(accountName(".claude")).toBe("main");
    expect(accountName(".claude-exec")).toBe("cx");
    expect(accountName("/home/x/.claude-cx")).toBe("cx");
    expect(
      accountsLine([
        { account: ".claude", enabled: true },
        { account: ".claude-exec", enabled: false },
      ]),
    ).toBe("main on, cx off");
    expect(accountsLine([])).toBe("No accounts");
  });

  it("says how long ago", () => {
    expect(ago(0, NOW)).toBe("never");
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(ago(NOW - 26 * 3_600_000, NOW)).toBe("1 day ago");
  });

  it("says who chose the scope", () => {
    expect(choiceLine(status(), NOW)).toBe("Chosen by Pixel, 5 min ago");
    const fresh = status();
    fresh.remoteControl.desired = { scope: "all", updatedAt: 0, by: "default" };
    expect(choiceLine(fresh, NOW)).toBe("Not chosen yet, so every machine");
  });

  it("counts relay machines and sessions", () => {
    const value = status();
    value.relay.peers = [{ id: "d1", name: "Mac", sessions: 2, lastSeen: NOW }];
    value.relay.sessions = 3;
    expect(relayLine(value)).toBe("1 machine linked, 3 sessions");
  });

  it("describes uresourced without its pid", () => {
    expect(uresourcedState(uresourced)).toBe("On, looping");
    expect(
      uresourcedState({ ...uresourced, masked: true, active: false }),
    ).toBe("Off");
    expect(uresourcedState({ ...uresourced, installed: false })).toBe(
      "Not installed",
    );
    expect(
      uresourcedState({ ...uresourced, active: false, looping: false }),
    ).toBe("Stopped");
    const line = callsLine(uresourced);
    expect(line).toBe("42.3 calls/s, 40 from uresourced");
    expect(line).not.toContain("1234");
    expect(callsLine({ ...uresourced, loop: null })).toBeNull();
  });

  it("builds the remote desktop address and what to open", () => {
    const desktop = {
      installed: true,
      running: true,
      via: "monocode" as const,
      lanExposed: false,
      address: "100.64.0.2",
      port: 3389,
      username: "clupai",
      certificate: { present: true, sha256: "ab12cd" },
      systemUser: true,
      preauthorized: true,
      rdpFile: null,
      uri: "rdp://full%20address=s:100.64.0.2:3389&username=s:clupai",
    };
    expect(rdpAddress(status({ remoteDesktop: desktop }))).toBe("100.64.0.2");
    expect(
      rdpAddress(status({ remoteDesktop: { ...desktop, port: 3390 } })),
    ).toBe("100.64.0.2:3390");
    expect(
      rdpAddress(status({ remoteDesktop: { ...desktop, address: null } })),
    ).toBeNull();
    expect(rdpOpenUrls(desktop.uri)).toEqual([
      desktop.uri,
      "market://details?id=com.microsoft.rdc.androidx",
      "https://play.google.com/store/apps/details?id=com.microsoft.rdc.androidx",
    ]);
    expect(rdpOpenUrls(null)).toHaveLength(2);
    expect(fingerprintText("ab12cd")).toBe("AB:12:CD");
  });
});

describe("review fixes", () => {
  const desktop: RemoteDesktopStatus = {
    installed: true,
    running: true,
    via: "monocode",
    lanExposed: false,
    address: "100.64.0.2",
    port: 3389,
    username: "clupai",
    certificate: { present: true, sha256: null },
    systemUser: true,
    preauthorized: true,
    rdpFile: null,
    uri: "rdp://evil",
  };

  it("checks every field the page reads", () => {
    expect(isLabStatus(status())).toBe(true);
    expect(isLabStatus(status({ uresourced, remoteDesktop: desktop }))).toBe(
      true,
    );
    const bad = (patch: object) => isLabStatus({ ...status(), ...patch });
    expect(
      bad({
        remoteControl: {
          desired: { scope: "x", updatedAt: 0, by: "" },
          machines: [],
        },
      }),
    ).toBe(false);
    expect(
      bad({
        remoteControl: {
          desired: { scope: "all", updatedAt: 0, by: "" },
          machines: {},
        },
      }),
    ).toBe(false);
    expect(
      bad({ relay: { enabled: "yes", updatedAt: 0, peers: [], sessions: 0 } }),
    ).toBe(false);
    expect(bad({ uresourced: { installed: true } })).toBe(false);
    expect(bad({ remoteDesktop: "on" })).toBe(false);
    expect(
      bad({
        relay: { enabled: true, updatedAt: 0, peers: [null], sessions: 0 },
      }),
    ).toBe(false);
    expect(
      bad({
        remoteControl: {
          desired: { scope: "all", updatedAt: 0, by: "" },
          machines: [
            { machine: "x", lab: true, reportedAt: 0, accounts: [null] },
          ],
        },
      }),
    ).toBe(false);
    expect(bad({ remoteDesktop: { ...desktop, certificate: null } })).toBe(
      false,
    );
  });

  it("waits 60 s for the slow lab calls", async () => {
    expect(labTimeout("lab.uresourced.set", { action: "off" })).toBe(
      LAB_SLOW_TIMEOUT_MS,
    );
    expect(labTimeout("lab.remoteDesktop.set", { enabled: true })).toBe(60_000);
    expect(labTimeout("lab.status", { probe: true })).toBe(60_000);
    expect(labTimeout("lab.status", {})).toBeUndefined();
    expect(labTimeout("lab.relay.set", { enabled: true })).toBeUndefined();
    const command = vi.fn(async () => status());
    await callLab(command as never, "lab.status", { probe: true });
    expect(command).toHaveBeenCalledWith(
      "lab.status",
      { probe: true },
      undefined,
      60_000,
    );
  });

  it("stamps a scope after the host's choice", () => {
    const value = status();
    expect(scopeStamp(value, NOW)).toBe(NOW);
    const ahead = value.remoteControl.desired.updatedAt + 1;
    expect(scopeStamp(value, 0)).toBe(ahead);
  });

  it("offers Turn off whenever uresourced is not masked", () => {
    expect(uresourcedActions({ ...uresourced, active: false })).toEqual({
      on: true,
      off: true,
      restart: false,
    });
    expect(uresourcedActions(uresourced)).toEqual({
      on: false,
      off: true,
      restart: true,
    });
    expect(uresourcedActions({ ...uresourced, masked: true })).toEqual({
      on: true,
      off: false,
      restart: false,
    });
    expect(uresourcedState({ ...uresourced, masked: true })).toBe(
      "Masked, still running",
    );
    expect(
      uresourcedState({ ...uresourced, masked: true, active: false }),
    ).toBe("Off");
  });

  it("builds the rdp link itself from checked parts", () => {
    expect(rdpLink(desktop)).toBe(
      "rdp://full%20address=s:100.64.0.2:3389&username=s:clupai",
    );
    expect(rdpLink({ ...desktop, address: "192.168.1.5" })).toBeNull();
    expect(rdpLink({ ...desktop, address: "100.128.0.1" })).toBeNull();
    expect(rdpLink({ ...desktop, address: "100.64.0.2&x=s:y" })).toBeNull();
    expect(rdpLink({ ...desktop, port: 0 })).toBeNull();
    expect(rdpLink({ ...desktop, port: 70000 })).toBeNull();
    expect(rdpLink({ ...desktop, username: "a&b" })).toBeNull();
    expect(rdpLink({ ...desktop, username: "" })).toBeNull();
    expect(isTailscaleIpv4("100.127.255.255")).toBe(true);
    expect(isTailscaleIpv4("100.064.0.1")).toBe(false);
  });
});
