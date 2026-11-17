// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setComposerMcpTags } from "../model/draftCache";
import { newMcpTag } from "../model/mcpPicker";
import {
  canStageInTurn,
  parseStageSubmission,
  stageTurnPrompt,
} from "../model/stageCommand";
import { Composer } from "./Composer";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const SESSION = "stage-session";
const TAG = newMcpTag(
  { name: "server", provider: "claude", scope: "user" } as Parameters<
    typeof newMcpTag
  >[0],
  [],
);

describe("/stage through the composer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setComposerMcpTags(SESSION, [TAG]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setComposerMcpTags(SESSION, []);
    vi.restoreAllMocks();
  });

  async function send(draft: string) {
    const onSubmit = vi.fn();
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: false,
          harness: "claude",
          model: "",
          runtimeMode: "supervised",
          executionCwd: "~",
          sessionId: SESSION,
          initialDraft: draft,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, , options] = onSubmit.mock.calls[0];
    return { text: text as string, intent: options.intent as string };
  }

  it("expands the command when an MCP tag adds context", async () => {
    const { text, intent } = await send(`/stage ${TAG.token}`);
    expect(text.startsWith("MCP context:")).toBe(true);
    const parsed = parseStageSubmission(text);
    expect(parsed).toMatchObject({ matched: true, text: TAG.token });
    expect(canStageInTurn({ intent, orchestrating: false })).toBe(true);
    const prompt = parsed.mcpContext + stageTurnPrompt(parsed.text, []);
    expect(prompt.startsWith("MCP context:")).toBe(true);
    expect(prompt).toContain("Stage the changes you made");
    expect(prompt).toContain(TAG.token);
  });

  it.each([
    ["Plan", `/plan /stage ${TAG.token}`],
    ["Orchestrator", `/orchestrator /stage ${TAG.token}`],
  ])("rejects a tagged command in %s mode", async (_mode, draft) => {
    const { text, intent } = await send(draft);
    expect(parseStageSubmission(text).matched).toBe(true);
    expect(canStageInTurn({ intent, orchestrating: false })).toBe(false);
  });
});

describe("parseStageSubmission", () => {
  it("leaves other text untouched", () => {
    const text =
      'MCP context: Use the configured server "a" (claude) when relevant to this request.\n\nplease /stage';
    expect(parseStageSubmission(text)).toEqual({
      text,
      matched: false,
      mcpContext: "",
    });
    expect(parseStageSubmission("/staged").matched).toBe(false);
  });
});
