import type { HostStore } from "./store";
import type { LabMethod, LabStatus } from "../src/fork/lab/labProtocol";

export type LabCaller = {
  /** The device whose credential made the call; null once revoked. */
  device: { id: string; name: string } | null;
  surface: "rpc" | "mobile";
};

export type HostLabOptions = { dataDir: string; store: HostStore };

/**
 * Home lab controls: where Remote Control starts, the relay's switch,
 * uresourced and remote desktop. Every method answers the whole LabStatus.
 */
export class HostLab {
  constructor(readonly options: HostLabOptions) {}

  async handle(
    method: LabMethod,
    params: Record<string, unknown>,
    caller: LabCaller,
  ): Promise<LabStatus> {
    void method;
    void params;
    void caller;
    throw new Error("Home lab controls are not built yet");
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
