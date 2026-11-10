import { invoke } from "@tauri-apps/api/core";

/**
 * Fork feature: hand a session over to Grok Bot, xAI's desktop agent app.
 *
 * Grok Bot has no CLI or ACP, so it can't run as a MonoCode provider. It does
 * take `grokbot://app/v1/prompt?text=…` links (text up to 1000 characters).
 * The handover sends a short prompt that way and puts the full brief on the
 * clipboard. The Rust side (`fork_grok_bot.rs`) checks the app is installed
 * and that the folder's privacy policy allows Grok.
 */

/** Grok Bot rejects prompt links whose text is longer than this. */
export const GROK_BOT_PROMPT_LIMIT = 1000;

const MAX_FILES_LISTED = 5;
const CLIPBOARD_LINE =
  "The full handoff brief is on my clipboard. Ask me to paste it if you need more.";

export type GrokBotHandoff = {
  title: string;
  cwd: string;
  branch?: string;
  userRequest?: string;
  files: string[];
};

function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Lengths are JavaScript string lengths (UTF-16 units), as Grok Bot measures
 * them, so an emoji counts as two. Cuts never split a character.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - 1; // for the ellipsis
  let out = "";
  for (const char of text) {
    if (out.length + char.length > room) break;
    out += char;
  }
  return max <= 0 ? "" : `${out.trimEnd()}…`;
}

function filesLine(files: string[]): string | null {
  if (files.length === 0) return null;
  const shown = files.slice(0, MAX_FILES_LISTED).join(", ");
  const more = files.length - MAX_FILES_LISTED;
  return `Changed files: ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** The short prompt sent through the link; always within the limit. */
export function grokBotPrompt(input: GrokBotHandoff): string {
  const head = [
    "Picking up a task from MonoCode.",
    `Project: ${folderName(input.cwd)} (${input.cwd})`,
    input.branch ? `Branch: ${input.branch}` : null,
    `Task: ${clip(oneLine(input.title), 120)}`,
  ].filter((line): line is string => line !== null);
  const files = filesLine(input.files);
  const tail = [files ? clip(files, 300) : null, CLIPBOARD_LINE].filter(
    (line): line is string => line !== null,
  );
  const request = input.userRequest ? oneLine(input.userRequest) : "";
  const fixed = [...head, ...tail].join("\n");
  if (!request) return clip(fixed, GROK_BOT_PROMPT_LIMIT);
  const label = "Last request: ";
  // Room left once the fixed lines, the label and one more newline are in.
  const room = GROK_BOT_PROMPT_LIMIT - fixed.length - label.length - 1;
  if (room < 20) return clip(fixed, GROK_BOT_PROMPT_LIMIT);
  return [...head, `${label}${clip(request, room)}`, ...tail].join("\n");
}

/** The clipboard copy: the same facts plus MonoCode's full brief. */
export function grokBotBrief(input: GrokBotHandoff & { brief: string }): string {
  const lines = [
    `# Handoff from MonoCode: ${oneLine(input.title)}`,
    "",
    `- Project: ${input.cwd}`,
    input.branch ? `- Branch: ${input.branch}` : null,
    input.files.length > 0 ? `- Changed files: ${input.files.join(", ")}` : null,
  ].filter((line): line is string => line !== null);
  const brief = input.brief.trim();
  return brief ? `${lines.join("\n")}\n\n${brief}\n` : `${lines.join("\n")}\n`;
}

export type GrokBotStatus = {
  installed: boolean;
  allowed: boolean;
  /** "personal", "open", "confidential", or "none" without a policy file. */
  policy: string;
};

const STATUS_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; status: GrokBotStatus }>();
const statusLoads = new Map<string, Promise<GrokBotStatus | null>>();

/** Last known status for a folder, or null until one has loaded. */
export function cachedGrokBotStatus(cwd: string): GrokBotStatus | null {
  return statusCache.get(cwd)?.status ?? null;
}

export function loadGrokBotStatus(cwd: string): Promise<GrokBotStatus | null> {
  const hit = statusCache.get(cwd);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return Promise.resolve(hit.status);
  const pending = statusLoads.get(cwd);
  if (pending) return pending;
  const load = invoke<GrokBotStatus>("fork_grok_bot_status", { cwd })
    .then((status) => {
      statusCache.set(cwd, { at: Date.now(), status });
      return status;
    })
    .catch(() => null)
    .finally(() => statusLoads.delete(cwd));
  statusLoads.set(cwd, load);
  return load;
}

/** Show the handover only once the folder is known to allow it. */
export function grokBotAvailable(cwd: string): boolean {
  const status = cachedGrokBotStatus(cwd);
  if (!status) {
    void loadGrokBotStatus(cwd);
    return false;
  }
  return status.installed && status.allowed;
}

export function openGrokBot(text: string | undefined, cwd: string): Promise<void> {
  return invoke("fork_grok_bot_open", { text: text ?? null, cwd });
}

/** For tests. */
export function resetGrokBotStatusCache() {
  statusCache.clear();
  statusLoads.clear();
}

export type GrokBotHost = {
  /** True when the session is local and its folder allows Grok Bot. */
  canHandOver: (sessionId: string) => boolean;
  handOver: (sessionId: string) => void;
};

let host: GrokBotHost | null = null;

export function registerGrokBotHost(next: GrokBotHost | null) {
  host = next;
}

export const grokBotHost = () => host;

export const GROK_BOT_MENU_ID = "hand-over-grok-bot";
export const GROK_BOT_MENU_LABEL = "Hand over to Grok Bot";
