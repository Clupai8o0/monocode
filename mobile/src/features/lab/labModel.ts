import type {
  LabParams,
  LabPhoneMethod,
  LabStatus,
  RemoteControlAccount,
  RemoteControlScope,
  RemoteDesktopStatus,
  UresourcedStatus,
} from "./types";
import { LAB_PHONE_METHODS } from "./types";

/** Microsoft's Remote Desktop app, for when the rdp:// link opens nothing. */
export const RDP_STORE_URLS = [
  "market://details?id=com.microsoft.rdc.androidx",
  "https://play.google.com/store/apps/details?id=com.microsoft.rdc.androidx",
];

export const SCOPE_CHOICES: { scope: RemoteControlScope; label: string }[] = [
  { scope: "all", label: "Every machine" },
  { scope: "lab", label: "Only lab machines" },
];

/** The host may take up to 40 s for these; the phone waits 60 s. */
export const LAB_SLOW_TIMEOUT_MS = 60_000;

/** How long to wait for a lab call; undefined keeps the default. */
export function labTimeout<M extends LabPhoneMethod>(
  method: M,
  params: LabParams[M],
): number | undefined {
  if (method === "lab.uresourced.set" || method === "lab.remoteDesktop.set") {
    return LAB_SLOW_TIMEOUT_MS;
  }
  if (method === "lab.status" && (params as LabParams["lab.status"]).probe) {
    return LAB_SLOW_TIMEOUT_MS;
  }
  return undefined;
}

export type LabCommand = <T>(
  method: string,
  params?: object,
  id?: string,
  timeoutMs?: number,
) => Promise<T>;

/** Asks the host one of the phone's lab methods; every one answers a LabStatus. */
export async function callLab<M extends LabPhoneMethod>(
  command: LabCommand,
  method: M,
  params: LabParams[M],
): Promise<LabStatus> {
  if (!(LAB_PHONE_METHODS as readonly string[]).includes(method)) {
    throw new Error("Not a phone lab method");
  }
  const status = await command<LabStatus>(
    method,
    params,
    undefined,
    labTimeout(method, params),
  );
  if (!isLabStatus(status)) throw new Error("The host sent no lab status");
  return status;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUresourced(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const loop = value.loop;
  return (
    typeof value.installed === "boolean" &&
    typeof value.active === "boolean" &&
    typeof value.masked === "boolean" &&
    typeof value.looping === "boolean" &&
    (value.since === null || typeof value.since === "number") &&
    (loop === null ||
      (isObject(loop) &&
        typeof loop.callsPerSecond === "number" &&
        typeof loop.fromUresourced === "number"))
  );
}

function isRemoteDesktop(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const certificate = value.certificate;
  return (
    typeof value.installed === "boolean" &&
    typeof value.running === "boolean" &&
    typeof value.lanExposed === "boolean" &&
    (value.address === null || typeof value.address === "string") &&
    typeof value.port === "number" &&
    typeof value.username === "string" &&
    isObject(certificate) &&
    (certificate.sha256 === null || typeof certificate.sha256 === "string")
  );
}

/** Checks every field the lab page reads, so a malformed answer can't crash it. */
export function isLabStatus(value: unknown): value is LabStatus {
  if (!isObject(value)) return false;
  const remoteControl = value.remoteControl;
  const relay = value.relay;
  if (value.version !== 1 || typeof value.machine !== "string") return false;
  if (!isObject(remoteControl) || !isObject(relay)) return false;
  const desired = remoteControl.desired;
  if (
    !isObject(desired) ||
    (desired.scope !== "all" && desired.scope !== "lab") ||
    typeof desired.updatedAt !== "number" ||
    typeof desired.by !== "string" ||
    !Array.isArray(remoteControl.machines) ||
    !remoteControl.machines.every(
      (machine) =>
        isObject(machine) &&
        typeof machine.machine === "string" &&
        typeof machine.lab === "boolean" &&
        typeof machine.reportedAt === "number" &&
        Array.isArray(machine.accounts) &&
        machine.accounts.every(
          (item) =>
            isObject(item) &&
            typeof item.account === "string" &&
            typeof item.enabled === "boolean",
        ),
    )
  ) {
    return false;
  }
  if (
    typeof relay.enabled !== "boolean" ||
    !Array.isArray(relay.peers) ||
    !relay.peers.every(
      (peer) =>
        isObject(peer) &&
        typeof peer.id === "string" &&
        typeof peer.name === "string" &&
        typeof peer.sessions === "number" &&
        typeof peer.lastSeen === "number",
    ) ||
    typeof relay.sessions !== "number"
  ) {
    return false;
  }
  return isUresourced(value.uresourced) && isRemoteDesktop(value.remoteDesktop);
}

/** The stamp for a scope click: after the host's choice even if the phone's clock is behind. */
export function scopeStamp(
  status: LabStatus,
  now: number = Date.now(),
): number {
  return Math.max(now, status.remoteControl.desired.updatedAt + 1);
}

/** Which uresourced buttons to show. */
export function uresourcedActions(value: UresourcedStatus): {
  on: boolean;
  off: boolean;
  restart: boolean;
} {
  return {
    on: value.masked || !value.active,
    off: !value.masked,
    restart: value.active && !value.masked,
  };
}

/** The host's own words for a failed call. */
export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** "main" for ~/.claude, "cx" for ~/.claude-exec (or ~/.claude-cx). */
export function accountName(account: string): string {
  const folder = account.replace(/^.*\//, "");
  if (folder === ".claude") return "main";
  if (folder === ".claude-exec" || folder === ".claude-cx") return "cx";
  return folder.replace(/^\./, "");
}

/** "main on, cx off"; "No accounts" when there are none. */
export function accountsLine(accounts: RemoteControlAccount[]): string {
  if (accounts.length === 0) return "No accounts";
  return accounts
    .map(
      (item) => `${accountName(item.account)} ${item.enabled ? "on" : "off"}`,
    )
    .join(", ");
}

/** A short "how long ago": "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now: number = Date.now()): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Who chose the scope, and when. */
export function choiceLine(
  status: LabStatus,
  now: number = Date.now(),
): string {
  const { by, updatedAt } = status.remoteControl.desired;
  if (!updatedAt) return "Not chosen yet, so every machine";
  return `Chosen by ${by || "unknown"}, ${ago(updatedAt, now)}`;
}

export function relayLine(status: LabStatus): string {
  const { peers, sessions } = status.relay;
  const machines =
    peers.length === 1 ? "1 machine" : `${peers.length} machines`;
  const count = sessions === 1 ? "1 session" : `${sessions} sessions`;
  return `${machines} linked, ${count}`;
}

/** uresourced's state in a word or two. */
export function uresourcedState(value: UresourcedStatus): string {
  if (!value.installed) return "Not installed";
  if (value.masked) return value.active ? "Masked, still running" : "Off";
  if (value.active) return value.looping ? "On, looping" : "On";
  return "Stopped";
}

export function callsLine(value: UresourcedStatus): string | null {
  if (!value.loop) return null;
  const rate = Math.round(value.loop.callsPerSecond * 10) / 10;
  return `${rate} calls/s, ${value.loop.fromUresourced} from uresourced`;
}

/** The address to type into a Remote Desktop app. */
export function rdpAddress(status: LabStatus): string | null {
  const desktop = status.remoteDesktop;
  if (!desktop?.address) return null;
  return desktop.port === 3389
    ? desktop.address
    : `${desktop.address}:${desktop.port}`;
}

/** True for an IPv4 address in Tailscale's 100.64.0.0/10. */
export function isTailscaleIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const bytes = parts.map((part) =>
    /^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN,
  );
  if (bytes.some((byte) => !(byte >= 0 && byte <= 255))) return false;
  return bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127;
}

/**
 * The rdp:// link, built on the phone from the address, port and username
 * (never the host's own uri); null when any of them looks wrong.
 */
export function rdpLink(desktop: RemoteDesktopStatus): string | null {
  const { address, port, username } = desktop;
  if (!address || !isTailscaleIpv4(address)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(username)) return null;
  return `rdp://full%20address=s:${address}:${port}&username=s:${encodeURIComponent(username)}`;
}

/** What to try opening, in order: the app's link, then the store. */
export function rdpOpenUrls(uri: string | null): string[] {
  return uri ? [uri, ...RDP_STORE_URLS] : [...RDP_STORE_URLS];
}

/** A fingerprint split into pairs of hex digits, easier to compare by eye. */
export function fingerprintText(sha256: string): string {
  const hex = sha256.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.match(/.{1,2}/g)?.join(":") ?? sha256;
}
