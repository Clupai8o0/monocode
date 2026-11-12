// Fork: provider handoffs pick saved messages by rule, without asking the
// outgoing agent for a recap. Asking it re-read the whole old context once
// more on every switch (T3 Code's "portable handoffs" idea).
import { isEditTool } from "../../integrations/harness/core/preview";
import { compactCiRepairContext } from "../../features/inbox/model/ciRepair";
import {
  consumeOperatorCommand,
  operatorUserPrompt,
} from "../../features/sessions/model/operatorCommand";
import type { Block, Session } from "../../features/sessions/model/session";
import { displayPath } from "../../shared/lib/paths";

/** Bytes of history a handoff may carry. One byte counts as one token, so this over-counts. */
export const HANDOFF_BUDGET_BYTES = 16_000;
/** One message keeps at most this much; a longer one keeps its start and end. */
const ITEM_CAP_BYTES = 6_000;
/** A trimmed message is only worth sending with at least this much room. */
const MIN_TRIMMED_BYTES = 800;
const INHERITED_CAP_BYTES = 2_000;
const PLAN_CAP_BYTES = 2_000;
const CI_CAP_CHARS = 4_000;
const MAX_ACTIVITY = 30;
const MAX_FILES = 40;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text).length;

type Item = {
  id: string;
  label: string;
  text: string;
  /** A one-line tool outcome rather than a message. */
  activity?: boolean;
  ciContext?: string;
};

/** Cut the middle out, keeping the start and the end, to fit `cap` bytes. */
export function trimMiddle(text: string, cap: number): string {
  const all = encoder.encode(text);
  if (all.length <= cap) return text;
  const gap = "\n\n[… middle left out; the full text is in the conversation archive …]\n\n";
  const room = Math.max(0, cap - bytes(gap));
  const headBytes = Math.floor(room * 0.6);
  const tailBytes = room - headBytes;
  // Cut on bytes, then drop a character the cut split in two.
  const head = decoder.decode(all.subarray(0, headBytes)).replace(/\uFFFD+$/, "");
  const tail = decoder.decode(all.subarray(all.length - tailBytes)).replace(/^\uFFFD+/, "");
  return `${head.trimEnd()}${gap}${tail.trimStart()}`;
}

function isShellTool(block: Block): boolean {
  const kind = block.tool?.kind?.trim().toLowerCase() ?? "";
  return (
    block.tool?.preview?.kind === "shell" ||
    ["execute", "bash", "shell", "command", "terminal"].includes(kind)
  );
}

function activityLine(block: Block, cwd: string): string | null {
  const tool = block.tool;
  const title = oneLine(block.text || tool?.title || "");
  const failed = /fail|error|denied|rejected/i.test(tool?.status ?? "");
  if (isEditTool(tool?.kind, block.text || tool?.title, tool?.preview)) {
    const path = tool?.preview?.path
      ? displayPath(tool.preview.path, cwd)
      : tool?.preview?.fileName;
    const line = path && !title.toLowerCase().includes(path.toLowerCase())
      ? `${title || "Edited"} (${path})`
      : title || path || "";
    return line ? `${line.slice(0, 200)}${failed ? " (failed)" : ""}` : null;
  }
  if (isShellTool(block)) {
    return title ? `Ran ${title.slice(0, 200)}${failed ? " (failed)" : ""}` : null;
  }
  return null;
}

function editedFile(block: Block, cwd: string): string | null {
  const tool = block.tool;
  if (!isEditTool(tool?.kind, block.text || tool?.title, tool?.preview)) return null;
  const path = tool?.preview?.path
    ? displayPath(tool.preview.path, cwd)
    : tool?.preview?.fileName;
  return path || null;
}

/** Drop an earlier handoff's archive pointer; the new archive covers it. */
function inheritedText(text: string): string {
  return text
    .replace(/^## (?:Conversation archive|Full transcript)\s*\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, "")
    .replace(/^#{2,6}\s+Previous handoff\s*\n/gm, "")
    .trim();
}

function render(item: Item, text = item.text): string {
  return item.activity ? `- ${text}` : `### ${item.label} (${item.id})\n${text}`;
}

/**
 * The handoff brief: the original request, then as much of the newest
 * conversation as the budget holds, with full message text, plus edited files.
 * Left-out messages stay in the conversation archive, named by id.
 */
export function budgetedHandoff(
  session: Session,
  request?: string,
  cwd = session.cwd,
  budget = HANDOFF_BUDGET_BYTES,
): string {
  const raw = request?.trim() ?? "";
  // Transcript blocks hold an /operator request without its command.
  const current = consumeOperatorCommand(raw).text.trim() || raw;
  const items: Item[] = [];
  const files = new Map<string, string>();
  let inherited = "";

  for (const block of session.blocks) {
    if (block.role === "reasoning" || block.draft || block.internal) continue;
    if (block.role === "handoff") {
      // A switch inside this thread recaps messages that are still here; only
      // a thread continued from elsewhere needs its handoff carried on.
      const text = inheritedText(block.text);
      if (text && !items.some((item) => !item.activity)) inherited = text;
      continue;
    }
    if (block.role === "user") {
      const text = operatorUserPrompt(block).trim();
      if (text) {
        items.push({
          id: block.id,
          label: "User",
          text,
          ...(block.ciContext ? { ciContext: block.ciContext } : {}),
        });
      }
      continue;
    }
    if (block.role === "assistant" || block.role === "plan" || block.role === "tasks") {
      const text = block.text.trim();
      const label = block.role === "assistant" ? "Assistant" : block.role === "plan" ? "Plan" : "Tasks";
      if (text) items.push({ id: block.id, label, text });
      continue;
    }
    if (block.role === "tool" || block.role === "approval") {
      const file = editedFile(block, cwd);
      if (file) files.set(file.toLowerCase(), file);
      const line = activityLine(block, cwd);
      if (line) items.push({ id: block.id, label: "Activity", text: line, activity: true });
    }
  }

  // The new request is sent on its own; it is not history.
  const last = [...items].reverse().find((item) => !item.activity);
  if (current && last?.label === "User" && (last.text === current || last.text === raw)) {
    items.splice(items.lastIndexOf(last), 1);
  }
  // CI data from the prior turn; the new request carries its own.
  const ciContext =
    [...items].reverse().find((item) => item.label === "User")?.ciContext ?? "";

  const sections: string[] = [];
  let room = budget;
  const spend = (text: string) => {
    room -= bytes(text) + 2;
  };

  if (inherited) {
    const text = `## Previous handoff\n${trimMiddle(inherited, INHERITED_CAP_BYTES)}`;
    sections.push(text);
    spend(text);
  }

  const firstUser = items.findIndex((item) => item.label === "User");
  const original = firstUser >= 0 ? items[firstUser] : undefined;
  const rest = original ? items.filter((_, index) => index !== firstUser) : items;

  // Newest first, keeping a contiguous recent stretch.
  const recent: string[] = [];
  let activity = 0;
  let cut = -1;
  const originalCost = original
    ? bytes(render(original, trimMiddle(original.text, ITEM_CAP_BYTES))) + 64
    : 0;
  for (let index = rest.length - 1; index >= 0; index--) {
    const item = rest[index];
    if (item.activity) {
      if (activity >= MAX_ACTIVITY) continue;
      activity++;
    }
    const full = render(item, trimMiddle(item.text, ITEM_CAP_BYTES));
    const left = room - originalCost - bytes(full) - 1;
    if (left >= 0) {
      recent.unshift(full);
      room -= bytes(full) + 1;
      continue;
    }
    const fit = room - originalCost - bytes(render(item, "")) - 1;
    if (!item.activity && fit >= MIN_TRIMMED_BYTES) {
      const trimmed = render(item, trimMiddle(item.text, fit));
      recent.unshift(trimmed);
      room -= bytes(trimmed) + 1;
      cut = index - 1;
    } else {
      cut = index;
    }
    break;
  }

  if (original) {
    const text = `## Original request (${original.id})\n${trimMiddle(original.text, ITEM_CAP_BYTES)}`;
    sections.push(text);
    spend(text);
  }
  if (cut >= 0) {
    const omitted = rest.slice(0, cut + 1).filter((item) => !item.activity);
    if (omitted.length > 0) {
      sections.push(
        `## Left out\n${omitted.length} earlier ${omitted.length === 1 ? "message" : "messages"} (${omitted[0].id} to ${omitted[omitted.length - 1].id}) are in the conversation archive.`,
      );
    }
  }
  if (recent.length > 0) {
    sections.push(`## Recent conversation\n${recent.join("\n\n")}`);
  }
  // The latest plan and task list matter even when older than the recent stretch.
  for (const label of ["Plan", "Tasks"]) {
    const latest = [...rest].reverse().find((item) => item.label === label);
    if (latest && !recent.some((text) => text.startsWith(`### ${label} (${latest.id})`))) {
      sections.push(`## Latest ${label.toLowerCase()} (${latest.id})\n${trimMiddle(latest.text, PLAN_CAP_BYTES)}`);
    }
  }
  if (files.size > 0) {
    sections.push(
      `## Files edited in this session\n${[...files.values()]
        .slice(-MAX_FILES)
        .map((file) => `- ${file}`)
        .join("\n")}`,
    );
  }
  if (ciContext) {
    // The budget is soft here: CI instructions are never cut, only evidence.
    sections.push(`## CI context\n${compactCiRepairContext(ciContext, CI_CAP_CHARS)}`);
  }
  return sections.join("\n\n").trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
