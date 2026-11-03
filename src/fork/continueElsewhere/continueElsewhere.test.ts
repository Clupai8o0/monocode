import { beforeEach, describe, expect, it } from "vitest";
import {
  continuedOrigin,
  continueLabel,
  continueTarget,
  handoffTargets,
  saveContinuedOrigin,
  withTranscriptPointer,
  type ContinuedOrigin,
} from "./continueElsewhere";

const origin = (sessionId = "src"): ContinuedOrigin => ({
  sessionId,
  from: "claude",
  to: "codex",
  title: "Fix the login",
  files: 3,
});

const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      clear: () => memory.clear(),
      removeItem: (key: string) => {
        memory.delete(key);
      },
    },
  });
});

describe("handoffTargets", () => {
  it("offers first-class peers plus Cursor", () => {
    expect(handoffTargets("claude").sort()).toEqual(["codex", "cursor", "grok"]);
    expect(handoffTargets("codex").sort()).toEqual(["claude", "cursor", "grok"]);
    expect(handoffTargets("grok").sort()).toEqual(["claude", "codex", "cursor"]);
    expect(handoffTargets("cursor").sort()).toEqual(["claude", "codex", "grok"]);
  });

  it("keeps continueTarget as the primary peer when usage is unknown", () => {
    expect(continueTarget("claude")).toBe("codex");
    expect(continueTarget("codex")).toBe("claude");
    expect(continueTarget("grok")).toBe("claude");
    expect(continueTarget("cursor")).toBe("claude");
    expect(continueLabel("grok")).toBe("Continue in Claude Code");
    expect(continueLabel("cursor")).toBe("Continue in Claude Code");
  });

  it("offers nothing for providers outside the continue pool", () => {
    expect(continueTarget("fx")).toBeNull();
    expect(continueLabel("fx")).toBeNull();
  });

  it("picks the live candidate with the most headroom", () => {
    expect(
      continueTarget("cursor", {
        isLive: (id) => id === "claude" || id === "codex",
        usedPercent: (id) => (id === "codex" ? 10 : 80),
      }),
    ).toBe("codex");
    expect(
      continueTarget("claude", {
        isLive: (id) => id === "codex" || id === "cursor",
        usedPercent: (id) => (id === "cursor" ? 5 : 90),
      }),
    ).toBe("cursor");
  });

  it("skips agents that are not live", () => {
    expect(
      continueTarget("cursor", {
        isLive: (id) => id === "codex",
        usedPercent: () => 0,
      }),
    ).toBe("codex");
    expect(
      continueTarget("claude", {
        isLive: () => false,
      }),
    ).toBeNull();
  });
});

describe("withTranscriptPointer", () => {
  it("keeps the brief and says where the rest is", () => {
    const text = withTranscriptPointer("## Session so far\nUser: hi", "abc");
    expect(text.startsWith("## Session so far\nUser: hi\n\n## Full transcript")).toBe(true);
    expect(text).toContain("MonoCode session abc");
    expect(text).not.toContain("ask the user");
    expect(text).not.toContain("send /operator");
  });

  it("still points at the transcript with an empty brief", () => {
    expect(withTranscriptPointer("  ", "abc").startsWith("## Full transcript")).toBe(true);
  });
});

describe("origins", () => {
  it("remembers where a session came from", () => {
    saveContinuedOrigin("new", origin());
    expect(continuedOrigin("new")?.title).toBe("Fix the login");
    expect(continuedOrigin("other")).toBeNull();
  });

  it("keeps a bounded number, dropping the oldest", () => {
    for (let index = 0; index < 205; index++) {
      saveContinuedOrigin(`s${index}`, origin());
    }
    expect(continuedOrigin("s0")).toBeNull();
    expect(continuedOrigin("s204")).not.toBeNull();
  });

  it("survives a damaged store", () => {
    localStorage.setItem("monocode.fork.continuedFrom", "{nope");
    expect(continuedOrigin("x")).toBeNull();
    saveContinuedOrigin("x", origin());
    expect(continuedOrigin("x")).not.toBeNull();
  });
});
