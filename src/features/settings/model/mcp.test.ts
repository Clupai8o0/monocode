import { describe, expect, it } from "vitest";
import { parseClaudeMcpList, parseCursorMcpList } from "./mcp";

describe("Claude MCP list", () => {
  it("keeps server names and health while omitting launch details", () => {
    expect(
      parseClaudeMcpList(
        "Checking MCP server health...\nnotion: https://example.com/mcp - ! Needs authentication\nlocal_tools: npx tools - --token secret - ✔ Connected\n",
      ),
    ).toEqual([
      { name: "notion", status: "! Needs authentication" },
      { name: "local_tools", status: "✔ Connected" },
    ]);
  });
});

describe("Cursor MCP list", () => {
  it("parses agent mcp list lines", () => {
    expect(
      parseCursorMcpList(
        "filesystem: connected\ngithub: needs authentication\nother: error - unreachable",
      ),
    ).toEqual([
      { name: "filesystem", status: "connected" },
      { name: "github", status: "needs authentication" },
      { name: "other", status: "error - unreachable" },
    ]);
  });

  it("returns empty when no servers are configured", () => {
    expect(
      parseCursorMcpList(
        "No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)",
      ),
    ).toEqual([]);
  });
});
