import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Block } from "../../features/sessions/model/session";
import type { ProviderRateLimits } from "../../features/providers/model/rateLimits";
import { parseAnsi } from "./ansi";
import { artifactLabel, artifactLinks, buildStatusInput } from "./statusInput";
import { StatusLine } from "./StatusStrip";

describe("parseAnsi", () => {
  it("keeps plain text as one run", () => {
    expect(parseAnsi("opus · high")).toEqual([{ text: "opus · high", style: {} }]);
  });

  it("reads truecolour, 256-colour, basic, bold and reset", () => {
    expect(
      parseAnsi("\x1b[38;2;10;20;30mA\x1b[1;48;5;196mB\x1b[0m C\x1b[31mD\x1b[39mE"),
    ).toEqual([
      { text: "A", style: { color: "rgb(10,20,30)" } },
      {
        text: "B",
        style: { color: "rgb(10,20,30)", bold: true, background: "rgb(255,0,0)" },
      },
      { text: " C", style: {} },
      { text: "D", style: { color: "#e06c75" } },
      { text: "E", style: {} },
    ]);
  });

  it("drops hyperlinks, cursor codes and stray control characters", () => {
    expect(
      parseAnsi("\x1b]8;;https://x.y\x07link\x1b]8;;\x07\x1b[2K ok\x07"),
    ).toEqual([{ text: "link ok", style: {} }]);
  });

  it("ignores malformed extended colours", () => {
    expect(parseAnsi("\x1b[38;2;999;0;0mX")).toEqual([{ text: "X", style: {} }]);
  });
});

describe("buildStatusInput", () => {
  const session = {
    id: "s1",
    cwd: "/repo",
    worktreeCwd: "/repo-wt",
    providerSessionId: "abc-123",
    modelSettings: { effort: "high" },
    context: { used: 50_000, window: 200_000 },
  };

  it("matches the shape Claude Code pipes to a status line", () => {
    const limits = {
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000_000 },
      weekly: { usedPercent: 7, windowMinutes: 10080, resetsAt: null },
    } as ProviderRateLimits;
    expect(
      buildStatusInput(session, { id: "claude-opus-5-5", name: "Opus 5.5" }, limits),
    ).toEqual({
      hook_event_name: "Status",
      session_id: "abc-123",
      cwd: "/repo-wt",
      workspace: { current_dir: "/repo-wt", project_dir: "/repo" },
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      effort: { level: "high" },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 25,
        current_usage: { input_tokens: 50_000 },
      },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 1_800_000_000 },
        seven_day: { used_percentage: 7 },
      },
    });
  });

  it("leaves out what the session does not know yet", () => {
    const input = buildStatusInput(
      { id: "s1", cwd: "/repo", modelSettings: {} },
      { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    );
    expect(Object.keys(input).sort()).toEqual([
      "cwd",
      "hook_event_name",
      "model",
      "workspace",
    ]);
  });
});

describe("artifactLinks", () => {
  const blocks = [
    { id: "1", role: "assistant", text: "See https://claude.ai/artifact/aaaa1111bbbb" },
    {
      id: "2",
      role: "tool",
      text: "Artifact",
      tool: {
        detail: "published https://claude.ai/code/artifact/cccc-2222",
        preview: { kind: "shell", output: "again https://claude.ai/artifact/aaaa1111bbbb" },
      },
    },
    { id: "3", role: "assistant", text: "not https://claude.ai/chat/xyz or https://evil.com/artifact/x" },
  ] as Block[];

  it("finds claude.ai artifact links, newest first, once each", () => {
    expect(artifactLinks(blocks)).toEqual([
      "https://claude.ai/code/artifact/cccc-2222",
      "https://claude.ai/artifact/aaaa1111bbbb",
    ]);
  });

  it("labels a link by its id's start", () => {
    expect(artifactLabel("https://claude.ai/artifact/aaaa1111bbbb")).toBe("aaaa1111");
  });
});

describe("StatusLine", () => {
  it("renders coloured runs as styled spans", () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, { line: "\x1b[38;2;1;2;3mOpus\x1b[0m │ 25%" }),
    );
    expect(html).toContain('<span style="color:rgb(1,2,3)">Opus</span>');
    expect(html).toContain("Nerd Font");
    expect(html).toContain("│ 25%");
  });
});
