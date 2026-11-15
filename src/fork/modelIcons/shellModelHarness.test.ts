import { describe, expect, it } from "vitest";
import type { Block } from "../../features/sessions/model/session";
import { shellModelHarness } from "./shellModelHarness";

function shell(text: string, title = "", command?: string): Block {
  return {
    id: "b",
    role: "tool",
    text,
    tool: { kind: "execute", title, command },
  } as Block;
}

describe("shellModelHarness", () => {
  it("reads the model from the call's description", () => {
    expect(shellModelHarness(shell("Gemini Carbon builds the Theatre direction"))).toBe("antigravity");
    expect(shellModelHarness(shell("Codex builds the Guided tour direction"))).toBe("codex");
    expect(shellModelHarness(shell("Grok builds the Contact sheet direction"))).toBe("grok");
    expect(shellModelHarness(shell("DeepSeek Flash reviews the diff"))).toBe("deepseek");
  });

  it("reads an explicit route from the command", () => {
    const cmd = "sleep 2; D=~/x; python3 ~/s/second_opinion.py /tmp/p.txt --cwd $D --ladder grok:grok-4.7";
    expect(shellModelHarness(shell("Run the build", "", cmd))).toBe("grok");
    expect(shellModelHarness(shell("", "codex exec 'fix it'"))).toBe("codex");
    expect(shellModelHarness(shell("", "second_opinion.py - --review --ladder dsh:deepseek-flash"))).toBe("deepseek");
  });

  it("ignores names inside paths, files and tool names", () => {
    expect(shellModelHarness(shell("List sessions", "claude-sessions list"))).toBeUndefined();
    expect(shellModelHarness(shell("Read hooks", "cat ~/.claude/hooks/claims.py"))).toBeUndefined();
    expect(shellModelHarness(shell("Run tests", "vitest run src/codex.test.ts"))).toBeUndefined();
    expect(shellModelHarness(shell("Show working tree status", "git status"))).toBeUndefined();
  });
});
