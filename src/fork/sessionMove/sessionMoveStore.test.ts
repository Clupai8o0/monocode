import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => {
  const items = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  return { log: [] as string[], fail: new Set<string>() };
});

vi.mock("react", () => ({ useSyncExternalStore: (_: unknown, get: () => unknown) => get() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (_: string, { op }: { op: string }) => {
    calls.log.push(`mac:${op}`);
    switch (op) {
      case "check":
        return { ok: true, repo: "/r", remoteName: "origin", matchedUrl: "u" };
      case "unpackCode":
        return { repo: "/r", cwd: "/r/.claude/worktrees/moved-s", branch: "moved/s" };
      case "unpackConversation":
        return { account: "main" };
      default:
        return {};
    }
  },
}));
vi.mock("../../features/connections/model/connections", () => ({
  remoteRequest: async (_: string, __: string, { op, inner }: { op: string; inner?: unknown }) => {
    const name = op === "begin" ? (inner as { op: string }).op : op;
    if (op !== "poll") calls.log.push(`lab:${name}`);
    if (calls.fail.has(name)) throw new Error(`${name} failed`);
    switch (op) {
      case "inspect":
        return { repoRoot: "/w", remotes: [{ name: "origin", url: "u" }], hasTranscript: true, account: "main" };
      case "state":
        return { state: "idle" };
      case "stop":
        return { stopped: true };
      case "poll":
        return {
          done: true,
          result: { version: 1, sessionId: "conv", head: "a".repeat(40), sourcePath: "/w", files: [], links: [], ignored: [], ignoredMore: 0 },
        };
      default:
        return {};
    }
  },
}));
vi.mock("../externalSessions/externalSessionsStore", () => ({
  knownLocalProjectPaths: () => [],
  readExternalSession: async () => ({ turns: [] }),
}));
vi.mock("../accounts/accountHomes", () => ({ loadAccountHomes: async () => ({ accounts: [] }) }));
vi.mock("../../integrations/harness/core/registry", () => ({ getHarness: () => undefined }));

import type { ExternalSession } from "../externalSessions/externalSessionsModel";
import { isMoveLocked, isSessionMoved, labKey, moveLabToMac, registerMoveHost, useMoveView, type MoveHost } from "./sessionMoveStore";

let next = 0;

function lab(): ExternalSession {
  next += 1;
  return { id: `conv-${next}`, name: "s", cwd: "/w", source: "claude" } as unknown as ExternalSession;
}

function macHost(saveFails = false): MoveHost {
  return {
    session: () => undefined,
    needsInput: () => false,
    isMono: () => false,
    isOrchestration: () => false,
    openMovedTab: () => {
      calls.log.push("open");
      return `tab-${next}`;
    },
    saveMovedTab: async () => {
      calls.log.push("save");
      if (saveFails) throw new Error("disk full");
    },
    closeMovedTab: async () => void calls.log.push("close"),
    openSession: () => {},
    onMoved: () => {},
  };
}

const settled = (key: string) =>
  vi.waitFor(() => expect(useMoveView(key).view).toBeUndefined(), { timeout: 5_000 });

describe("moving a lab session to this Mac", () => {
  beforeEach(() => {
    calls.log.length = 0;
    calls.fail.clear();
  });

  it("is only moved once the new tab is saved", async () => {
    registerMoveHost(macHost(true));
    const session = lab();
    moveLabToMac(session, "lab");
    await settled(labKey(session.id));
    expect(calls.log).toContain("save");
    expect(isSessionMoved(labKey(session.id))).toBe(false);
    expect(calls.log.indexOf("close")).toBeGreaterThan(calls.log.indexOf("save"));
    expect(calls.log).toContain("lab:restart");
    expect(useMoveView(labKey(session.id)).failure).toContain("disk full");
  });

  it("offers Try again when the lab copy can't be restarted", async () => {
    registerMoveHost(macHost(true));
    calls.fail.add("restart");
    const session = lab();
    const key = labKey(session.id);
    moveLabToMac(session, "lab");
    await settled(key);
    expect(isMoveLocked(key)).toBe(true);
    const { retry } = useMoveView(key);
    expect(retry).toBeDefined();

    calls.fail.clear();
    retry!();
    await vi.waitFor(() => expect(isMoveLocked(key)).toBe(false));
    expect(useMoveView(key).failure).toBeUndefined();
  });
});
