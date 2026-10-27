import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";
import { HostChildBackend } from "./child-backend";
import { configureChildBackend } from "../src/integrations/harness/core/child";
import type { SendTurnInput } from "../src/integrations/harness/core/types";

vi.mock("../src/integrations/harness/providers/codex/codexCatalog", () => ({
  discoverCodexModels: vi.fn(),
}));
configureChildBackend(new HostChildBackend({}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-mobile-test-"));
  const store = new HostStore(join(directory, "host.db"));
  const turns: Array<{ input: SendTurnInput; finish: () => void }> = [];
  const approve = vi.fn();
  const engine = new HostEngine(store, {
    codex: {
      send: (input) =>
        new Promise<void>((resolve) => {
          turns.push({ input, finish: resolve });
        }),
      stop: async () => turns.at(-1)?.finish(),
      cancel: async () => turns.at(-1)?.finish(),
      bind: () => {},
      approve,
      answer: () => {},
    },
  });
  const project = await engine.openProject(directory);
  const server = createHostServer(engine, ["codex"]);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mobile`;
  const device = store.issueDevice("Phone");
  let next = 0;
  const call = async (
    method: string,
    params: object = {},
    headers: Record<string, string> = { Authorization: `Bearer ${device.token}` },
  ) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, id: `c${next++}`, method, params }),
    });
    const body = response.ok ? await response.json() : null;
    return { status: response.status, ...(body as { ok?: boolean; result?: any; error?: string }) };
  };
  cleanups.push(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { call, project, turns, approve, device };
}

describe("phone endpoint", () => {
  it("refuses calls without the device credential or from a browser", async () => {
    const { call, device } = await setup();
    expect((await call("workspace.list", {}, {})).status).not.toBe(200);
    expect(
      (await call("workspace.list", {}, { Authorization: "Bearer nope" })).status,
    ).not.toBe(200);
    expect(
      (
        await call("workspace.list", {}, {
          Authorization: `Bearer ${device.token}`,
          Origin: "https://example.com",
        })
      ).status,
    ).not.toBe(200);
  });

  it("starts a session, shows its approval, and passes the decision on", async () => {
    const { call, project, turns, approve } = await setup();
    const listed = await call("workspace.list");
    expect(listed.ok).toBe(true);
    expect(listed.result.projects.map((item: { id: string }) => item.id)).toEqual([
      project.id,
    ]);
    const started = await call("session.start", {
      projectId: project.id,
      text: "Fix the build\nthen test",
      model: "codex:test",
    });
    expect(started.error).toBeUndefined();
    const sessionId = started.result.sessionId as string;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0].input.onEvent({
      type: "approval.requested",
      requestId: 7,
      title: "Run a command?",
    });
    await vi.waitFor(async () => {
      const session = (await call("workspace.list")).result.sessions.find(
        (item: { id: string }) => item.id === sessionId,
      );
      expect(session).toMatchObject({
        title: "Fix the build",
        busy: true,
        waiting: "approval",
        approval: { requestId: 7 },
      });
    });
    const decided = await call("session.approve", {
      conversationId: sessionId,
      requestId: 7,
      decision: "allow",
    });
    expect(decided.ok).toBe(true);
    expect(approve).toHaveBeenCalledWith(sessionId, 7, "allow");

    const watch = await call("conversation.watch", { conversationId: sessionId });
    turns[0].finish();
    await vi.waitFor(async () => {
      const frames = await call("watch.next", {
        watchId: watch.result.watchId,
        timeoutMs: 500,
      });
      expect(frames.ok).toBe(true);
      expect(frames.result.updates.at(-1)?.busy).toBe(false);
    });
    expect((await call("watch.close", { watchId: watch.result.watchId })).ok).toBe(true);
  });

  it("answers unknown methods and missing sessions as failures, not crashes", async () => {
    const { call } = await setup();
    expect(await call("files.read")).toMatchObject({ status: 200, ok: false });
    expect(
      await call("conversation.send", { conversationId: "missing", text: "hi" }),
    ).toMatchObject({ status: 200, ok: false });
  });
});
