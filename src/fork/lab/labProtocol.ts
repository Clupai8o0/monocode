/**
 * Home lab controls, one protocol for the host, the desktop and the phone
 * (the phone keeps a copy in mobile/src/features/lab/types.ts).
 *
 * The host answers the lab.* methods on /rpc (desktop) and /mobile (phone),
 * except lab.report, which only desktops send. The relay.* methods are /rpc
 * only and are called by the desktop's Rust relay, never by the UI.
 */

export const LAB_CAPABILITY = "lab.v1";
export const RELAY_CAPABILITY = "relay.v1";

/** Where Claude sessions start with Remote Control on: every machine, or
 *  only lab machines (Linux), which keep it on in both scopes. */
export type RemoteControlScope = "all" | "lab";

export type RemoteControlChoice = {
  scope: RemoteControlScope;
  /** When it was chosen, ms since epoch; between machines the newest wins. */
  updatedAt: number;
  /** Who chose it: a paired device's name, or a machine's. */
  by: string;
};

/** What one Claude account folder's settings say now. */
export type RemoteControlAccount = {
  /** The folder's name in the home folder: ".claude" or ".claude-exec". */
  account: string;
  /** remoteControlAtStartup; false when the file or the key is missing. */
  enabled: boolean;
};

/** One machine's Remote Control, as it last reported. */
export type RemoteControlMachine = {
  machine: string;
  /** Lab machines (Linux) keep Remote Control on in both scopes. */
  lab: boolean;
  /** The scope it last applied. */
  scope: RemoteControlScope;
  accounts: RemoteControlAccount[];
  /** When it reported, ms since epoch. */
  reportedAt: number;
};

/** A paired computer taking part in the relay. */
export type RelayPeer = {
  /** The paired device's id, never its credential. */
  id: string;
  name: string;
  /** Sessions it offers now. */
  sessions: number;
  /** Its last sync, ms since epoch. */
  lastSeen: number;
};

export type RelayStatus = {
  enabled: boolean;
  /** When it was last turned on or off, ms since epoch; 0 if never. */
  updatedAt: number;
  peers: RelayPeer[];
  /** Sessions offered across every machine, the host's own included. */
  sessions: number;
};

export type UresourcedStatus = {
  installed: boolean;
  active: boolean;
  masked: boolean;
  pid: number | null;
  /** When it last started, ms since epoch. */
  since: number | null;
  /** Calls to systemd's SetUnitProperties, from a 2 s look at the user
   *  bus; null before the first look. */
  loop: {
    callsPerSecond: number;
    /** How many of those calls uresourced made. */
    fromUresourced: number;
    sampledAt: number;
  } | null;
  /** From 20 calls a second: it is fighting systemd over a setting. */
  looping: boolean;
};

export type RemoteDesktopStatus = {
  /** krdpserver is installed. */
  installed: boolean;
  running: boolean;
  /** Who runs it: MonoCode's Tailscale-only unit, or KDE's own, which
   *  listens on every network. */
  via: "monocode" | "kde" | null;
  /** Reachable from the local network too, not only over Tailscale. */
  lanExposed: boolean;
  /** The Tailscale address to connect to; null when Tailscale is down. */
  address: string | null;
  port: number;
  /** The Linux user to sign in as, with that user's own password. */
  username: string;
  certificate: { present: boolean; sha256: string | null };
  /** Sign-in with the Linux user's own password is on. */
  systemUser: boolean;
  /** Sharing the screen needs no click on the laptop itself. */
  preauthorized: boolean;
  /** A .rdp file (CRLF lines) for desktop apps; null without an address. */
  rdpFile: string | null;
  /** An rdp:// link for Microsoft's Remote Desktop app; null without an
   *  address. */
  uri: string | null;
};

export type LabStatus = {
  version: 1;
  /** The host machine's name. */
  machine: string;
  platform: "linux" | "darwin" | "win32";
  remoteControl: {
    desired: RemoteControlChoice;
    machines: RemoteControlMachine[];
  };
  relay: RelayStatus;
  /** Linux only; null elsewhere. */
  uresourced: UresourcedStatus | null;
  /** Linux only; null elsewhere. */
  remoteDesktop: RemoteDesktopStatus | null;
};

/** Params of each lab method; every one of them answers a LabStatus. */
export type LabParams = {
  /** probe: also take a fresh 2 s look at uresourced on the bus. */
  "lab.status": { probe?: boolean };
  /** Newest wins: an updatedAt older than the host's choice changes nothing.
   *  Without one, the host's clock stamps it. */
  "lab.remoteControl.set": { scope: RemoteControlScope; updatedAt?: number };
  "lab.relay.set": { enabled: boolean };
  /** Linux only. off: stop and mask; on: unmask and start; restart. */
  "lab.uresourced.set": { action: "off" | "on" | "restart" };
  /** Linux only. On binds krdpserver to the Tailscale address only. */
  "lab.remoteDesktop.set": { enabled: boolean };
  /** Desktops only (/rpc): what this machine applied. */
  "lab.report": {
    machine: string;
    platform: "linux" | "darwin" | "win32";
    remoteControl: RemoteControlChoice & { accounts: RemoteControlAccount[] };
  };
};

export type LabMethod = keyof LabParams;
export const LAB_METHODS = [
  "lab.status",
  "lab.remoteControl.set",
  "lab.relay.set",
  "lab.uresourced.set",
  "lab.remoteDesktop.set",
  "lab.report",
] as const satisfies readonly LabMethod[];
/** The lab methods a phone may call. */
export const LAB_PHONE_METHODS = LAB_METHODS.filter(
  (method) => method !== "lab.report",
);

/** A Claude session a machine offers to the others. */
export type RelaySession = {
  sessionId: string;
  /** The account folder whose registry holds it: ".claude" or ".claude-exec". */
  account: string;
  name: string;
  cwd: string;
  kind?: string;
  status?: string;
  /** Its Remote Control id, so a Remote Control row folds into the relayed one. */
  bridgeSessionId?: string;
  /** Its Claude version; the copy on the other machine uses "relay" without it. */
  version?: string;
};

/** A registry entry the host builds for a session elsewhere; the receiving
 *  machine writes it as <pid>.json into every account's sessions folder and
 *  listens on its messagingSocketPath. Field names are Claude Code's own. */
export type RelayRegistryEntry = {
  /** 1e9 and up: above any real pid, so no live process can own it. */
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  version: string;
  peerProtocol: 1;
  peerFeatures: string[];
  kind: string;
  entrypoint: "relay";
  /** "relay:<machine>": a foreign domain, so Claude neither checks nor
   *  cleans up the pid. */
  pidDomain: string;
  /** <the receiving machine's socket folder>/<pid>.sock */
  messagingSocketPath: string;
  name: string;
  nameSource: "derived";
  status: string;
  updatedAt: number;
  statusUpdatedAt: number;
  bridgeSessionId?: string;
  /** Marks relay copies; every reader of the session folders skips them. */
  monocodeRelay: { machine: string; account: string; remoteSessionId: string };
};

export type RelaySyncParams = {
  /** The caller's name, as other machines see it. */
  machine: string;
  /** The caller's Claude socket folder, e.g. /tmp/cc-socks on a Mac. */
  sockDir: string;
  /** Its own live sessions, never relay copies. */
  sessions: RelaySession[];
};

export type RelaySyncResult = {
  enabled: boolean;
  /** One per session on other machines; empty when the relay is off. */
  entries: RelayRegistryEntry[];
  /** When to sync again. */
  nextSyncMs: number;
};

export type RelaySendParams = {
  /** The caller's session that wrote the line. */
  from: string;
  /** The pid of the caller's proxy it wrote to. */
  to: number;
  /** One NDJSON line as written, without its newline. */
  line: string;
};

export type RelaySendResult = { accepted: boolean; reason?: string };

export type RelayNextParams = { cursor: number; waitMs?: number };

export type RelayDelivery = {
  /** The caller's session to write the line to. */
  to: string;
  /** The pid of the caller's proxy the line comes from; the caller listens on
   *  it before delivering, so replies and receipts come back. */
  fromPid: number;
  /** The line to write, its sender already rewritten to that proxy. */
  line: string;
};

export type RelayNextResult = {
  cursor: number;
  deliveries: RelayDelivery[];
  enabled: boolean;
};

/** Whether a session registry entry is a relay copy, which readers skip. */
export function isRelayEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return (
    record.monocodeRelay !== undefined ||
    (typeof record.pidDomain === "string" &&
      record.pidDomain.startsWith("relay:"))
  );
}
