import { afterEach, describe, expect, it, vi } from "vitest";

type Spawn = {
  path: string;
  args: string[];
  account: unknown;
  binaryProvider: unknown;
};

const spawned: Spawn[] = [];
const sent: string[] = [];
let onExit: ((code?: number | null) => void) | undefined;
let onStderr: ((line: string) => void) | undefined;

vi.mock("../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  resolveVivobookBinary: async () => ({ path: "/fake/vivobook-agent" }),
  spawnChild: async (
    _id: string,
    path: string,
    args: string[],
    _cwd: string,
    account: unknown,
    binaryProvider: unknown,
  ) => {
    spawned.push({ path, args, account, binaryProvider });
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    _line: (l: string) => void,
    exit: (code?: number | null) => void,
    stderr?: (line: string) => void,
  ) => {
    onExit = exit;
    onStderr = stderr;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const { __claudeTestReset } = await import(
  "../../integrations/harness/providers/claude/claude"
);
const { vivobookAdapter } = await import("./vivobookAdapter");

function turn(sessionId: string) {
  return vivobookAdapter.sendTurn({
    sessionId,
    cwd: "/repo",
    model: "vivobook:sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    providerAccountId: "work",
    text: "hello",
    attachments: [],
    onEvent: () => undefined,
  });
}

async function until(pred: () => boolean) {
  for (let i = 0; i < 200 && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  __claudeTestReset();
  spawned.length = 0;
  sent.length = 0;
});

describe("vivobook adapter", () => {
  it("launches Claude through the gateway without a local account", async () => {
    const running = turn("vb-1");
    await until(() => spawned.length > 0);
    expect(spawned[0].path).toBe("/fake/vivobook-agent");
    expect(spawned[0].binaryProvider).toBe("vivobook");
    expect(spawned[0].account).toBeUndefined();
    expect(spawned[0].args).toContain("--input-format");
    onExit?.(0);
    await running.catch(() => undefined);
  });

  it("does not open when the gateway gives up", async () => {
    const running = turn("vb-2");
    await until(() => sent.length > 0);
    onStderr?.("ssh: noise that is not shown");
    onStderr?.("Vivobook: not opening: cannot log in to vivobook over SSH");
    onExit?.(3);
    await expect(running).rejects.toThrow(
      "Vivobook: not opening: cannot log in to vivobook over SSH",
    );
  });

  it("fails fast when the gateway exits before it is waited on", async () => {
    const running = turn("vb-3");
    await until(() => spawned.length > 0);
    onStderr?.("Vivobook: only projects under /Users/x can run on the Vivobook");
    onExit?.(2);
    await expect(running).rejects.toThrow("only projects under");
  });

  it("does not resume a conversation that never started remotely", async () => {
    const first = turn("vb-4");
    await until(() => sent.length > 0);
    onStderr?.("Vivobook: not opening: Tailscale did not start");
    onExit?.(3);
    await first.catch(() => undefined);
    const second = turn("vb-4");
    await until(() => spawned.length > 1);
    expect(spawned[1].args).not.toContain("--resume");
    onExit?.(0);
    await second.catch(() => undefined);
  });
});
