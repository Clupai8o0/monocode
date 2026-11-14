import { describe, expect, it } from "vitest";
import type { GrokBotBot } from "./agentGrokBot";
import {
  SETUP_PROMPT,
  hookLine,
  webhookRows,
  type WebhookInfo,
} from "./grokBotWebhooks";

function bot(over: Partial<GrokBotBot> & Pick<GrokBotBot, "id">): GrokBotBot {
  return {
    name: over.id,
    description: null,
    title: null,
    lastActivityAt: null,
    lastPreview: null,
    unreadCount: 0,
    hasUnread: false,
    awaitingReply: false,
    hidden: false,
    hasChat: true,
    ...over,
  };
}

function hook(over: Partial<WebhookInfo> & Pick<WebhookInfo, "botId">): WebhookInfo {
  return {
    host: "hooks.example.com",
    addedAt: 1_700_000_000_000,
    lastRunAt: null,
    ...over,
  };
}

describe("SETUP_PROMPT", () => {
  it("mentions requestId and task", () => {
    expect(SETUP_PROMPT).toContain("requestId");
    expect(SETUP_PROMPT).toContain("task");
  });
});

describe("webhookRows", () => {
  it("drops a hidden bot without a hook", () => {
    const rows = webhookRows([bot({ id: "h1", hidden: true })], []);
    expect(rows).toHaveLength(0);
  });

  it("keeps a hidden bot that has a hook", () => {
    const rows = webhookRows(
      [bot({ id: "h1", name: "Secret", hidden: true })],
      [hook({ botId: "h1" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Secret");
    expect(rows[0].hook).not.toBeNull();
  });

  it("adds a missing row for an orphan hook", () => {
    const rows = webhookRows([], [hook({ botId: "gone" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      botId: "gone",
      name: "Unknown bot",
      missing: true,
    });
  });

  it("lists hooked bots first, then the rest, each by name case-insensitively", () => {
    const rows = webhookRows(
      [
        bot({ id: "a", name: "zebra" }),
        bot({ id: "b", name: "Alpha" }),
        bot({ id: "c", name: "mango" }),
      ],
      [hook({ botId: "a" })],
    );
    expect(rows.map((row) => row.name)).toEqual(["zebra", "Alpha", "mango"]);
  });

  it("uses the bot id when the name is blank", () => {
    const rows = webhookRows([bot({ id: "bot-42", name: "   " })], []);
    expect(rows[0].name).toBe("bot-42");
  });
});

describe("hookLine", () => {
  const added = Date.parse("2023-11-03T12:00:00Z");
  const base = hook({ botId: "b1", host: "hooks.example.com", addedAt: added });

  it("says just now under a minute", () => {
    const lastRun = 1_700_000_000_000;
    expect(hookLine({ ...base, lastRunAt: lastRun }, lastRun + 30_000)).toBe(
      "Webhook on hooks.example.com · last run just now",
    );
  });

  it("says minutes under an hour", () => {
    const lastRun = 1_700_000_000_000;
    expect(hookLine({ ...base, lastRunAt: lastRun }, lastRun + 5 * 60_000)).toBe(
      "Webhook on hooks.example.com · last run 5 min ago",
    );
  });

  it("says hours under a day", () => {
    const lastRun = 1_700_000_000_000;
    expect(hookLine({ ...base, lastRunAt: lastRun }, lastRun + 3 * 3_600_000)).toBe(
      "Webhook on hooks.example.com · last run 3 h ago",
    );
  });

  it("shows the added date when it never ran", () => {
    expect(hookLine(base, added + 60_000)).toBe(
      "Webhook on hooks.example.com · added 3 Nov",
    );
  });
});
