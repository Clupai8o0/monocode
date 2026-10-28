import type { HostStore } from "./store";
import type { RelayStatus } from "../src/fork/lab/labProtocol";

export type RelayMethod = "relay.sync" | "relay.send" | "relay.next";

export type HostRelayOptions = { dataDir: string; store: HostStore };

/**
 * Lets Claude sessions on different machines and accounts message each
 * other: each session elsewhere gets a proxy socket and registry entry here,
 * and paired desktops do the same on their side through relay.*.
 */
export class HostRelay {
  constructor(readonly options: HostRelayOptions) {}

  /** Loads the saved switch, clears copies an earlier run left, and starts
   *  when the relay is on. */
  async start(): Promise<void> {}

  status(): RelayStatus {
    return { enabled: false, updatedAt: 0, peers: [], sessions: 0 };
  }

  async setEnabled(enabled: boolean): Promise<RelayStatus> {
    void enabled;
    throw new Error("The relay is not built yet");
  }

  async handle(
    method: RelayMethod,
    params: Record<string, unknown>,
    device: { id: string; name: string } | null,
  ): Promise<unknown> {
    void method;
    void params;
    void device;
    throw new Error("The relay is not built yet");
  }

  /** Closes every proxy and removes the copies it wrote. */
  async close(): Promise<void> {}
}

let active: HostRelay | undefined;

/** The host's relay, made on first use. */
export function hostRelay(options: HostRelayOptions): HostRelay {
  if (!active || active.options.dataDir !== options.dataDir) {
    active = new HostRelay(options);
  }
  return active;
}
