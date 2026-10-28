import {
  LAB_CAPABILITY,
  type LabParams,
  type LabStatus,
  type RemoteControlAccount,
  type RemoteControlChoice,
  type RemoteControlScope,
} from "./labProtocol";

/**
 * Fork: Home lab, the pure part. What the desktop's Home lab settings show,
 * the newest-wins decision the lab watcher makes between this Mac and each
 * lab host, and the plain words for both. No I/O here.
 */

/** This Mac's Remote Control, as the vault's remote_control.py reports it
 * through the fork_lab_rc_status and fork_lab_rc_apply commands. */
export type LocalRemoteControl = RemoteControlChoice & {
  /** This machine is a lab machine (Linux). */
  lab: boolean;
  /** What remoteControlAtStartup should be here. */
  wanted: boolean;
  /** dir: the account's folder name (".claude", ".claude-exec"), when the script tells it. */
  accounts: { account: string; enabled: boolean; dir?: string }[];
  /** Only from fork_lab_rc_apply: the choice was saved. */
  changed?: boolean;
  /** This machine's name, when the native side tells it. */
  machine?: string;
};

export type RelayHostStatus = {
  machineId: string;
  name: string;
  connected: boolean;
  proxies: number;
  lastSyncAt: number | null;
  lastError: string | null;
  /** The relay is on for this host; false when the field is missing. */
  enabled: boolean;
};

/** fork_relay_status: this Mac's side of the relay. */
export type LocalRelayStatus = { enabled: boolean; hosts: RelayHostStatus[] };

export const SCOPES: { scope: RemoteControlScope; label: string; detail: string }[] = [
  {
    scope: "all",
    label: "Every machine",
    detail: "Claude sessions start with Remote Control on everywhere.",
  },
  {
    scope: "lab",
    label: "Only lab machines",
    detail: "Only the Linux machines keep it on. This Mac turns it off.",
  },
];

/** Whether an `environment.describe` answer offers the lab methods. */
export function hasLabCapability(describe: unknown): boolean {
  if (!describe || typeof describe !== "object") {
    return false;
  }
  const capabilities = (describe as Record<string, unknown>).capabilities;
  return Array.isArray(capabilities) && capabilities.includes(LAB_CAPABILITY);
}

export function isScope(value: unknown): value is RemoteControlScope {
  return value === "all" || value === "lab";
}

/** fork_lab_rc_status's answer, checked; undefined when it is not one. */
export function parseLocalRemoteControl(value: unknown): LocalRemoteControl | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isScope(record.scope) || typeof record.updatedAt !== "number") {
    return undefined;
  }
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const item = entry as Record<string, unknown>;
        return typeof item.account === "string"
          ? [
              {
                account: item.account,
                enabled: item.enabled === true,
                ...(typeof item.dir === "string" && item.dir ? { dir: item.dir } : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    scope: record.scope,
    updatedAt: record.updatedAt,
    by: typeof record.by === "string" ? record.by : "unknown",
    lab: record.lab === true,
    wanted: record.wanted === true,
    accounts,
    changed: typeof record.changed === "boolean" ? record.changed : undefined,
    machine:
      typeof record.machine === "string" && record.machine.trim()
        ? record.machine.trim().slice(0, 80)
        : undefined,
  };
}

export type SyncDecision =
  | { kind: "none" }
  /** This Mac chose later: tell the host. */
  | { kind: "push"; params: LabParams["lab.remoteControl.set"] }
  /** The host has the later choice: apply it here. */
  | { kind: "pull"; choice: RemoteControlChoice };

/** A stamp more than this far past the clock counts as the clock. */
export const FUTURE_SLACK_MS = 5 * 60_000;

function clampStamp(at: number, now: number): number
{
  return at > now + FUTURE_SLACK_MS ? now : at;
}

/** Same scope: nothing to do. Otherwise newest wins, a stamp far in the future
 * counting as now; on a tie the host's choice wins, so both sides settle on one. */
export function decideSync(
  local: RemoteControlChoice,
  host: RemoteControlChoice,
  now = Date.now(),
): SyncDecision {
  if (local.scope === host.scope) {
    return { kind: "none" };
  }
  if (clampStamp(local.updatedAt, now) > clampStamp(host.updatedAt, now)) {
    return { kind: "push", params: { scope: local.scope, updatedAt: local.updatedAt } };
  }
  return { kind: "pull", choice: { scope: host.scope, updatedAt: host.updatedAt, by: host.by } };
}

/** A host's choice to apply here, stamped past this Mac's own stamp, so the
 * vault script (which keeps a later stored choice) takes it even when this
 * Mac's stamp ran ahead of the host's clock. */
export function adoptChoice(choice: RemoteControlChoice, local: RemoteControlChoice): RemoteControlChoice {
  return { scope: choice.scope, updatedAt: Math.max(choice.updatedAt, local.updatedAt + 1), by: choice.by };
}

/** The account folder name the protocol uses, from the script's short name. */
export function accountFolder(account: string): string {
  if (account === "main") {
    return ".claude";
  }
  if (account === "cx") {
    return ".claude-exec";
  }
  return account;
}

/** "main" or "cx", whichever name an account comes under. */
export function accountLabel(account: string): string {
  if (account === ".claude" || account === "main") {
    return "main";
  }
  if (account === ".claude-exec" || account === ".claude-cx" || account === "cx") {
    return "cx";
  }
  return account.replace(/^\./, "");
}

/** Up to 80 characters of the given name, or "Mac". */
export function localMachineName(local: LocalRemoteControl | undefined, fallback = "Mac"): string {
  return (local?.machine ?? fallback).slice(0, 80);
}

/** What lab.report sends after a pass. */
export function buildReport(
  machine: string,
  platform: LabParams["lab.report"]["platform"],
  local: LocalRemoteControl,
): LabParams["lab.report"] {
  const accounts: RemoteControlAccount[] = local.accounts.map((entry) => ({
    account: entry.dir || accountFolder(entry.account),
    enabled: entry.enabled,
  }));
  return {
    machine,
    platform,
    remoteControl: { scope: local.scope, updatedAt: local.updatedAt, by: local.by, accounts },
  };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; "never" for 0. */
export function timeAgo(at: number | null | undefined, now: number): string {
  if (!at) {
    return "never";
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "Chosen by Pixel, 5 min ago", or "Not chosen yet" before anyone did. */
export function choiceLine(choice: RemoteControlChoice, now: number): string {
  if (!choice.updatedAt) {
    return "Not chosen yet, so every machine keeps it on.";
  }
  return `Chosen by ${choice.by || "unknown"}, ${timeAgo(choice.updatedAt, now)}`;
}

/** "main on · cx off", or "No Claude accounts" when there are none. */
export function accountsLine(accounts: { account: string; enabled: boolean }[]): string {
  if (!accounts.length) {
    return "No Claude accounts";
  }
  return accounts
    .map((entry) => `${accountLabel(entry.account)} ${entry.enabled ? "on" : "off"}`)
    .join(" · ");
}

export type MachineRow = {
  key: string;
  name: string;
  detail: string;
  accounts: string;
  /** Some account does not match the scope yet. */
  pending: boolean;
};

/** One row per machine the host knows, this Mac's own status first. */
export function machineRows(
  status: LabStatus,
  local: LocalRemoteControl | undefined,
  localName: string,
  now: number,
): MachineRow[] {
  const desired = status.remoteControl.desired.scope;
  const rows: MachineRow[] = [];
  if (local) {
    const wanted = desired === "all" || local.lab;
    rows.push({
      key: "this-mac",
      name: "This Mac",
      detail: local.lab ? "Lab machine" : "Not a lab machine",
      accounts: accountsLine(local.accounts),
      pending: local.accounts.some((entry) => entry.enabled !== wanted),
    });
  }
  for (const machine of status.remoteControl.machines) {
    if (local && machine.machine === localName) {
      continue;
    }
    const wanted = desired === "all" || machine.lab;
    rows.push({
      key: `m:${machine.machine}`,
      name: machine.machine,
      detail: `${machine.lab ? "Lab machine" : "Not a lab machine"} · reported ${timeAgo(machine.reportedAt, now)}`,
      accounts: accountsLine(machine.accounts),
      pending: machine.accounts.some((entry) => entry.enabled !== wanted),
    });
  }
  return rows;
}

export type UresourcedView = {
  state: string;
  tone: "good" | "warn" | "quiet";
  calls: string | null;
  looping: boolean;
  canTurnOff: boolean;
  canTurnOn: boolean;
  canRestart: boolean;
};

export function uresourcedView(
  status: NonNullable<LabStatus["uresourced"]>,
  now: number,
): UresourcedView {
  let state: string;
  let tone: UresourcedView["tone"] = "quiet";
  if (!status.installed) {
    state = "Not installed";
  } else if (status.masked) {
    state = "Turned off";
  } else if (status.active) {
    state = status.since ? `Running, started ${timeAgo(status.since, now)}` : "Running";
    tone = "good";
  } else {
    state = "Stopped";
  }
  const calls = status.loop
    ? `${formatRate(status.loop.callsPerSecond)} calls a second, ${status.loop.fromUresourced} from uresourced · checked ${timeAgo(status.loop.sampledAt, now)}`
    : null;
  if (status.looping) {
    tone = "warn";
  }
  return {
    state,
    tone,
    calls,
    looping: status.looping,
    canTurnOff: status.installed && !status.masked,
    canTurnOn: status.installed && (status.masked || !status.active),
    canRestart: status.installed && !status.masked,
  };
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export type RemoteDesktopView = {
  state: string;
  on: boolean;
  /** "100.64.0.2:3389" */
  address: string | null;
  username: string;
  fingerprint: string | null;
  warnings: string[];
  notes: string[];
};

export function remoteDesktopView(status: NonNullable<LabStatus["remoteDesktop"]>): RemoteDesktopView {
  const warnings: string[] = [];
  const notes: string[] = [];
  if (status.lanExposed) {
    warnings.push(
      status.via === "kde"
        ? "KDE's own remote desktop is on and reachable from the local network. Turn it off and on here to keep it on Tailscale only."
        : "Remote desktop is reachable from the local network, not only over Tailscale.",
    );
  }
  if (!status.address) {
    warnings.push("Tailscale is down on this machine, so remote desktop can't be reached.");
  }
  if (status.running && !status.systemUser) {
    notes.push("Signing in with the Linux password is off.");
  }
  if (status.running && !status.preauthorized) {
    notes.push("Someone may need to allow screen sharing on the laptop itself.");
  }
  let state: string;
  if (!status.installed) {
    state = "Not installed";
  } else if (!status.running) {
    state = "Off";
  } else if (status.via === "kde") {
    state = "On, run by KDE";
  } else {
    state = "On, Tailscale only";
  }
  return {
    state,
    on: status.running,
    address: status.address ? `${status.address}:${status.port}` : null,
    username: status.username,
    fingerprint: status.certificate.present ? formatFingerprint(status.certificate.sha256) : null,
    warnings,
    notes,
  };
}

/** "AB:CD:…" in pairs, upper case, for comparing with what the RDP app shows. */
export function formatFingerprint(hex: string | null): string | null {
  if (!hex) {
    return null;
  }
  const clean = hex.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return clean.match(/.{1,2}/g)?.join(":") ?? null;
}

export function relayLine(relay: LabStatus["relay"]): string {
  if (!relay.enabled) {
    return "Off";
  }
  const peers = relay.peers.length;
  return `${peers} computer${peers === 1 ? "" : "s"} linked · ${relay.sessions} session${relay.sessions === 1 ? "" : "s"} shared`;
}

/** This Mac's relay line for one host, from fork_relay_status. */
export function localRelayLine(
  local: LocalRelayStatus | undefined,
  machineId: string,
  now: number,
): string | null {
  if (!local) {
    return null;
  }
  const host = local.hosts.find((entry) => entry.machineId === machineId);
  if (!host) {
    return local.enabled ? "This Mac is not linked to it yet." : null;
  }
  if (!host.enabled) {
    return "The relay is off there.";
  }
  if (host.lastError) {
    return `This Mac couldn't reach it: ${host.lastError}`;
  }
  if (!host.connected) {
    return "This Mac is not linked to it right now.";
  }
  return `This Mac is linked, ${host.proxies} session${host.proxies === 1 ? "" : "s"} from elsewhere · synced ${timeAgo(host.lastSyncAt, now)}`;
}

/** fork_relay_status's answer, checked. */
export function parseLocalRelay(value: unknown): LocalRelayStatus | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const hosts = Array.isArray(record.hosts)
    ? record.hosts.flatMap((entry): RelayHostStatus[] => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const item = entry as Record<string, unknown>;
        if (typeof item.machineId !== "string") {
          return [];
        }
        return [
          {
            machineId: item.machineId,
            name: typeof item.name === "string" ? item.name : "",
            connected: item.connected === true,
            proxies: typeof item.proxies === "number" ? item.proxies : 0,
            lastSyncAt: typeof item.lastSyncAt === "number" ? item.lastSyncAt : null,
            lastError: typeof item.lastError === "string" ? item.lastError : null,
            enabled: item.enabled === true,
          },
        ];
      })
    : [];
  return { enabled: record.enabled === true, hosts };
}

/** A failure in plain words. A command the native side lacks reads as this
 * build not having it yet. */
export function errorText(reason: unknown, what = "That"): string {
  const raw =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : reason && typeof reason === "object" && typeof (reason as { error?: unknown }).error === "string"
          ? (reason as { error: string }).error
          : "";
  const text = raw.trim();
  if (/command \S+ not found|unknown command|not allowed|not supported/i.test(text) && /fork_lab|fork_relay/.test(text)) {
    return `${what} needs a newer MonoCode on this Mac.`;
  }
  if (/unknown method/i.test(text)) {
    return `${what} needs a newer host on that machine.`;
  }
  if (/timed? ?out|timeout/i.test(text)) {
    return "The machine took too long to answer.";
  }
  if (!text) {
    return `${what} didn't work.`;
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** One key per kind of failure, so the watcher logs each kind once. */
export function errorKind(step: string, reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return `${step}:${text.replace(/\d+/g, "#").slice(0, 80)}`;
}
