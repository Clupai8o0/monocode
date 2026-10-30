import { describe, expect, it } from "vitest";
import {
  mcpActionText,
  mcpConfig,
  resolveMcpCall,
  type CreatedMcpClient,
  type McpCaller,
} from "./mcpAccess";

const caller = (over: Partial<McpCaller> = {}): McpCaller => ({
  id: "c1",
  name: "codex",
  level: "supervised",
  projects: ["/work/repo", "/work/other"],
  ...over,
});

describe("resolveMcpCall", () => {
  it("pins a call to a project on its list, and takes project out of the input", () => {
    const call = resolveMcpCall(caller(), "sessions.send", {
      project: "/work/repo",
      sessionId: "s1",
      prompt: "hi",
    });
    expect(call.cwd).toBe("/work/repo");
    expect(call.input).toEqual({ sessionId: "s1", prompt: "hi" });
  });

  it("accepts a project's name when only one matches", () => {
    expect(
      resolveMcpCall(caller(), "sessions.list", { project: "other" }).cwd,
    ).toBe("/work/other");
    expect(() =>
      resolveMcpCall(
        caller({ projects: ["/a/repo", "/b/repo"] }),
        "sessions.list",
        { project: "repo" },
      ),
    ).toThrow("can't use repo");
  });

  it("refuses a project off its list, or none at all", () => {
    expect(() =>
      resolveMcpCall(caller(), "sessions.list", { project: "/secret" }),
    ).toThrow("can't use /secret");
    expect(() => resolveMcpCall(caller(), "sessions.list", {})).toThrow(
      "Name a project",
    );
    expect(() =>
      resolveMcpCall(caller(), "sessions.list", { project: 7 }),
    ).toThrow("Name a project");
  });

  it("keeps a read-only client to reading", () => {
    const reader = caller({ level: "read" });
    expect(() =>
      resolveMcpCall(reader, "sessions.read", { project: "/work/repo" }),
    ).not.toThrow();
    for (const action of ["sessions.send", "sessions.start", "sessions.stop"]) {
      expect(() =>
        resolveMcpCall(reader, action, { project: "/work/repo" }),
      ).toThrow("not allowed");
    }
  });

  it("never allows delete, archive or other actions, at any level", () => {
    for (const action of ["sessions.delete", "sessions.archive", "monos.make", "memory.add"]) {
      expect(() =>
        resolveMcpCall(caller({ level: "full" }), action, {
          project: "/work/repo",
        }),
      ).toThrow("not allowed");
    }
  });

  it("gives each level its ceiling on permissions", () => {
    const at = (level: McpCaller["level"]) =>
      resolveMcpCall(caller({ level }), "sessions.list", {
        project: "/work/repo",
      }).runtimeMode;
    expect(at("read")).toBe("supervised");
    expect(at("supervised")).toBe("supervised");
    expect(at("full")).toBe("full-access");
  });
});

describe("mcpConfig", () => {
  const created = {
    client: {},
    token: "mcm_secret",
    command: "/Applications/Mono Code/monocode",
    endpointFile: "/data/fork-mcp-endpoint",
  } as CreatedMcpClient;

  it("writes valid JSON with the command and both settings", () => {
    const parsed = JSON.parse(mcpConfig(created).json);
    expect(parsed.mcpServers.monocode).toEqual({
      command: "/Applications/Mono Code/monocode",
      args: ["mcp"],
      env: {
        MONOCODE_MCP_TOKEN: "mcm_secret",
        MONOCODE_MCP_ENDPOINT_FILE: "/data/fork-mcp-endpoint",
      },
    });
  });

  it("writes Codex's TOML, quoting a path with a space", () => {
    const { toml } = mcpConfig(created);
    expect(toml).toContain("[mcp_servers.monocode]");
    expect(toml).toContain('command = "/Applications/Mono Code/monocode"');
    expect(toml).toContain('MONOCODE_MCP_TOKEN = "mcm_secret"');
  });
});

describe("mcpActionText", () => {
  it("says what happened in plain words", () => {
    expect(mcpActionText("sessions.send")).toBe("messaged a session");
    expect(mcpActionText("sessions.delete")).toBe("tried sessions.delete");
  });
});
