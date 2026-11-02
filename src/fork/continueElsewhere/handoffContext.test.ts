// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  newSession,
  type Session,
} from "../../features/sessions/model/session";
import { saveContinuedOrigin } from "./continueElsewhere";
import { pendingHandoff } from "../../features/sessions/model/handoff";
import {
  needsHandoffRecovery,
  prepareHandoffContext,
  recordHandoffContext,
  finishHandoffContext,
} from "./handoffContext";

beforeEach(() => localStorage.clear());
function session(id: string, text: string): Session {
  return {
    ...newSession("codex", "/repo"),
    id,
    blocks: [{ id: `${id}-u`, role: "user", text }],
  };
}

it("restores unabridged original instructions for an already continued thread", async () => {
  const source = session(
    "source",
    `${"Background ".repeat(500)}YOUR ASSIGNMENT: implement offline sync.`,
  );
  const target = session("target", "Continue at xhigh effort.");
  saveContinuedOrigin(target.id, {
    sessionId: source.id,
    from: "claude",
    to: "codex",
    title: "Sync",
    files: 0,
  });
  const write = vi.fn(async (_text: string) => "/private/handoff.md");
  const load = vi.fn(async (id: string) => (id === source.id ? source : null));
  expect(needsHandoffRecovery(target)).toBe(true);
  const result = await prepareHandoffContext(
    target,
    "Short recap",
    load,
    write,
  );
  expect(write.mock.calls[0][0]).toContain(source.blocks[0].text);
  expect(result).toContain("/private/handoff.md");
  expect(result).toContain("Before continuing");
  expect(result).not.toContain("ask the user");
  expect(load).toHaveBeenCalledWith("source");
  const recorded = recordHandoffContext(target, "claude", result);
  expect(needsHandoffRecovery(recorded)).toBe(false);
});

it("recovers legacy pointers even if the origin cache was evicted", async () => {
  const target = session("target", "try again");
  target.blocks.unshift({
    id: "h",
    role: "handoff",
    text: "## Full transcript\nThe whole conversation is MonoCode session source. Ask the user to send /operator.",
    handoff: { from: "claude", to: "codex", status: "ready" },
  });
  const source = session("source", "Original assignment");
  const write = vi.fn(async (_text: string) => "/private/handoff.md");
  expect(needsHandoffRecovery(target)).toBe(true);
  const result = await prepareHandoffContext(
    target,
    target.blocks[0].text,
    async () => source,
    write,
  );
  expect(write.mock.calls[0][0]).toContain("Original assignment");
  expect(result).not.toContain("send /operator");
  expect(
    pendingHandoff(recordHandoffContext(target, "claude", result))?.text,
  ).toContain("/private/handoff.md");
});

it("keeps the archive pending for retry if the provider rejects the repaired turn", () => {
  const target = session("target", "try again");
  target.blocks.unshift({
    id: "h",
    role: "handoff",
    text: "Old recap",
    handoff: { from: "claude", to: "codex", status: "ready", pending: false },
  });
  const ready = recordHandoffContext(
    target,
    "claude",
    "## Conversation archive\nRead /private/archive.md",
  );
  expect(pendingHandoff(ready)?.text).toContain("/private/archive.md");
});

it("retains recovery when a send resolves after emitting session.error", async () => {
  let current = recordHandoffContext(
    session("target", "try again"),
    "claude",
    "## Conversation archive\nRead /private/archive.md",
  );
  let providerFailureSeen = false;
  const send = async (onEvent: (event: { type: string }) => void) => {
    onEvent({ type: "session.error" });
  };
  await send((event) => {
    if (event.type === "session.error") providerFailureSeen = true;
  });
  current = finishHandoffContext(current, "recap", {
    failed: providerFailureSeen,
    rawCommand: false,
  });
  expect(pendingHandoff(current)?.text).toContain("/private/archive.md");
  current = finishHandoffContext(current, "recap", {
    failed: false,
    rawCommand: false,
  });
  expect(pendingHandoff(current)).toBeNull();
});

it("exports complete user text, plans and replies, excluding hidden reasoning and drafts", async () => {
  const source = session("source", "Complete instructions");
  source.blocks.push(
    { id: "a", role: "assistant", text: "Progress" },
    { id: "p", role: "plan", text: "Full plan" },
    { id: "r", role: "reasoning", text: "HIDDEN_REASONING" },
    { id: "t", role: "tool", text: "SECRET_TOOL_OUTPUT" },
    { id: "d", role: "user", text: "UNSENT_DRAFT", draft: true },
  );
  const write = vi.fn(async (_text: string) => "/private/handoff.md");
  await prepareHandoffContext(source, "Recap", async () => null, write);
  const archive = write.mock.calls[0][0];
  expect(archive).toContain("Complete instructions");
  expect(archive).toContain("Full plan");
  expect(archive).toContain("Progress");
  expect(archive).not.toMatch(
    /HIDDEN_REASONING|SECRET_TOOL_OUTPUT|UNSENT_DRAFT/,
  );
});

it("does not silently proceed if the source is missing or belongs to another project", async () => {
  const target = session("target", "continue");
  saveContinuedOrigin(target.id, {
    sessionId: "source",
    from: "claude",
    to: "codex",
    title: "Task",
    files: 0,
  });
  const write = vi.fn(async () => "/private/handoff.md");
  await expect(
    prepareHandoffContext(target, "Recap", async () => null, write),
  ).rejects.toThrow("original conversation");
  await expect(
    prepareHandoffContext(
      target,
      "Recap",
      async () => ({ ...session("source", "private"), cwd: "/other" }),
      write,
    ),
  ).rejects.toThrow("project");
  expect(write).not.toHaveBeenCalled();
});

it("follows multiple handoffs and honors the selected historical turn", async () => {
  const original = session("original", "Original assignment");
  original.blocks.push({
    id: "later",
    role: "user",
    text: "Unselected later request",
  });
  const middle = session("middle", "Middle progress");
  const target = session("target", "Continue");
  saveContinuedOrigin(middle.id, {
    sessionId: original.id,
    throughBlockId: "original-u",
    from: "claude",
    to: "codex",
    title: "Task",
    files: 0,
  });
  saveContinuedOrigin(target.id, {
    sessionId: middle.id,
    from: "codex",
    to: "claude",
    title: "Task",
    files: 0,
  });
  const write = vi.fn(async (_text: string) => "/private/handoff.md");
  await prepareHandoffContext(
    target,
    "Recap",
    async (id) => (id === original.id ? original : middle),
    write,
  );
  expect(write.mock.calls[0][0]).toContain("Original assignment");
  expect(write.mock.calls[0][0]).toContain("Middle progress");
  expect(write.mock.calls[0][0]).not.toContain("Unselected later request");
});
