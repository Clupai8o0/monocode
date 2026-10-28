import type { UresourcedStatus } from "../src/fork/lab/labProtocol";
import {
  parseShow,
  parseUnixTimestamp,
  type CommandRunner,
} from "./lab-system";

const UNIT = "uresourced.service";
const PROBE_SECONDS = 2;
/** From this many calls a second it is fighting systemd over a setting. */
export const LOOPING_CALLS_PER_SECOND = 20;
/** Senders resolved to a pid per look; a busy bus has few callers anyway. */
const MAX_SENDERS = 16;

type UnitState = {
  installed: boolean;
  active: boolean;
  masked: boolean;
  pid: number | null;
  since: number | null;
};

export type UresourcedOptions = {
  run: CommandRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** The senders of each SetUnitProperties call in busctl monitor's
 *  --json=short output, one call per line. */
export function parseMonitor(stdout: string): string[] {
  const senders: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (
        message.type === "method_call" &&
        message.member === "SetUnitProperties" &&
        typeof message.sender === "string"
      ) {
        senders.push(message.sender);
      }
    } catch {
      // busctl cut off mid-line when the look ended.
    }
  }
  return senders;
}

/** busctl's answer to GetConnectionUnixProcessID: "u 1472655". */
export function parsePidReply(stdout: string): number | null {
  const match = /^u (\d+)/.exec(stdout.trim());
  return match ? Number(match[1]) : null;
}

/**
 * uresourced on a Linux machine: its state, a short look at whether it is
 * looping, and off (stop + mask), on (unmask + start) and restart.
 */
export class UresourcedControl {
  private lastLook: UresourcedStatus["loop"] = null;
  private probing: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: UresourcedOptions) {
    this.now = options.now ?? Date.now;
    this.wait =
      options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  async status(): Promise<UresourcedStatus> {
    const unit = await this.unit();
    const loop = this.lastLook;
    return {
      ...unit,
      loop,
      looping: Boolean(
        unit.active && loop && loop.callsPerSecond >= LOOPING_CALLS_PER_SECOND,
      ),
    };
  }

  /** Takes a fresh 2 s look; a look already running is shared. */
  probe(): Promise<void> {
    this.probing ??= this.look().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  async set(action: "off" | "on" | "restart"): Promise<void> {
    const unit = await this.unit();
    if (!unit.installed) throw new Error("uresourced is not installed");
    if (action === "off") {
      await this.systemctl(["stop", UNIT], "Could not stop uresourced");
      await this.systemctl(
        ["mask", "--no-reload", UNIT],
        "Could not turn uresourced off",
      );
      this.lastLook = null;
      return;
    }
    if (action === "on") {
      await this.systemctl(
        ["unmask", "--no-reload", UNIT],
        "Could not turn uresourced on",
      );
      // Unmasking changes a unit file; it is stopped, so a reload is safe.
      if (unit.masked) {
        await this.systemctl(["daemon-reload"], "Could not turn uresourced on");
      }
      await this.systemctl(["start", UNIT], "Could not start uresourced");
      await this.probe();
      return;
    }
    await this.systemctl(["restart", UNIT], "Could not restart uresourced");
    await this.wait(3000);
    await this.probe();
  }

  private async unit(): Promise<UnitState> {
    const result = await this.options.run(
      "systemctl",
      [
        "--user",
        "show",
        UNIT,
        "--timestamp=unix",
        "-p",
        "LoadState,ActiveState,MainPID,ActiveEnterTimestamp",
      ],
      { timeoutMs: 5000 },
    );
    if (result.code !== 0) throw new Error("Could not read uresourced");
    const fields = parseShow(result.stdout)[0] ?? {};
    const load = fields.LoadState ?? "not-found";
    const active = fields.ActiveState === "active";
    const pid = Number(fields.MainPID);
    return {
      installed: load !== "not-found",
      active,
      masked: load === "masked",
      pid: active && pid > 0 ? pid : null,
      since: active ? parseUnixTimestamp(fields.ActiveEnterTimestamp) : null,
    };
  }

  private async look(): Promise<void> {
    const unit = await this.unit();
    const result = await this.options.run(
      "timeout",
      [
        String(PROBE_SECONDS),
        "busctl",
        "--user",
        "monitor",
        "--json=short",
        "--match",
        "type='method_call',member='SetUnitProperties'",
      ],
      { timeoutMs: PROBE_SECONDS * 1000 + 3000 },
    );
    // timeout ends busctl with 124; anything else without output failed.
    if (result.code !== 124 && result.code !== 0 && !result.stdout) {
      throw new Error("Could not watch the user bus");
    }
    const senders = parseMonitor(result.stdout);
    const counts = new Map<string, number>();
    for (const sender of senders) {
      counts.set(sender, (counts.get(sender) ?? 0) + 1);
    }
    let fromUresourced = 0;
    if (unit.pid !== null) {
      const busiest = [...counts].sort((a, b) => b[1] - a[1]);
      for (const [sender, calls] of busiest.slice(0, MAX_SENDERS)) {
        const reply = await this.options.run(
          "busctl",
          [
            "--user",
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            "s",
            sender,
          ],
          { timeoutMs: 3000 },
        );
        if (reply.code === 0 && parsePidReply(reply.stdout) === unit.pid) {
          fromUresourced += calls;
        }
      }
    }
    this.lastLook = {
      callsPerSecond: round(senders.length / PROBE_SECONDS),
      fromUresourced: round(fromUresourced / PROBE_SECONDS),
      sampledAt: this.now(),
    };
  }

  private async systemctl(args: string[], failure: string): Promise<void> {
    const result = await this.options.run("systemctl", ["--user", ...args], {
      timeoutMs: 20_000,
    });
    if (result.code !== 0) throw new Error(failure);
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
