import { invoke } from "@tauri-apps/api/core";
import type { GrokBotBot, GrokBotRoster } from "./agentGrokBot";

export type WebhookInfo = {
  botId: string;
  host: string;
  addedAt: number;
  lastRunAt: number | null;
};

export const SETUP_PROMPT =
  'Add a routine called "MonoCode" with a webhook trigger. When it fires, the JSON body has "task", "requestId" and "from". Do the task as if I had sent it to you in this chat, and start your reply with the requestId in square brackets, like [mc-abc123].';

async function invokeOrError<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (failure) {
    throw new Error(typeof failure === "string" ? failure : String(failure));
  }
}

export function loadWebhooks(): Promise<WebhookInfo[]> {
  return invokeOrError<WebhookInfo[]>("fork_grok_bot_webhooks");
}

export function saveWebhook(botId: string, url: string, key: string): Promise<WebhookInfo> {
  return invokeOrError<WebhookInfo>("fork_grok_bot_webhook_set", { botId, url, key });
}

export function removeWebhook(botId: string): Promise<void> {
  return invokeOrError<void>("fork_grok_bot_webhook_remove", { botId });
}

export function loadBots(): Promise<GrokBotRoster> {
  return invokeOrError<GrokBotRoster>("fork_grok_bot_bots");
}

export type WebhookRow = {
  botId: string;
  name: string;
  hook: WebhookInfo | null;
  missing: boolean;
};

function displayName(bot: GrokBotBot): string {
  const trimmed = bot.name.trim();
  return trimmed.length > 0 ? trimmed : bot.id;
}

function rowName(row: WebhookRow): string {
  return row.name;
}

function sortRows(rows: WebhookRow[]): WebhookRow[] {
  const withHook = rows.filter((row) => row.hook !== null);
  const withoutHook = rows.filter((row) => row.hook === null);
  const byName = (a: WebhookRow, b: WebhookRow) =>
    rowName(a).localeCompare(rowName(b), undefined, { sensitivity: "base" });
  return [...withHook.sort(byName), ...withoutHook.sort(byName)];
}

export function webhookRows(
  bots: readonly GrokBotBot[],
  hooks: readonly WebhookInfo[],
): WebhookRow[] {
  const hookByBot = new Map(hooks.map((hook) => [hook.botId, hook]));
  const botIds = new Set(bots.map((bot) => bot.id));

  const rows: WebhookRow[] = [];

  for (const bot of bots) {
    const hook = hookByBot.get(bot.id) ?? null;
    if (bot.hidden && !hook) continue;
    rows.push({
      botId: bot.id,
      name: displayName(bot),
      hook,
      missing: false,
    });
  }

  for (const hook of hooks) {
    if (botIds.has(hook.botId)) continue;
    rows.push({
      botId: hook.botId,
      name: "Unknown bot",
      hook,
      missing: true,
    });
  }

  return sortRows(rows);
}

function shortDayMonth(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(ms));
}

function lastRunPhrase(lastRunAt: number, now: number): string {
  const diff = Math.max(0, now - lastRunAt);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return shortDayMonth(lastRunAt);
}

export function hookLine(hook: WebhookInfo, now: number): string {
  const base = `Webhook on ${hook.host}`;
  if (hook.lastRunAt !== null) {
    return `${base} · last run ${lastRunPhrase(hook.lastRunAt, now)}`;
  }
  return `${base} · added ${shortDayMonth(hook.addedAt)}`;
}
