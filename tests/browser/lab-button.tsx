import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";

// One paired lab host, the vivobook: Remote Control on every machine, relay
// on, uresourced masked, remote desktop off. Every native call is answered
// here, and changes stick, so the popover can be clicked through.
const vivobook = { id: "m1", name: "vivobook", endpoint: "http://vivobook:7777", environmentId: "env-1" };
const status = {
  version: 1,
  machine: "vivobook",
  platform: "linux",
  remoteControl: {
    desired: { scope: "all", updatedAt: Date.now() - 3_600_000, by: "Pixel" },
    machines: [],
  },
  relay: { enabled: true, updatedAt: 0, peers: [], sessions: 3 },
  uresourced: {
    installed: true,
    active: false,
    masked: true,
    pid: null,
    since: null,
    loop: null,
    looping: false,
  },
  remoteDesktop: {
    installed: true,
    running: false,
    via: null,
    lanExposed: false,
    address: "100.101.12.7",
    port: 3389,
    username: "clupai",
    certificate: { present: true, sha256: "aabbccdd" },
    systemUser: true,
    preauthorized: true,
    rdpFile: null,
    uri: null,
  },
};

function answer(method: string, params: Record<string, unknown>): unknown {
  if (method === "environment.describe") {
    return { capabilities: ["lab.v1", "lab.tz.v1"] };
  }
  if (method === "lab.remoteControl.set") {
    status.remoteControl.desired = { scope: params.scope as string, updatedAt: Date.now(), by: "Mac" };
  } else if (method === "lab.relay.set") {
    status.relay.enabled = params.enabled as boolean;
  } else if (method === "lab.remoteDesktop.set") {
    status.remoteDesktop.running = params.enabled as boolean;
    status.remoteDesktop.via = params.enabled ? "monocode" : null;
  }
  return structuredClone(status);
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "remote_machines") {
      return [vivobook];
    }
    if (command === "remote_request") {
      return answer(args.method as string, (args.params ?? {}) as Record<string, unknown>);
    }
    if (command === "fork_lab_rc_status" || command === "fork_lab_rc_apply") {
      return {
        scope: (args.scope as string) ?? status.remoteControl.desired.scope,
        updatedAt: (args.updatedAt as number) ?? 0,
        by: "Mac",
        lab: false,
        wanted: true,
        accounts: [],
        machine: "Mac",
      };
    }
    if (command === "fork_relay_status") {
      return { enabled: true, hosts: [{ machineId: "m1", name: "vivobook", connected: true, proxies: 2, lastSyncAt: Date.now(), lastError: null, enabled: true }] };
    }
    return null;
  },
};

if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

// The store and the button read the mock when they load, so import after it.
const { LabButton } = await import("../../src/fork/lab/LabButton");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex h-screen flex-col justify-end text-content">
      <footer className="flex h-7 shrink-0 items-center gap-1.5 px-3 text-[11px] text-content/55">
        <span>Claude · 42%</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LabButton />
          <span className="px-1.5">Stacks · 2 up</span>
        </div>
      </footer>
    </div>
  </StrictMode>,
);
