import { invoke } from "@tauri-apps/api/core";
import type { RuntimeMode } from "../../features/sessions/model/session";
import { pathKey, projectName } from "../../shared/lib/paths";

/** Fork: which outside agents can reach MonoCode, and what they've done. */
export type McpLevel = "read" | "supervised" | "full";

export type McpCaller = {
  id: string;
  name: string;
  level: McpLevel;
  projects: string[];
};

export type McpClient = McpCaller & { tokenHash: string; createdAt: number };

export type McpLogEntry = {
  at: number;
  client: string;
  action: string;
  target: string | null;
  ok: boolean;
  error: string | null;
};

export type CreatedMcpClient = {
  client: McpClient;
  token: string;
  command: string;
  endpointFile: string;
};

export const MCP_LEVELS: readonly { id: McpLevel; label: string; note: string }[] = [
  { id: "read", label: "Read only", note: "List sessions and read them." },
  {
    id: "supervised",
    label: "Supervised",
    note: "Also start, message and stop sessions that ask before acting, and use emulators.",
  },
  {
    id: "full",
    label: "Full access",
    note: "Also sessions that run without asking. Only for agents you trust.",
  },
];

const READ_ACTIONS = ["sessions.list", "sessions.read"];
const ACT_ACTIONS = ["sessions.start", "sessions.send", "sessions.stop"];

/**
 * Checks a call again on this side and pins it to one project. The app's action
 * code treats a session's folder as the only project it may touch, so a caller
 * gets a session in the project it named, if that's on its list.
 */
export function resolveMcpCall(
  caller: McpCaller,
  action: string,
  input: Record<string, unknown>,
): { cwd: string; runtimeMode: RuntimeMode; input: Record<string, unknown> } {
  const allowed =
    READ_ACTIONS.includes(action) ||
    (caller.level !== "read" && ACT_ACTIONS.includes(action));
  if (!allowed) {
    throw new Error(`${action} is not allowed for ${caller.name}`);
  }
  const { project, ...rest } = input;
  if (typeof project !== "string" || !project) {
    throw new Error(
      `Name a project. ${caller.name} can use: ${caller.projects.join(", ")}`,
    );
  }
  const byPath = caller.projects.find(
    (path) => pathKey(path) === pathKey(project),
  );
  const byName = caller.projects.filter(
    (path) => projectName(path) === project,
  );
  const cwd = byPath ?? (byName.length === 1 ? byName[0] : undefined);
  if (!cwd) {
    throw new Error(
      `${caller.name} can't use ${project}. It can use: ${caller.projects.join(", ")}`,
    );
  }
  return {
    cwd,
    runtimeMode: caller.level === "full" ? "full-access" : "supervised",
    input: rest,
  };
}

export const loadMcpClients = () => invoke<McpClient[]>("fork_mcp_clients");
export const loadMcpLog = () => invoke<McpLogEntry[]>("fork_mcp_log");
export const revokeMcpClient = (id: string) =>
  invoke<void>("fork_mcp_revoke_client", { id });
export const createMcpClient = (
  name: string,
  level: McpLevel,
  projects: string[],
) =>
  invoke<CreatedMcpClient>("fork_mcp_create_client", { name, level, projects });

/** What to paste into the agent's config; the token is only shown this once. */
export function mcpConfig(created: CreatedMcpClient) {
  const env = {
    MONOCODE_MCP_TOKEN: created.token,
    MONOCODE_MCP_ENDPOINT_FILE: created.endpointFile,
  };
  return {
    json: JSON.stringify(
      {
        mcpServers: {
          monocode: { command: created.command, args: ["mcp"], env },
        },
      },
      null,
      2,
    ),
    toml: [
      "[mcp_servers.monocode]",
      `command = ${JSON.stringify(created.command)}`,
      'args = ["mcp"]',
      `env = { MONOCODE_MCP_TOKEN = ${JSON.stringify(env.MONOCODE_MCP_TOKEN)}, MONOCODE_MCP_ENDPOINT_FILE = ${JSON.stringify(env.MONOCODE_MCP_ENDPOINT_FILE)} }`,
    ].join("\n"),
  };
}

const ACTION_WORDS: Record<string, string> = {
  "sessions.list": "listed sessions",
  "sessions.read": "read a session",
  "sessions.start": "started a session",
  "sessions.send": "messaged a session",
  "sessions.stop": "stopped a session",
  "device.list": "listed devices",
  "device.screenshot": "looked at a device",
  "device.tap": "tapped a device",
  "device.swipe": "swiped a device",
  "device.type": "typed on a device",
};

export const mcpActionText = (action: string) =>
  ACTION_WORDS[action] ?? `tried ${action}`;
