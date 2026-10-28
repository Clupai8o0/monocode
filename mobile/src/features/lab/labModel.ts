import type {
  LabParams,
  LabPhoneMethod,
  LabStatus,
  RemoteControlAccount,
  RemoteControlScope,
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

/** Asks the host one of the phone's lab methods; every one answers a LabStatus. */
export async function callLab<M extends LabPhoneMethod>(
  command: <T>(method: string, params?: object) => Promise<T>,
  method: M,
  params: LabParams[M],
): Promise<LabStatus> {
  if (!(LAB_PHONE_METHODS as readonly string[]).includes(method)) {
    throw new Error("Not a phone lab method");
  }
  const status = await command<LabStatus>(method, params);
  if (!isLabStatus(status)) throw new Error("The host sent no lab status");
  return status;
}

export function isLabStatus(value: unknown): value is LabStatus {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.machine === "string" &&
    !!record.remoteControl &&
    !!record.relay
  );
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
    .map((item) => `${accountName(item.account)} ${item.enabled ? "on" : "off"}`)
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
  const machines = peers.length === 1 ? "1 machine" : `${peers.length} machines`;
  const count = sessions === 1 ? "1 session" : `${sessions} sessions`;
  return `${machines} linked, ${count}`;
}

/** uresourced's state in a word or two. */
export function uresourcedState(value: UresourcedStatus): string {
  if (!value.installed) return "Not installed";
  if (value.masked) return "Off";
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

/** What to try opening, in order: the app's link, then the store. */
export function rdpOpenUrls(uri: string | null): string[] {
  return uri ? [uri, ...RDP_STORE_URLS] : [...RDP_STORE_URLS];
}

/** A fingerprint split into pairs of hex digits, easier to compare by eye. */
export function fingerprintText(sha256: string): string {
  const hex = sha256.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.match(/.{1,2}/g)?.join(":") ?? sha256;
}
