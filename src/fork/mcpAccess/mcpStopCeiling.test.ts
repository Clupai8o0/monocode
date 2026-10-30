import { describe, expect, it, vi } from "vitest";
import {
  handleAgentApp,
  type AgentAppHost,
} from "../../features/agent-app/model/agentApp";
import type { Session } from "../../features/sessions/model/session";

const session = (over: Partial<Session>) =>
  ({
    id: "s",
    cwd: "/repo",
    harness: "claude",
    model: "opus",
    runtimeMode: "supervised",
    blocks: [],
    ...over,
  }) as Session;

function run(sourceId: string, targetMode: Session["runtimeMode"]) {
  const stop = vi.fn(async () => undefined);
  const target = session({ id: "target", runtimeMode: targetMode });
  const host = {
    sessions: async () => [target],
    session: async () => target,
    isMono: () => false,
    stop,
  } as unknown as AgentAppHost;
  return {
    stop,
    result: handleAgentApp(
      session({ id: sourceId }),
      "req1",
      "sessions.stop",
      { sessionId: "target" },
      host,
    ),
  };
}

describe("stopping a session through MCP", () => {
  it("refuses a supervised client on a full-access session", async () => {
    const { result, stop } = run("mcp-client1", "full-access");
    await expect(result).rejects.toThrow("full-access");
    expect(stop).not.toHaveBeenCalled();
  });

  it("allows it on a session at its own level", async () => {
    const { result, stop } = run("mcp-client1", "supervised");
    await expect(result).resolves.toMatchObject({ stopped: true });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("leaves a normal session's own rule alone", async () => {
    const { result, stop } = run("regular", "full-access");
    await expect(result).resolves.toMatchObject({ stopped: true });
    expect(stop).toHaveBeenCalledOnce();
  });
});
