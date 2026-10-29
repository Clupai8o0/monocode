import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { HostStore } from "./store";
import type {
  AgentTimeZoneStatus,
  LabMethod,
  LabParams,
  LabStatus,
  RemoteControlAccount,
  RemoteControlChoice,
  RemoteControlMachine,
  RemoteControlScope,
  RelayStatus,
} from "../src/fork/lab/labProtocol";
import { hostRelay } from "./relay";
import { runCommand, type CommandRunner } from "./lab-system";
import { UresourcedControl } from "./lab-uresourced";
import { KrdpControl } from "./lab-krdp";

export type LabCaller = {
  /** The device whose credential made the call; null once revoked. */
  device: { id: string; name: string } | null;
  surface: "rpc" | "mobile";
};

type Platform = LabStatus["platform"];

/** The relay's switch, as the lab uses it. */
export type LabRelay = {
  status(): RelayStatus;
  setEnabled(enabled: boolean): Promise<RelayStatus>;
};

export type HostLabOptions = {
  dataDir: string;
  store: HostStore;
  /** Tests replace the machine around the lab. */
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  machine?: string;
  home?: string;
  now?: () => number;
  relay?: LabRelay;
  uresourced?: UresourcedControl;
  krdp?: KrdpControl;
  /** Where zone files live; tests point it at a fake tree. */
  zoneInfo?: string;
  /** The host's own zone; tests replace reading /etc/localtime. */
  hostZone?: () => string | null;
};

/** <dataDir>/lab.json */
type LabFile = {
  desired: RemoteControlChoice;
  machines: Record<string, RemoteControlMachine>;
  /** Older files have none: the host's own zone. */
  timeZone?: { zone: string | null; updatedAt: number };
};

const ZONEINFO = "/usr/share/zoneinfo";

const DEFAULT_CHOICE: RemoteControlChoice = {
  scope: "all",
  updatedAt: 0,
  by: "default",
};
/** The account folders the host reads; it never writes them. */
const ACCOUNTS = [".claude", ".claude-exec"];
const MAX_MACHINES = 64;
/** A saved choice stamped further ahead than this came from a wrong clock. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * Home lab controls: where Remote Control starts, the relay's switch,
 * uresourced and remote desktop. Every method answers the whole LabStatus.
 */
export class HostLab {
  private readonly run: CommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly machine: string;
  private readonly home: string;
  private readonly now: () => number;
  private readonly uresourced: UresourcedControl;
  private readonly krdp: KrdpControl;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(readonly options: HostLabOptions) {
    this.run = options.run ?? runCommand;
    this.platform = options.platform ?? process.platform;
    this.machine = options.machine ?? hostname();
    this.home = options.home ?? homedir();
    this.now = options.now ?? Date.now;
    this.uresourced =
      options.uresourced ??
      new UresourcedControl({ run: this.run, now: this.now, home: this.home });
    this.krdp =
      options.krdp ??
      new KrdpControl({ run: this.run, home: this.home, now: this.now });
  }

  private get relay(): LabRelay {
    return (
      this.options.relay ??
      hostRelay({ dataDir: this.options.dataDir, store: this.options.store })
    );
  }

  private get linux(): boolean {
    return this.platform === "linux";
  }

  async handle(
    method: LabMethod,
    params: Record<string, unknown>,
    caller: LabCaller,
  ): Promise<LabStatus> {
    switch (method) {
      case "lab.status":
        if (params.probe === true && this.linux) await this.uresourced.probe();
        break;
      case "lab.remoteControl.set":
        await this.setScope(params, caller);
        break;
      case "lab.relay.set":
        if (typeof params.enabled !== "boolean") {
          throw new Error("Say on or off");
        }
        await this.relay.setEnabled(params.enabled);
        break;
      case "lab.uresourced.set": {
        const action = params.action;
        if (action !== "off" && action !== "on" && action !== "restart") {
          throw new Error("Unknown action");
        }
        this.linuxOnly();
        await this.uresourced.set(action);
        break;
      }
      case "lab.remoteDesktop.set":
        if (typeof params.enabled !== "boolean") {
          throw new Error("Say on or off");
        }
        this.linuxOnly();
        await this.krdp.set(params.enabled);
        break;
      case "lab.timeZone.set":
        await this.setTimeZone(params.zone);
        break;
      case "lab.report":
        if (caller.surface !== "rpc") throw new Error("Only desktops report");
        await this.report(params);
        break;
      default:
        throw new Error("Unknown lab method");
    }
    return this.status();
  }

  async status(): Promise<LabStatus> {
    const [file, self, uresourced, remoteDesktop] = await Promise.all([
      this.read(),
      this.self(),
      this.linux ? this.uresourced.status().catch(() => null) : null,
      this.linux ? this.krdp.status().catch(() => null) : null,
    ]);
    const machines = Object.values(file.machines)
      .filter((machine) => machine.machine !== this.machine)
      .concat({ ...self, scope: file.desired.scope })
      .sort((a, b) => a.machine.localeCompare(b.machine));
    return {
      version: 1,
      machine: this.machine,
      platform: asPlatform(this.platform),
      remoteControl: { desired: file.desired, machines },
      relay: this.relay.status(),
      uresourced,
      remoteDesktop,
      timeZone: {
        zone: file.timeZone?.zone ?? null,
        updatedAt: file.timeZone?.updatedAt ?? 0,
        hostZone: (this.options.hostZone ?? systemZone)(),
      } satisfies AgentTimeZoneStatus,
    };
  }

  private async setTimeZone(value: unknown): Promise<void> {
    if (value !== null && typeof value !== "string") {
      throw new Error("Name a time zone, or none to follow this host");
    }
    if (value !== null) {
      if (!validZoneName(value)) {
        throw new Error(`Not a time zone name: ${String(value).slice(0, 64)}`);
      }
      if (!zoneInstalled(value, this.options.zoneInfo)) {
        throw new Error(`Unknown time zone: ${value}`);
      }
    }
    const updatedAt = this.now();
    await this.update((file) => {
      file.timeZone = { zone: value, updatedAt };
      return true;
    });
  }

  private linuxOnly(): void {
    if (!this.linux) throw new Error("Only on Linux");
  }

  private async setScope(
    params: Record<string, unknown>,
    caller: LabCaller,
  ): Promise<void> {
    const scope = asScope(params.scope);
    // A clock running ahead must not lock the choice for everyone else.
    const updatedAt = Math.min(
      params.updatedAt === undefined ? this.now() : asTime(params.updatedAt),
      this.now(),
    );
    await this.update((file) => {
      // Newest wins; the same moment again changes nothing either.
      if (updatedAt <= file.desired.updatedAt) return false;
      file.desired = {
        scope,
        updatedAt,
        by: (caller.device?.name ?? "unknown").slice(0, 80),
      };
      return true;
    });
  }

  private async report(params: Record<string, unknown>): Promise<void> {
    const { machine, platform, remoteControl } = params as Partial<
      LabParams["lab.report"]
    >;
    if (
      typeof machine !== "string" ||
      !machine.trim() ||
      machine.length > 128
    ) {
      throw new Error("Name the machine");
    }
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
      throw new Error("Unknown platform");
    }
    if (!remoteControl || typeof remoteControl !== "object") {
      throw new Error("Say what Remote Control is");
    }
    const scope = asScope(remoteControl.scope);
    const accounts = Array.isArray(remoteControl.accounts)
      ? remoteControl.accounts
          .filter(
            (account): account is RemoteControlAccount =>
              typeof account?.account === "string" &&
              typeof account.enabled === "boolean",
          )
          .slice(0, 8)
          .map(({ account, enabled }) => ({
            account: account.slice(0, 64),
            enabled,
          }))
      : [];
    await this.update((file) => {
      file.machines[machine] = {
        machine,
        lab: platform === "linux",
        scope,
        accounts,
        reportedAt: this.now(),
      };
      const names = Object.values(file.machines)
        .sort((a, b) => b.reportedAt - a.reportedAt)
        .map((entry) => entry.machine);
      for (const name of names.slice(MAX_MACHINES)) delete file.machines[name];
      return true;
    });
  }

  /** The host machine itself, from its own account settings. */
  private async self(): Promise<Omit<RemoteControlMachine, "scope">> {
    const accounts: RemoteControlAccount[] = [];
    for (const account of ACCOUNTS) {
      const dir = join(this.home, account);
      if (!existsSync(dir)) continue;
      let enabled = false;
      try {
        const settings = JSON.parse(
          await readFile(join(dir, "settings.json"), "utf8"),
        ) as Record<string, unknown>;
        enabled = settings.remoteControlAtStartup === true;
      } catch {
        // No file or not JSON: Remote Control is off there.
      }
      accounts.push({ account, enabled });
    }
    return {
      machine: this.machine,
      lab: this.linux,
      accounts,
      reportedAt: this.now(),
    };
  }

  private get file(): string {
    return join(this.options.dataDir, "lab.json");
  }

  /** strict: a damaged file throws instead of reading as empty, so an
   *  update never overwrites saved state it could not read. */
  private async read(strict = false): Promise<LabFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || !strict) {
        return { desired: { ...DEFAULT_CHOICE }, machines: {} };
      }
      throw new Error("Could not read the saved lab settings");
    }
    try {
      const raw = JSON.parse(text) as Partial<LabFile>;
      const desired = raw.desired;
      const machines: Record<string, RemoteControlMachine> = {};
      if (raw.machines && typeof raw.machines === "object") {
        for (const [name, entry] of Object.entries(raw.machines)) {
          if (!validMachine(entry)) continue;
          machines[name] = {
            ...entry,
            accounts: entry.accounts.filter(
              (account) =>
                typeof account?.account === "string" &&
                typeof account.enabled === "boolean",
            ),
          };
        }
      }
      const timeZone = raw.timeZone;
      return {
        ...(timeZone &&
        (timeZone.zone === null || validZoneName(timeZone.zone)) &&
        Number.isFinite(timeZone.updatedAt)
          ? { timeZone: { zone: timeZone.zone, updatedAt: timeZone.updatedAt } }
          : {}),
        desired:
          desired &&
          (desired.scope === "all" || desired.scope === "lab") &&
          Number.isFinite(desired.updatedAt) &&
          typeof desired.by === "string"
            ? desired.updatedAt > this.now() + MAX_FUTURE_MS
              ? { ...desired, updatedAt: 0 }
              : desired
            : { ...DEFAULT_CHOICE },
        machines,
      };
    } catch {
      if (strict) throw new Error("The saved lab settings are damaged");
      return { desired: { ...DEFAULT_CHOICE }, machines: {} };
    }
  }

  /** Read, change and save lab.json one call at a time, atomically. */
  private update(change: (file: LabFile) => boolean): Promise<void> {
    const next = this.saving.then(async () => {
      const file = await this.read(true);
      if (!change(file)) return;
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temp, this.file);
    });
    this.saving = next.catch(() => undefined);
    return next;
  }
}

/** One lab.json machine entry, whole enough for status() to use. */
function validMachine(entry: unknown): entry is RemoteControlMachine {
  if (!entry || typeof entry !== "object") return false;
  const machine = entry as Partial<RemoteControlMachine>;
  return (
    typeof machine.machine === "string" &&
    typeof machine.lab === "boolean" &&
    (machine.scope === "all" || machine.scope === "lab") &&
    Array.isArray(machine.accounts) &&
    typeof machine.reportedAt === "number" &&
    Number.isFinite(machine.reportedAt)
  );
}

function asScope(value: unknown): RemoteControlScope {
  if (value !== "all" && value !== "lab") throw new Error("Choose all or lab");
  return value;
}

function asTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Bad time");
  }
  return Math.floor(value);
}

function asPlatform(platform: NodeJS.Platform): Platform {
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

/** The shared zone name rule: segments of [A-Za-z0-9_+-] joined by "/". */
export function validZoneName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(value)
  );
}

/** True when the zone is a regular file under the zone folder. */
export function zoneInstalled(zone: string, zoneInfo = ZONEINFO): boolean {
  if (!validZoneName(zone)) return false;
  try {
    return statSync(join(zoneInfo, zone)).isFile();
  } catch {
    return false;
  }
}

/** The host's own zone, from /etc/localtime, else /etc/timezone. */
export function systemZone(): string | null {
  try {
    const target = readlinkSync("/etc/localtime");
    const at = target.lastIndexOf("zoneinfo/");
    if (at >= 0) {
      const zone = target.slice(at + "zoneinfo/".length);
      if (validZoneName(zone)) return zone;
    }
  } catch {
    // Not a link, or missing: try the Debian file.
  }
  try {
    const zone = readFileSync("/etc/timezone", "utf8").split("\n")[0].trim();
    if (validZoneName(zone)) return zone;
  } catch {
    // No file: unknown.
  }
  return null;
}

/**
 * The zone agent sessions start in, as their TZ: the stored zone while it
 * is still installed, else null (the host's own zone). Never throws.
 */
export function agentTimeZone(dataDir: string, zoneInfo = ZONEINFO): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "lab.json"), "utf8")) as Partial<LabFile>;
    const zone = raw?.timeZone?.zone;
    return validZoneName(zone) && zoneInstalled(zone, zoneInfo) ? zone : null;
  } catch {
    return null;
  }
}

let active: HostLab | undefined;

/** The host's lab controls, made on first use. */
export function hostLab(options: HostLabOptions): HostLab {
  if (!active || active.options.dataDir !== options.dataDir) {
    active = new HostLab(options);
  }
  return active;
}
