import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExternalUnsupported,
  isMarkedUnsupported,
  isUnsupportedError,
  listExternalSessions,
  markUnsupported,
  metaParts,
  readExternalSession,
  resetUnsupported,
  sessionTitle,
  sourceLabel,
  stateLabel,
  UNSUPPORTED_MS,
} from "@/features/sessions/externalSessions";
import type { ExternalSession } from "@/features/workspace/types";

const session = (fields: Partial<ExternalSession> = {}): ExternalSession => ({
  id: "abcdef12-3456",
  projectId: "p",
  source: "claude",
  cwd: "/repo",
  state: "running",
  hasTranscript: true,
  ...fields,
});

beforeEach(() => resetUnsupported());

describe("unsupported memo", () => {
  it("recognises older desktops' and hosts' errors", () => {
    expect(isUnsupportedError(new Error("Unsupported mobile operation"))).toBe(true);
    expect(isUnsupportedError(new Error("Not available on this machine yet"))).toBe(true);
    expect(isUnsupportedError(new Error("Unknown method"))).toBe(true);
    expect(isUnsupportedError(new Error("Session not found"))).toBe(false);
    expect(isUnsupportedError(new Error("Network request failed"))).toBe(false);
  });

  it("remembers a connection for five minutes", () => {
    markUnsupported("a", 1000);
    expect(isMarkedUnsupported("a", 1000 + UNSUPPORTED_MS - 1)).toBe(true);
    expect(isMarkedUnsupported("b", 1000)).toBe(false);
    expect(isMarkedUnsupported("a", 1000 + UNSUPPORTED_MS)).toBe(false);
  });

  it("stops asking once a connection says no", async () => {
    const command = vi.fn(async () => {
      throw new Error("Unsupported mobile operation");
    });
    await expect(listExternalSessions(command, "a", "p")).rejects.toBeInstanceOf(
      ExternalUnsupported,
    );
    await expect(listExternalSessions(command, "a", "p")).rejects.toBeInstanceOf(
      ExternalUnsupported,
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("passes other errors through without remembering", async () => {
    const command = vi.fn(async () => {
      throw new Error("timeout");
    });
    await expect(listExternalSessions(command, "a", "p")).rejects.toThrow("timeout");
    expect(isMarkedUnsupported("a")).toBe(false);
  });

  it("always sends the project", async () => {
    const command = vi.fn(async () => ({ turns: [] }) as never);
    await readExternalSession(command, "a", "p", "s", 42);
    expect(command).toHaveBeenCalledWith("externalSessions.read", {
      projectId: "p",
      sessionId: "s",
      before: 42,
    });
    const list = vi.fn(async () => ({ sessions: [session()] }) as never);
    expect(await listExternalSessions(list, "a", "p")).toHaveLength(1);
    expect(list).toHaveBeenCalledWith("externalSessions.list", { projectId: "p" });
  });
});

describe("row labels", () => {
  it("names the source except for the main account", () => {
    expect(sourceLabel("claude")).toBeUndefined();
    expect(sourceLabel("claude-cx")).toBe("cx");
    expect(sourceLabel("codex")).toBe("codex");
  });

  it("labels states", () => {
    expect(stateLabel("running")).toBe("Running");
    expect(stateLabel("idle")).toBe("Idle");
    expect(stateLabel("handed-over")).toBe("Handed over");
  });

  it("titles a row by name, handoff file, then id", () => {
    expect(sessionTitle(session({ name: "monocode-16" }))).toBe("monocode-16");
    expect(sessionTitle(session({ handoffPath: ".claude/handoff.md" }))).toBe("handoff.md");
    expect(sessionTitle(session())).toBe("abcdef12");
  });

  it("puts source, branch and age on the meta line", () => {
    const now = 10 * 60 * 60_000;
    expect(
      metaParts(session({ source: "claude-cx", branch: "main", updatedAt: now - 5 * 60_000 }), now),
    ).toEqual(["cx", "main", "5m"]);
    expect(metaParts(session({ updatedAt: now - 3 * 60 * 60_000 }), now)).toEqual(["3h"]);
    expect(metaParts(session(), now)).toEqual([]);
  });
});
