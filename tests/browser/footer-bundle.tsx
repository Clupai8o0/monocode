import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";

// The real footer, with every native call answered here.
// ?theme=light. ?alerts=lab,stacks,memory,high,critical,ring,messages,problems,game
// turns each alert on; without it everything is calm.
const params = new URLSearchParams(location.search);
const alerts = new Set((params.get("alerts") ?? "").split(",").filter(Boolean));
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const vivobook = { id: "m1", name: "vivobook", endpoint: "http://vivobook:7777", environmentId: "env-1" };
const status = {
  version: 1,
  machine: "vivobook",
  platform: "linux",
  remoteControl: { desired: { scope: "all", updatedAt: Date.now() - 3_600_000, by: "Pixel" }, machines: [] },
  relay: { enabled: true, updatedAt: 0, peers: [], sessions: 3 },
  uresourced: { installed: true, active: false, masked: true, pid: null, since: null, loop: null, looping: false },
  remoteDesktop: {
    installed: true,
    running: alerts.has("lab"),
    via: alerts.has("lab") ? "monocode" : null,
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
  timeZone: { zone: "Asia/Kolkata", updatedAt: Date.now() - 60_000, hostZone: "Australia/Melbourne" },
};

const row = (id: string, state: string) => ({ id, projectId: "p", source: "claude", cwd: "/p", state, hasTranscript: true });

function remote(method: string): unknown {
  if (method === "environment.describe") {
    return { capabilities: ["lab.v1"] };
  }
  if (method === "externalSessions.list") {
    return { sessions: [row("a", "running"), row("b", "running"), row("c", "running"), row("d", "idle")] };
  }
  return structuredClone(status);
}

const GB = 1024 ** 3;
const memory = {
  pressure: alerts.has("critical") ? "critical" : alerts.has("memory") ? "warn" : "normal",
  totalBytes: 16 * GB,
  availableBytes: 8 * GB,
  sessions: [{ sessionId: "s1", rssBytes: 1.2 * GB, processCount: 2 }],
};

const stacks = {
  runtime: "docker",
  up: true,
  stacks: [
    { name: "firebase", state: "running", holders: [{ name: "monocode-a1" }], byHand: false },
    ...(alerts.has("stacks") ? [{ name: "postgres", state: "running", holders: [], byHand: true }] : []),
  ],
  devices: [],
  loose: [{ name: "redis-old", status: "Up 3 days", project: null }],
};

function ringStatus() {
  const off = alerts.has("ring");
  return {
    mode: "places",
    ring: !off,
    place: off ? null : "Home",
    reason: off ? "noFix" : "atPlace",
    permission: off ? "denied" : "granted",
    fixAgeSecs: 10,
    accuracy: 20,
    places: [{ name: "Home", address: "1 Main St", radius: 200, distance: 12, located: true }],
    error: null,
  };
}

function messageLog() {
  const at = Date.now() - 60_000;
  return {
    version: 1,
    machine: "mac",
    epoch: "e",
    cursor: 1,
    full: true,
    windowHours: 24,
    scannedAt: Date.now(),
    sessions: [],
    proxies: [],
    events: alerts.has("problems")
      ? Array.from({ length: 120 }, (_, index) => ({
          kind: "send",
          id: `s:${index}`,
          rev: 1,
          at,
          updatedAt: at,
          sessionId: "abcdefgh",
          account: "main",
          to: "ghost",
          toAddress: "name",
          preview: "hello",
          key: `hello${index}`,
          status: "failed",
          error: "Refused: that session is not accepting messages",
        }))
      : [],
  };
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "remote_machines":
        return [vivobook];
      case "remote_request":
        return remote(args.method as string);
      case "fork_lab_rc_status":
      case "fork_lab_rc_apply":
        return { scope: "all", updatedAt: 0, by: "Mac", lab: false, wanted: true, accounts: [], machine: "Mac" };
      case "fork_agent_tz_get":
        return { zone: null, systemZone: "Asia/Kolkata", effectiveZone: "Asia/Kolkata" };
      case "fork_relay_status":
        return { enabled: true, hosts: [] };
      case "fork_stacks_list":
        return stacks;
      case "fork_memory_report":
        return memory;
      case "resource_usage":
        return { cpuPercent: alerts.has("high") ? 95 : 5, memoryPressure: 0 };
      case "resource_processes":
        return [];
      case "fork_location_status":
        return ringStatus();
      case "fork_message_log":
        return messageLog();
      default:
        return null;
    }
  },
};

// The stores read the mock when they load, so import after it.
const { UsageFooter } = await import("../../src/app/shell/UsageFooter");
const { MemoryWatcher } = await import("../../src/fork/memory/MemoryWatcher");
const { ResourcePressureNotice } = await import("../../src/features/notifications/ui/ResourcePressureNotice");
const { setPeerStats } = await import("../../src/fork/peerMessages/peerStats");
const { gamesPanel } = await import("../../src/fork/games/gamesPanelStore");

if (alerts.has("messages")) {
  localStorage.setItem("monocode.fork.peerSeen.installedAt", "0");
  setPeerStats(
    "s1",
    Date.now(),
    {
      incoming: Array.from({ length: 120 }, (_, index) => ({
        name: "monocode-a1",
        at: Date.now() + index,
        body: index === 0 ? "urgent: look at this" : "hello",
        urgent: index === 0,
      })),
      outgoing: [],
    },
    { title: "Fix the login bug", cwd: "/p/monocode" },
  );
}
(window as unknown as Record<string, unknown>).__gamesPanel = gamesPanel;

function Fixture() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const sessions = useRef([]);
  return (
    <div className="flex h-screen flex-col justify-end text-content">
      <UsageFooter providers={[]} onNewTerminal={() => undefined} pressureSlot={setSlot} />
      <ResourcePressureNotice
        sessions={sessions}
        onStopAgent={() => undefined}
        onStopSession={() => undefined}
        chipHost={slot}
      />
      <MemoryWatcher sessions={sessions} isForeground={() => false} chipHost={slot} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
