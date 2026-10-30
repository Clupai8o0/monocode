// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  continuedOrigin,
  continueLabel,
  continueTarget,
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

beforeEach(() => localStorage.clear());

describe("continueTarget", () => {
  it("goes both ways between Claude and Codex", () => {
    expect(continueTarget("claude")).toBe("codex");
    expect(continueTarget("codex")).toBe("claude");
    expect(continueLabel("claude")).toBe("Continue in Codex");
    expect(continueLabel("codex")).toBe("Continue in Claude Code");
  });

  it("offers nothing for other providers", () => {
    expect(continueTarget("grok")).toBeNull();
    expect(continueLabel("grok")).toBeNull();
  });
});

describe("withTranscriptPointer", () => {
  it("keeps the brief and says where the rest is", () => {
    const text = withTranscriptPointer("## Session so far\nUser: hi", "abc");
    expect(text.startsWith("## Session so far\nUser: hi\n\n## Full transcript")).toBe(true);
    expect(text).toContain("MonoCode session abc");
    expect(text).toContain('sessions.read {"sessionId":"abc"}');
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
