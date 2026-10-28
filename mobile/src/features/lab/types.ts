// A copy of src/fork/lab/labProtocol.ts (the phone cannot import from src/):
// the lab types the phone uses. Keep the two in step.

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
export const LAB_CAPABILITY = "lab.v1";

/** The lab methods a phone may call; lab.report is for desktops only. */
export const LAB_PHONE_METHODS = [
  "lab.status",
  "lab.remoteControl.set",
  "lab.relay.set",
  "lab.uresourced.set",
  "lab.remoteDesktop.set",
] as const satisfies readonly LabMethod[];
export type LabPhoneMethod = (typeof LAB_PHONE_METHODS)[number];
