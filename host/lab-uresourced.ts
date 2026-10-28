import { readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UresourcedStatus } from "../src/fork/lab/labProtocol";
import {
  parseShow,
  parseUnixTimestamp,
  runUntil,
  settled,
  type CommandRunner,
} from "./lab-system";

const UNIT = "uresourced.service";
const PROBE_SECONDS = 2;
/** From this many calls a second it is fighting systemd over a setting. */
export const LOOPING_CALLS_PER_SECOND = 20;
/** Senders resolved to a pid per look; a busy bus has few callers anyway. */
const MAX_SENDERS = 16;
/** A set, queue wait included, ends within this; clients wait 60 s. */
const SET_BUDGET_MS = 30_000;
/** A look ends within this. */
const LOOK_BUDGET_MS = 12_000;

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
  /** Where ~/.config/systemd/user lives. */
  home?: string;
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
  /** One set at a time, as the phone and the desktop may both call. */
  private setting: Promise<unknown> = Promise.resolve();
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
  probe(deadline = this.now() + LOOK_BUDGET_MS): Promise<void> {
    this.probing ??= this.look(deadline).finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  set(action: "off" | "on" | "restart"): Promise<void> {
    // The deadline counts the wait behind another set.
    const deadline = this.now() + SET_BUDGET_MS;
    const next = this.setting.then(() => this.apply(action, deadline));
    this.setting = next.catch(() => undefined);
    return next;
  }

  private async apply(
    action: "off" | "on" | "restart",
    deadline: number,
  ): Promise<void> {
    const run = runUntil(this.options.run, deadline, this.now);
    const unit = await this.unit(run);
    if (!unit.installed) throw new Error("uresourced is not installed");
    if (action === "off") {
      await this.systemctl(run, ["stop", UNIT], "Could not stop uresourced");
      await this.systemctl(
        run,
        ["mask", "--no-reload", UNIT],
        "Could not turn uresourced off",
      );
      this.lastLook = null;
      return;
    }
    if (action === "on") {
      await this.systemctl(
        run,
        ["unmask", "--no-reload", UNIT],
        "Could not turn uresourced on",
      );
      // Unmasking changes a unit file; it is stopped, so a reload is safe.
      if (unit.masked) {
        await this.systemctl(
          run,
          ["daemon-reload"],
          "Could not turn uresourced on",
        );
      }
      await this.systemctl(run, ["start", UNIT], "Could not start uresourced");
      await this.freshLook(deadline);
      return;
    }
    await this.systemctl(
      run,
      ["restart", UNIT],
      "Could not restart uresourced",
    );
    await this.wait(Math.min(3000, Math.max(0, deadline - this.now())));
    await this.freshLook(deadline);
  }

  /** A look begun after the action; it never fails an action that worked. */
  private async freshLook(deadline: number): Promise<void> {
    // A look already running may have started before the action.
    await settled(this.probing, deadline - this.now());
    if (this.probing || this.now() >= deadline) return;
    await this.probe(Math.min(deadline, this.now() + LOOK_BUDGET_MS)).catch(
      () => undefined,
    );
  }

  /** `systemctl --user mask` writes a link to /dev/null, which systemd's
   *  LoadState only shows after a daemon-reload. */
  private async maskedOnDisk(): Promise<boolean> {
    const file = join(
      this.options.home ?? homedir(),
      ".config/systemd/user",
      UNIT,
    );
    try {
      return (await readlink(file)) === "/dev/null";
    } catch {
      return false;
    }
  }

  private async unit(run = this.options.run): Promise<UnitState> {
    const result = await run(
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
    const linked = await this.maskedOnDisk();
    const fields = parseShow(result.stdout)[0] ?? {};
    const load = fields.LoadState ?? "not-found";
    const active = fields.ActiveState === "active";
    const pid = Number(fields.MainPID);
    return {
      installed: load !== "not-found",
      active,
      masked: load === "masked" || linked,
      pid: active && pid > 0 ? pid : null,
      since: active ? parseUnixTimestamp(fields.ActiveEnterTimestamp) : null,
    };
  }

  private async look(deadline: number): Promise<void> {
    const run = runUntil(this.options.run, deadline, this.now);
    const unit = await this.unit(run);
    const result = await run(
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
      { timeoutMs: PROBE_SECONDS * 1000 + 2000 },
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
        if (this.now() >= deadline) break;
        const reply = await run(
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
          { timeoutMs: 1500 },
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

  private async systemctl(
    run: CommandRunner,
    args: string[],
    failure: string,
  ): Promise<void> {
    const result = await run("systemctl", ["--user", ...args], {
      timeoutMs: 10_000,
    });
    if (result.code !== 0) throw new Error(failure);
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
