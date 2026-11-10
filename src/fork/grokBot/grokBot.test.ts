import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  GROK_BOT_PROMPT_LIMIT,
  grokBotAvailable,
  grokBotBrief,
  grokBotPrompt,
  loadGrokBotStatus,
  openGrokBot,
  resetGrokBotStatusCache,
} from "./grokBot";

const base = {
  title: "Fix the login bug",
  cwd: "/Users/me/projects/app",
  branch: "fix/login",
  files: ["src/a.ts", "src/b.ts"],
};

describe("grokBotPrompt", () => {
  it("names the project, branch, task, request and files", () => {
    const text = grokBotPrompt({ ...base, userRequest: "Make the login\nwork again" });
    expect(text).toContain("Project: app (/Users/me/projects/app)");
    expect(text).toContain("Branch: fix/login");
    expect(text).toContain("Task: Fix the login bug");
    expect(text).toContain("Last request: Make the login work again");
    expect(text).toContain("Changed files: src/a.ts, src/b.ts");
    expect(text).toContain("clipboard");
  });

  it("leaves out lines it has nothing for", () => {
    const text = grokBotPrompt({ title: "T", cwd: "/x/y", files: [] });
    expect(text).not.toContain("Branch:");
    expect(text).not.toContain("Changed files:");
    expect(text).not.toContain("Last request:");
  });

  it("clips a long request to stay within the link limit", () => {
    const text = grokBotPrompt({ ...base, userRequest: "word ".repeat(1000) });
    expect(text.length).toBeLessThanOrEqual(GROK_BOT_PROMPT_LIMIT);
    expect(text).toContain("Last request: word");
    expect(text).toContain("…");
    expect(text.endsWith("Ask me to paste it if you need more.")).toBe(true);
  });

  it("stays within the limit with many files and emoji", () => {
    const files = Array.from({ length: 40 }, (_, i) => `src/${"😀".repeat(20)}${i}.ts`);
    const text = grokBotPrompt({ ...base, title: "😀".repeat(400), files, userRequest: "😀".repeat(900) });
    expect(text.length).toBeLessThanOrEqual(GROK_BOT_PROMPT_LIMIT);
    expect(text).toContain("(+35 more)");
  });

  it("fills the link exactly when the request is long", () => {
    const text = grokBotPrompt({ ...base, userRequest: "x".repeat(5000) });
    expect(text.length).toBe(GROK_BOT_PROMPT_LIMIT);
  });

  it("never splits an emoji when clipping", () => {
    const text = grokBotPrompt({ ...base, userRequest: "😀".repeat(2000) });
    expect(text.length).toBeLessThanOrEqual(GROK_BOT_PROMPT_LIMIT);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
  });
});

describe("grokBotBrief", () => {
  it("puts the facts above the full brief", () => {
    const text = grokBotBrief({ ...base, brief: "## Goal\nDo it" });
    expect(text.startsWith("# Handoff from MonoCode: Fix the login bug")).toBe(true);
    expect(text).toContain("- Branch: fix/login");
    expect(text).toContain("## Goal\nDo it");
  });
});

describe("status", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetGrokBotStatusCache();
  });

  it("hides the item until the status is known, then follows it", async () => {
    invoke.mockResolvedValue({ installed: true, allowed: true, policy: "personal" });
    expect(grokBotAvailable("/p")).toBe(false);
    await loadGrokBotStatus("/p");
    expect(grokBotAvailable("/p")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fork_grok_bot_status", { cwd: "/p" });
  });

  it("stays hidden for a confidential folder or a missing app", async () => {
    invoke.mockResolvedValueOnce({ installed: true, allowed: false, policy: "confidential" });
    await loadGrokBotStatus("/client");
    expect(grokBotAvailable("/client")).toBe(false);
    invoke.mockResolvedValueOnce({ installed: false, allowed: true, policy: "none" });
    await loadGrokBotStatus("/other");
    expect(grokBotAvailable("/other")).toBe(false);
  });

  it("treats a failed status call as unavailable", async () => {
    invoke.mockRejectedValue(new Error("no command"));
    expect(await loadGrokBotStatus("/p")).toBeNull();
    expect(grokBotAvailable("/p")).toBe(false);
  });

  it("passes the text and folder to the open command", async () => {
    invoke.mockResolvedValue(undefined);
    await openGrokBot("hi", "/p");
    expect(invoke).toHaveBeenCalledWith("fork_grok_bot_open", { text: "hi", cwd: "/p" });
  });
});
