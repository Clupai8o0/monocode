import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../features/sessions/model/session";
import {
  GROK_BOT_FIELDS,
  GROK_BOT_RUN_LIMIT,
  handleGrokBot,
  parseSince,
  resolveBot,
  type GrokBotBackend,
  type GrokBotBot,
  type GrokBotChat,
  type GrokBotRoster,
} from "./agentGrokBot";
import { GROK_BOT_PROMPT_LIMIT } from "./grokBot";

function session(overrides: {
  id?: string;
  harness?: string;
  cwd?: string;
  worktreeCwd?: string;
}): Session {
  return {
    id: overrides.id ?? "sess-claude-1",
    harness: overrides.harness ?? "claude",
    cwd: overrides.cwd ?? "/home/proj",
    worktreeCwd: overrides.worktreeCwd,
  } as unknown as Session;
}

const SAVED_AT = 1_700_000_000_000;
const ACTIVITY_AT = 1_700_100_000_000;
const FIXED_NOW = 1_700_200_000_000;

function bot(overrides: Partial<GrokBotBot> & Pick<GrokBotBot, "id" | "name">): GrokBotBot {
  return {
    description: null,
    title: null,
    lastActivityAt: null,
    lastPreview: null,
    unreadCount: 0,
    hasUnread: false,
    awaitingReply: false,
    hidden: false,
    hasChat: true,
    ...overrides,
  };
}

function makeBackend(
  rosterBots: GrokBotBot[],
  opts?: {
    now?: number;
    chat?: GrokBotBackend["chat"];
    open?: GrokBotBackend["open"];
    status?: GrokBotBackend["status"];
    webhooks?: GrokBotBackend["webhooks"];
    run?: GrokBotBackend["run"];
    requestId?: GrokBotBackend["requestId"];
    savedAt?: number | null;
  },
): GrokBotBackend & {
  status: ReturnType<typeof vi.fn>;
  roster: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  webhooks: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  requestId: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
} {
  const rosterValue: GrokBotRoster = {
    schemaVersion: 1,
    savedAt: opts?.savedAt !== undefined ? opts.savedAt : SAVED_AT,
    bots: rosterBots,
  };
  return {
    status: opts?.status ?? vi.fn(async () => ({ installed: true, allowed: true, policy: "personal" })),
    roster: vi.fn(async () => rosterValue),
    chat: opts?.chat ?? vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "x",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: 0,
      moreBefore: false,
      entries: [],
    })),
    open: opts?.open ?? vi.fn(async () => undefined),
    webhooks: opts?.webhooks ?? vi.fn(async () => []),
    run: opts?.run ?? vi.fn(async () => ({ outcome: "started" as const, status: 200, detail: null })),
    requestId: opts?.requestId ?? vi.fn(() => "mc-test1234"),
    now: vi.fn(() => opts?.now ?? FIXED_NOW),
  };
}

const rosterBots = [
  bot({
    id: "bot-alpha",
    name: "Alpha",
    description: "Does things",
    title: "My Alpha",
    lastActivityAt: ACTIVITY_AT,
    lastPreview: "hello",
    unreadCount: 2,
    awaitingReply: true,
    hasChat: true,
  }),
  bot({
    id: "bot-hidden",
    name: "Hidden One",
    hidden: true,
    lastActivityAt: ACTIVITY_AT,
  }),
  bot({
    id: "bot-no-chat",
    name: "No Chat",
    hasChat: false,
  }),
  bot({ id: "dup-id-a", name: "Twin" }),
  bot({ id: "dup-id-b", name: "Twin" }),
  bot({ id: "pref-a", name: "Prefixable" }),
  bot({ id: "pref-b", name: "Prefixable Two" }),
];

describe("GROK_BOT_FIELDS", () => {
  it("lists the operator action parameter names", () => {
    expect(GROK_BOT_FIELDS).toEqual([
      ["grokbot.list", ["all"]],
      ["grokbot.read", ["bot", "limit", "since", "before", "maxChars"]],
      ["grokbot.draft", ["bot", "text"]],
      ["grokbot.run", ["bot", "text"]],
    ]);
  });
});

describe("callers", () => {
  const backend = makeBackend(rosterBots);

  it("rejects grokbot.list and grokbot.read for codex sessions", async () => {
    const codex = session({ harness: "codex" });
    await expect(handleGrokBot(codex, "grokbot.list", {}, backend)).rejects.toThrow(
      "only Claude sessions",
    );
    await expect(handleGrokBot(codex, "grokbot.read", { bot: "Alpha" }, backend)).rejects.toThrow(
      "only Claude sessions",
    );
  });

  it("rejects grokbot.list and grokbot.read for mcp- session ids", async () => {
    const mcp = session({ id: "mcp-tool-1", harness: "claude" });
    await expect(handleGrokBot(mcp, "grokbot.list", {}, backend)).rejects.toThrow("only Claude sessions");
    await expect(handleGrokBot(mcp, "grokbot.read", { bot: "Alpha" }, backend)).rejects.toThrow(
      "only Claude sessions",
    );
  });

  it("allows grokbot.list and grokbot.read for claude sessions", async () => {
    const claude = session({ harness: "claude" });
    await expect(handleGrokBot(claude, "grokbot.list", {}, backend)).resolves.toBeDefined();
    await expect(handleGrokBot(claude, "grokbot.read", { bot: "Alpha" }, backend)).resolves.toBeDefined();
  });

  it("rejects grokbot.draft for codex sessions before reading anything", async () => {
    const quiet = makeBackend(rosterBots);
    const codex = session({ harness: "codex" });
    await expect(
      handleGrokBot(codex, "grokbot.draft", { bot: "zzz", text: "hi" }, quiet),
    ).rejects.toThrow("only Claude sessions");
    expect(quiet.status).not.toHaveBeenCalled();
    expect(quiet.roster).not.toHaveBeenCalled();
    expect(quiet.open).not.toHaveBeenCalled();
  });

  it("checks the folder policy before reading the bot list", async () => {
    const blocked = makeBackend(rosterBots, {
      status: vi.fn(async () => ({ installed: true, allowed: false, policy: "confidential" })),
    });
    const claude = session({ harness: "claude", cwd: "/client" });
    await expect(
      handleGrokBot(claude, "grokbot.draft", { bot: "zzz", text: "hi" }, blocked),
    ).rejects.toThrow("its privacy policy is confidential");
    expect(blocked.status).toHaveBeenCalledWith("/client");
    expect(blocked.roster).not.toHaveBeenCalled();
    expect(blocked.open).not.toHaveBeenCalled();
    const missing = makeBackend(rosterBots, {
      status: vi.fn(async () => ({ installed: false, allowed: true, policy: "personal" })),
    });
    await expect(
      handleGrokBot(claude, "grokbot.draft", { bot: "Alpha", text: "hi" }, missing),
    ).rejects.toThrow("not installed");
  });

  it("allows grokbot.draft for claude sessions", async () => {
    const claude = session({ harness: "claude" });
    await expect(
      handleGrokBot(claude, "grokbot.draft", { bot: "Alpha", text: "hi" }, backend),
    ).resolves.toMatchObject({ placed: true, sent: false });
  });
});

describe("grokbot.list", () => {
  it("hides hidden bots and reports hiddenCount", async () => {
    const backend = makeBackend(rosterBots);
    const result = (await handleGrokBot(session({}), "grokbot.list", {}, backend)) as {
      bots: { id: string }[];
      hiddenCount?: number;
    };
    expect(result.bots.some((b) => b.id === "bot-hidden")).toBe(false);
    expect(result.hiddenCount).toBe(1);
  });

  it("{all:true} includes hidden bots", async () => {
    const backend = makeBackend(rosterBots);
    const result = (await handleGrokBot(session({}), "grokbot.list", { all: true }, backend)) as {
      bots: { id: string }[];
      hiddenCount?: number;
    };
    expect(result.bots.some((b) => b.id === "bot-hidden")).toBe(true);
    expect(result.hiddenCount).toBeUndefined();
  });

  it("formats savedAt and lastActivity as ISO", async () => {
    const backend = makeBackend(rosterBots);
    const result = (await handleGrokBot(session({}), "grokbot.list", {}, backend)) as {
      savedAt: string;
      bots: { id: string; lastActivity: string }[];
    };
    expect(result.savedAt).toBe(new Date(SAVED_AT).toISOString());
    const alpha = result.bots.find((b) => b.id === "bot-alpha");
    expect(alpha?.lastActivity).toBe(new Date(ACTIVITY_AT).toISOString());
  });

  it("omits optional fields when empty", async () => {
    const minimal = bot({ id: "bot-min", name: "Min", description: null, title: null, lastPreview: null });
    const backend = makeBackend([minimal], { savedAt: null });
    const result = (await handleGrokBot(session({}), "grokbot.list", {}, backend)) as {
      savedAt: unknown;
      bots: Record<string, unknown>[];
    };
    expect(result.savedAt).toBeNull();
    const view = result.bots[0];
    expect(view).not.toHaveProperty("description");
    expect(view).not.toHaveProperty("title");
    expect(view).not.toHaveProperty("lastPreview");
    expect(view).not.toHaveProperty("hidden");
  });

  it("throws when all is not a boolean", async () => {
    const backend = makeBackend(rosterBots);
    await expect(handleGrokBot(session({}), "grokbot.list", { all: "yes" }, backend)).rejects.toThrow(
      "all must be true or false",
    );
  });

  it("marks bots with canRun true or false based on webhooks", async () => {
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    const backend = makeBackend(rosterBots, { webhooks });
    const result = (await handleGrokBot(session({}), "grokbot.list", {}, backend)) as {
      bots: { id: string; canRun?: boolean }[];
    };
    const alpha = result.bots.find((b) => b.id === "bot-alpha");
    const other = result.bots.find((b) => b.id !== "bot-alpha");
    expect(alpha?.canRun).toBe(true);
    expect(other?.canRun).toBe(false);
  });

  it("succeeds without canRun keys when webhooks rejects", async () => {
    const webhooks = vi.fn(async () => {
      throw new Error("Keychain locked");
    });
    const backend = makeBackend(rosterBots, { webhooks });
    const result = (await handleGrokBot(session({}), "grokbot.list", {}, backend)) as {
      bots: Record<string, unknown>[];
    };
    expect(result.bots.length).toBeGreaterThan(0);
    for (const b of result.bots) {
      expect(b).not.toHaveProperty("canRun");
    }
  });
});

describe("resolveBot", () => {
  const bots = [
    bot({ id: "id-exact", name: "Exact" }),
    bot({ id: "name-case", name: "CamelCase" }),
    bot({ id: "uniq-pre", name: "UniquePrefix" }),
    bot({ id: "amb-1", name: "Ambiguous" }),
    bot({ id: "amb-2", name: "Ambiguous Beta" }),
    bot({ id: "dup-1", name: "Same" }),
    bot({ id: "dup-2", name: "Same" }),
  ];

  it("resolves by exact id", () => {
    expect(resolveBot(bots, "id-exact").id).toBe("id-exact");
  });

  it("resolves by name in any case", () => {
    expect(resolveBot(bots, "camelcase").id).toBe("name-case");
    expect(resolveBot(bots, "CAMELCASE").id).toBe("name-case");
  });

  it("resolves by unique name prefix", () => {
    expect(resolveBot(bots, "uniq").id).toBe("uniq-pre");
  });

  it("throws on ambiguous prefix", () => {
    expect(() => resolveBot(bots, "amb")).toThrow(/matches several/);
  });

  it("throws on duplicate name listing ids", () => {
    expect(() => resolveBot(bots, "Same")).toThrow(/Several Grok Bot bots/);
    expect(() => resolveBot(bots, "Same")).toThrow(/dup-1, dup-2/);
  });

  it("throws on unknown name listing bots", () => {
    expect(() => resolveBot(bots, "nope")).toThrow(/No Grok Bot bot called/);
    expect(() => resolveBot(bots, "nope")).toThrow(/Exact/);
  });

  it("throws when ref is empty or not a string", () => {
    expect(() => resolveBot(bots, "")).toThrow("bot must be a Grok Bot bot's name or id");
    expect(() => resolveBot(bots, "   ")).toThrow("bot must be a Grok Bot bot's name or id");
    expect(() => resolveBot(bots, 42)).toThrow("bot must be a Grok Bot bot's name or id");
    expect(() => resolveBot(bots, null)).toThrow("bot must be a Grok Bot bot's name or id");
  });
});

describe("parseSince", () => {
  const now = FIXED_NOW;

  it("parses ISO string", () => {
    const iso = "2023-11-15T12:00:00.000Z";
    expect(parseSince(iso, now)).toBe(Date.parse(iso));
  });

  it("parses epoch milliseconds", () => {
    expect(parseSince(1_690_000_000_000, now)).toBe(1_690_000_000_000);
  });

  it("parses relative spans from fixed now", () => {
    expect(parseSince("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSince("24h", now)).toBe(now - 24 * 3_600_000);
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2w", now)).toBe(now - 2 * 604_800_000);
  });

  it("throws on bad input", () => {
    expect(() => parseSince("not-a-date", now)).toThrow(/since must be/);
    expect(() => parseSince(-1, now)).toThrow(/since must be/);
    expect(() => parseSince(1.5, now)).toThrow(/since must be/);
  });

  it("returns undefined for undefined, null, or empty", () => {
    expect(parseSince(undefined, now)).toBeUndefined();
    expect(parseSince(null, now)).toBeUndefined();
    expect(parseSince("", now)).toBeUndefined();
  });
});

describe("grokbot.read", () => {
  it("passes limit, since, before, and maxChars to backend.chat with resolved id", async () => {
    const chat = vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "bot-alpha",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: 1,
      moreBefore: false,
      entries: [],
    }));
    const backend = makeBackend(rosterBots, { chat });
    const sinceIso = "2024-01-01T00:00:00.000Z";
    await handleGrokBot(session({}), "grokbot.read", {
      bot: "alpha",
      limit: 50,
      since: sinceIso,
      before: 99,
      maxChars: 5000,
    }, backend);

    expect(chat).toHaveBeenCalledWith("bot-alpha", {
      limit: 50,
      since: Date.parse(sinceIso),
      before: 99,
      maxChars: 5000,
    });
  });

  it("rejects limit 0, 201, fractional limit, and maxChars below 200", async () => {
    const backend = makeBackend(rosterBots);
    const base = { bot: "Alpha" };
    await expect(handleGrokBot(session({}), "grokbot.read", { ...base, limit: 0 }, backend)).rejects.toThrow(
      "limit must be a whole number",
    );
    await expect(handleGrokBot(session({}), "grokbot.read", { ...base, limit: 201 }, backend)).rejects.toThrow(
      "limit must be a whole number",
    );
    await expect(handleGrokBot(session({}), "grokbot.read", { ...base, limit: 1.5 }, backend)).rejects.toThrow(
      "limit must be a whole number",
    );
    await expect(handleGrokBot(session({}), "grokbot.read", { ...base, maxChars: 100 }, backend)).rejects.toThrow(
      "maxChars must be a whole number",
    );
  });

  it("sets nextBefore to the first entry seq only when moreBefore", async () => {
    const withMore = vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "bot-alpha",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: 2,
      moreBefore: true,
      entries: [
        { id: "e1", seq: 42, kind: "message", text: "a", at: ACTIVITY_AT },
        { id: "e2", seq: 41, kind: "message", text: "b", at: ACTIVITY_AT },
      ],
    }));
    const backendMore = makeBackend(rosterBots, { chat: withMore });
    const more = (await handleGrokBot(session({}), "grokbot.read", { bot: "Alpha" }, backendMore)) as {
      nextBefore?: number;
      moreBefore: boolean;
    };
    expect(more.moreBefore).toBe(true);
    expect(more.nextBefore).toBe(42);

    const withoutMore = vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "bot-alpha",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: 1,
      moreBefore: false,
      entries: [{ id: "e1", seq: 1, kind: "message", text: "a", at: ACTIVITY_AT }],
    }));
    const backendNo = makeBackend(rosterBots, { chat: withoutMore });
    const no = (await handleGrokBot(session({}), "grokbot.read", { bot: "Alpha" }, backendNo)) as {
      nextBefore?: number;
    };
    expect(no).not.toHaveProperty("nextBefore");
  });

  it("returns empty entries without calling chat when hasChat is false", async () => {
    const chat = vi.fn();
    const backend = makeBackend(rosterBots, { chat });
    const result = (await handleGrokBot(session({}), "grokbot.read", { bot: "No Chat" }, backend)) as {
      total: number;
      entries: unknown[];
      note: string;
    };
    expect(chat).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
    expect(result.note).toContain("no saved chat");
  });

  it("maps entry at to ISO and includes streaming, truncated, toAgent, role only when set", async () => {
    const chat = vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "bot-alpha",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: 2,
      moreBefore: false,
      entries: [
        {
          id: "e-full",
          seq: 1,
          kind: "message",
          role: "user",
          text: "hi",
          at: ACTIVITY_AT,
          streaming: true,
          truncated: true,
          toAgent: "claude",
        },
        {
          id: "e-min",
          seq: 2,
          kind: "event",
          text: null,
          at: null,
        },
      ],
    }));
    const backend = makeBackend(rosterBots, { chat });
    const result = (await handleGrokBot(session({}), "grokbot.read", { bot: "Alpha" }, backend)) as {
      entries: Record<string, unknown>[];
    };
    const full = result.entries[0];
    expect(full.at).toBe(new Date(ACTIVITY_AT).toISOString());
    expect(full.role).toBe("user");
    expect(full.streaming).toBe(true);
    expect(full.truncated).toBe(true);
    expect(full.toAgent).toBe("claude");

    const min = result.entries[1];
    expect(min.at).toBeNull();
    expect(min).not.toHaveProperty("role");
    expect(min).not.toHaveProperty("streaming");
    expect(min).not.toHaveProperty("truncated");
    expect(min).not.toHaveProperty("toAgent");
  });

  it("says who each entry is from", async () => {
    const kinds: [string, string | undefined][] = [
      ["message", "user"],
      ["message", "assistant"],
      ["send-message", undefined],
      ["user-attachment", undefined],
      ["event", undefined],
      ["notice", undefined],
    ];
    const chat = vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "bot-alpha",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: kinds.length,
      moreBefore: false,
      entries: kinds.map(([kind, role], seq) => ({ id: `e${seq}`, seq, kind, role, text: "x", at: null })),
    }));
    const backend = makeBackend(rosterBots, { chat });
    const result = (await handleGrokBot(session({}), "grokbot.read", { bot: "Alpha" }, backend)) as {
      entries: { from: string }[];
    };
    expect(result.entries.map((entry) => entry.from)).toEqual(["user", "bot", "bot", "user", "system", "system"]);
  });
});

describe("grokbot.draft", () => {
  it("calls backend.open with trimmed text, worktreeCwd or cwd, and bot id", async () => {
    const open = vi.fn(async () => undefined);
    const backend = makeBackend(rosterBots, { open, now: FIXED_NOW });
    const sessWorktree = session({ cwd: "/repo", worktreeCwd: "/repo/wt" });
    await handleGrokBot(sessWorktree, "grokbot.draft", { bot: "Alpha", text: "  draft me  " }, backend);
    expect(open).toHaveBeenCalledWith("draft me", "/repo/wt", "bot-alpha");

    const sessCwd = session({ cwd: "/only-cwd", worktreeCwd: undefined });
    await handleGrokBot(sessCwd, "grokbot.draft", { bot: "Alpha", text: "x" }, backend);
    expect(open).toHaveBeenLastCalledWith("x", "/only-cwd", "bot-alpha");
  });

  it("returns since as ISO of backend.now before open and sent false", async () => {
    let openResolve!: () => void;
    const openDeferred = new Promise<void>((resolve) => {
      openResolve = resolve;
    });
    const open = vi.fn(() => openDeferred);
    const backend = makeBackend(rosterBots, { open, now: FIXED_NOW });
    const promise = handleGrokBot(session({}), "grokbot.draft", { bot: "Alpha", text: "hi" }, backend);
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    openResolve();
    const result = (await promise) as { since: string; sent: boolean; placed: boolean };
    expect(result.since).toBe(new Date(FIXED_NOW).toISOString());
    expect(result.sent).toBe(false);
    expect(result.placed).toBe(true);
    expect(backend.now).toHaveBeenCalled();
  });

  it("throws on empty text", async () => {
    const backend = makeBackend(rosterBots);
    await expect(handleGrokBot(session({}), "grokbot.draft", { bot: "Alpha", text: "   " }, backend)).rejects.toThrow(
      "text must be a non-empty string",
    );
    await expect(handleGrokBot(session({}), "grokbot.draft", { bot: "Alpha", text: "" }, backend)).rejects.toThrow(
      "text must be a non-empty string",
    );
  });

  it("allows 500 emoji but rejects 501 UTF-16 units", async () => {
    const backend = makeBackend(rosterBots);
    const ok = "😀".repeat(500);
    expect(ok.length).toBe(1000);
    await expect(
      handleGrokBot(session({}), "grokbot.draft", { bot: "Alpha", text: ok }, backend),
    ).resolves.toBeDefined();

    const tooLong = "😀".repeat(501);
    expect(tooLong.length).toBeGreaterThan(GROK_BOT_PROMPT_LIMIT);
    await expect(
      handleGrokBot(session({}), "grokbot.draft", { bot: "Alpha", text: tooLong }, backend),
    ).rejects.toThrow(String(GROK_BOT_PROMPT_LIMIT));
  });

  it("propagates errors from open", async () => {
    const open = vi.fn(async () => {
      throw new Error("link failed");
    });
    const backend = makeBackend(rosterBots, { open });
    await expect(
      handleGrokBot(session({}), "grokbot.draft", { bot: "Alpha", text: "hi" }, backend),
    ).rejects.toThrow("link failed");
  });
});

describe("grokbot.run", () => {
  it("rejects a codex harness and an mcp- session id before calling any backend method", async () => {
    const quiet = makeBackend(rosterBots);
    const codex = session({ harness: "codex" });
    await expect(
      handleGrokBot(codex, "grokbot.run", { bot: "Alpha", text: "hi" }, quiet),
    ).rejects.toThrow("only Claude sessions");

    const mcp = session({ id: "mcp-tool-1", harness: "claude" });
    await expect(
      handleGrokBot(mcp, "grokbot.run", { bot: "Alpha", text: "hi" }, quiet),
    ).rejects.toThrow("only Claude sessions");

    expect(quiet.status).not.toHaveBeenCalled();
    expect(quiet.roster).not.toHaveBeenCalled();
    expect(quiet.webhooks).not.toHaveBeenCalled();
    expect(quiet.run).not.toHaveBeenCalled();
    expect(quiet.requestId).not.toHaveBeenCalled();
    expect(quiet.now).not.toHaveBeenCalled();
  });

  it("checks the folder policy first and throws without calling roster, webhooks or run", async () => {
    const blocked = makeBackend(rosterBots, {
      status: vi.fn(async () => ({ installed: true, allowed: false, policy: "confidential" })),
    });
    const claude = session({ harness: "claude", cwd: "/client" });
    await expect(
      handleGrokBot(claude, "grokbot.run", { bot: "Alpha", text: "hi" }, blocked),
    ).rejects.toThrow("privacy policy is confidential");

    expect(blocked.status).toHaveBeenCalledWith("/client");
    expect(blocked.roster).not.toHaveBeenCalled();
    expect(blocked.webhooks).not.toHaveBeenCalled();
    expect(blocked.run).not.toHaveBeenCalled();
  });

  it("throws a message naming the bot and mentioning grokbot.draft when bot has no webhook", async () => {
    const backend = makeBackend(rosterBots);
    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: "hi" }, backend),
    ).rejects.toThrow("Alpha has no webhook yet");
    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: "hi" }, backend),
    ).rejects.toThrow("grokbot.draft");

    expect(backend.run).not.toHaveBeenCalled();
  });

  it("runs the bot through webhook on happy path with worktreeCwd or cwd, outcome started, requestId, since, bot, and note", async () => {
    let nowCalledBeforeRun = false;
    let backend!: ReturnType<typeof makeBackend>;
    const run = vi.fn(async () => {
      nowCalledBeforeRun = backend.now.mock.calls.length > 0;
      return { outcome: "started" as const, status: 200, detail: null };
    });
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    backend = makeBackend(rosterBots, { webhooks, run, now: FIXED_NOW });

    const sessWorktree = session({ cwd: "/repo", worktreeCwd: "/repo/wt" });
    const result = (await handleGrokBot(
      sessWorktree,
      "grokbot.run",
      { bot: "Alpha", text: "  start task  " },
      backend,
    )) as {
      outcome: string;
      requestId: string;
      since: string;
      bot: { id: string; name: string };
      note: string;
    };

    expect(backend.run).toHaveBeenCalledWith("bot-alpha", "start task", "mc-test1234", "/repo/wt");
    expect(nowCalledBeforeRun).toBe(true);
    expect(backend.now).toHaveBeenCalled();
    expect(result).toEqual({
      bot: { id: "bot-alpha", name: "Alpha" },
      outcome: "started",
      requestId: "mc-test1234",
      since: new Date(FIXED_NOW).toISOString(),
      note: expect.stringContaining("grokbot.read"),
    });

    const sessCwd = session({ cwd: "/only-cwd", worktreeCwd: undefined });
    await handleGrokBot(sessCwd, "grokbot.run", { bot: "Alpha", text: "x" }, backend);
    expect(backend.run).toHaveBeenLastCalledWith("bot-alpha", "x", "mc-test1234", "/only-cwd");
  });

  it("returns outcome unknown and a note that it may or may not have started when backend outcome is unknown", async () => {
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    const run = vi.fn(async () => ({ outcome: "unknown" as const, status: null, detail: null }));
    const backend = makeBackend(rosterBots, { webhooks, run });

    const result = (await handleGrokBot(
      session({}),
      "grokbot.run",
      { bot: "Alpha", text: "hi" },
      backend,
    )) as { outcome: string; note: string };

    expect(result.outcome).toBe("unknown");
    expect(result.note).toContain("may or may not have started");
  });

  it("puts the backend's detail in front of the note when the outcome is unknown", async () => {
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    const detail = "Grok Bot answered HTTP 503, so the run may or may not have started.";
    const run = vi.fn(async () => ({ outcome: "unknown" as const, status: 503, detail }));
    const backend = makeBackend(rosterBots, { webhooks, run });

    const result = (await handleGrokBot(
      session({}),
      "grokbot.run",
      { bot: "Alpha", text: "hi" },
      backend,
    )) as { outcome: string; note: string };

    expect(result.outcome).toBe("unknown");
    expect(result.note.startsWith(`${detail} Grok Bot didn't confirm`)).toBe(true);
  });

  it("propagates an error thrown by run unchanged", async () => {
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    const customError = new Error("network timeout");
    const run = vi.fn(async () => {
      throw customError;
    });
    const backend = makeBackend(rosterBots, { webhooks, run });

    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: "hi" }, backend),
    ).rejects.toThrow(customError);
  });

  it("throws on empty or whitespace text, accepts GROK_BOT_RUN_LIMIT emoji code points, and rejects one more", async () => {
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    const backend = makeBackend(rosterBots, { webhooks });

    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: "" }, backend),
    ).rejects.toThrow("text must be a non-empty string");
    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: "   \t\n  " }, backend),
    ).rejects.toThrow("text must be a non-empty string");

    const okEmoji = "🚀".repeat(GROK_BOT_RUN_LIMIT);
    expect(okEmoji.length).toBe(GROK_BOT_RUN_LIMIT * 2);
    expect([...okEmoji].length).toBe(GROK_BOT_RUN_LIMIT);
    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: okEmoji }, backend),
    ).resolves.toBeDefined();

    const tooLongEmoji = "🚀".repeat(GROK_BOT_RUN_LIMIT + 1);
    expect([...tooLongEmoji].length).toBe(GROK_BOT_RUN_LIMIT + 1);
    await expect(
      handleGrokBot(session({}), "grokbot.run", { bot: "Alpha", text: tooLongEmoji }, backend),
    ).rejects.toThrow(String(GROK_BOT_RUN_LIMIT));
  });

  it("still runs when Grok Bot is not installed locally if allowed is true", async () => {
    const webhooks = vi.fn(async () => [
      { botId: "bot-alpha", host: "grok.test", addedAt: 1, lastRunAt: null },
    ]);
    const backend = makeBackend(rosterBots, {
      webhooks,
      status: vi.fn(async () => ({ installed: false, allowed: true, policy: "personal" })),
    });

    const result = (await handleGrokBot(
      session({}),
      "grokbot.run",
      { bot: "Alpha", text: "cloud run" },
      backend,
    )) as { outcome: string };

    expect(result.outcome).toBe("started");
    expect(backend.run).toHaveBeenCalled();
  });
});

describe("unknown action", () => {
  it("throws", async () => {
    const backend = makeBackend(rosterBots);
    await expect(handleGrokBot(session({}), "grokbot.nope", {}, backend)).rejects.toThrow(
      "Unknown app action: grokbot.nope",
    );
  });
});

describe("limits", () => {
  it("rejects a since past the safe integer range and clamps old spans to zero", () => {
    expect(() => parseSince(1e19, FIXED_NOW)).toThrow("since must be");
    expect(parseSince("999999w", FIXED_NOW)).toBe(0);
  });

  it("returns null times for out-of-range timestamps instead of failing", async () => {
    const backend = makeBackend([bot({ id: "bot-far", name: "Far", lastActivityAt: 9.2e18 })]);
    const result = (await handleGrokBot(session({}), "grokbot.list", {}, backend)) as {
      bots: { lastActivity: string | null }[];
    };
    expect(result.bots[0].lastActivity).toBeNull();
  });

  it("pages out older entries once a read passes the text budget", async () => {
    const big = "x".repeat(20_000);
    const chat = vi.fn(async (): Promise<GrokBotChat> => ({
      botId: "bot-alpha",
      schemaVersion: 1,
      persistedAt: SAVED_AT,
      total: 200,
      moreBefore: false,
      entries: Array.from({ length: 200 }, (_, seq) => ({ id: `e${seq}`, seq, kind: "message", role: "user", text: big, at: null })),
    }));
    const backend = makeBackend(rosterBots, { chat });
    const result = (await handleGrokBot(session({}), "grokbot.read", { bot: "Alpha", limit: 200, maxChars: 20_000 }, backend)) as {
      entries: { seq: number }[];
      moreBefore: boolean;
      nextBefore?: number;
    };
    expect(result.entries.length).toBeLessThan(200);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[result.entries.length - 1].seq).toBe(199);
    expect(result.moreBefore).toBe(true);
    expect(result.nextBefore).toBe(result.entries[0].seq);
    expect(JSON.stringify(result).length).toBeLessThan(4_000_000);
  });
});
