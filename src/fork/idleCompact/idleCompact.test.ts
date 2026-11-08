// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { newSession, type Session } from "../../features/sessions/model/session";
import {
  CLAUDE_CACHE_TTL_MS,
  earlyCompactDue,
  EARLY_COMPACT_MS,
  IDLE_COMPACT_THRESHOLD,
  lastTurnEnd,
  noteCompacted,
  noteEarlyCompactTried,
  noteTurnEnded,
  resetIdleCompactForTests,
  saveIdleCompactMode,
  setKeepHistory,
  showCompactChip,
  takeCompactBeforeSend,
} from "./idleCompact";

const T0 = 1_800_000_000_000;

function thread(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/repo"),
    id: "s1",
    providerSessionId: "claude-abc",
    context: { used: IDLE_COMPACT_THRESHOLD + 30_000, window: 1_000_000 },
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetIdleCompactForTests();
});

describe("Compact chip", () => {
  it("shows only after the cache has run out on a big idle Claude thread", () => {
    noteTurnEnded("s1", T0);
    expect(showCompactChip(thread(), T0 + CLAUDE_CACHE_TTL_MS - 1)).toBe(false);
    expect(showCompactChip(thread(), T0 + CLAUDE_CACHE_TTL_MS)).toBe(true);
  });

  it("stays away for small, busy, non-Claude or unseen threads", () => {
    const later = T0 + CLAUDE_CACHE_TTL_MS * 2;
    noteTurnEnded("s1", T0);
    expect(showCompactChip(thread({ context: { used: 50_000 } }), later)).toBe(false);
    expect(showCompactChip(thread({ busy: true }), later)).toBe(false);
    expect(showCompactChip(thread({ harness: "codex" }), later)).toBe(false);
    expect(showCompactChip(thread({ providerSessionId: undefined }), later)).toBe(false);
    expect(showCompactChip(thread({ id: "never-seen" }), later)).toBe(false);
  });

  it("is off in Never mode", () => {
    noteTurnEnded("s1", T0);
    saveIdleCompactMode("never");
    expect(showCompactChip(thread(), T0 + CLAUDE_CACHE_TTL_MS * 2)).toBe(false);
  });

  it("Keep sends one message with the full history, then compacts again", () => {
    noteTurnEnded("s1", T0);
    const later = T0 + CLAUDE_CACHE_TTL_MS * 2;
    setKeepHistory("s1", true);
    expect(takeCompactBeforeSend(thread(), later)).toBe(false);
    expect(takeCompactBeforeSend(thread(), later)).toBe(true);
  });

  it("remembers turn ends across a reload", () => {
    noteTurnEnded("s1", T0);
    resetIdleCompactForTests(); // drops the in-memory copy only
    expect(lastTurnEnd("s1")).toBe(T0);
  });
});

describe("After a compaction", () => {
  it("counts as compacted until a real turn reports new usage", () => {
    saveIdleCompactMode("before-expiry");
    const used = IDLE_COMPACT_THRESHOLD + 30_000;
    noteCompacted("s1", used);
    noteTurnEnded("s1", T0);
    expect(showCompactChip(thread(), T0 + CLAUDE_CACHE_TTL_MS * 2)).toBe(false);
    expect(earlyCompactDue(thread(), T0 + CLAUDE_CACHE_TTL_MS - 60_000)).toBe(false);
    const grown = thread({ context: { used: used + 5_000 } });
    expect(showCompactChip(grown, T0 + CLAUDE_CACHE_TTL_MS * 2)).toBe(true);
  });

  it("leaves queued or background-task threads alone", () => {
    noteTurnEnded("s1", T0);
    const later = T0 + CLAUDE_CACHE_TTL_MS * 2;
    expect(showCompactChip(thread({ backgroundTasks: ["dev server"] }), later)).toBe(false);
    expect(
      showCompactChip(thread({ queuedMessages: [{ id: "q", text: "hi", attachments: [] }] }), later),
    ).toBe(false);
  });
});

describe("Before the cache runs out", () => {
  it("is due in the last minutes of the cache, once per idle stretch", () => {
    saveIdleCompactMode("before-expiry");
    noteTurnEnded("s1", T0);
    const due = T0 + CLAUDE_CACHE_TTL_MS - EARLY_COMPACT_MS + 1_000;
    expect(earlyCompactDue(thread(), due - 2_000)).toBe(false);
    expect(earlyCompactDue(thread(), due)).toBe(true);
    noteEarlyCompactTried("s1");
    expect(earlyCompactDue(thread(), due + 1_000)).toBe(false);
    // A new turn starts a new idle stretch.
    noteTurnEnded("s1", T0 + 10_000);
    expect(earlyCompactDue(thread(), due + 10_000)).toBe(true);
  });

  it("never fires once the cache has run out, or in the default mode", () => {
    noteTurnEnded("s1", T0);
    const due = T0 + CLAUDE_CACHE_TTL_MS - 60_000;
    expect(earlyCompactDue(thread(), due)).toBe(false);
    saveIdleCompactMode("before-expiry");
    expect(earlyCompactDue(thread(), T0 + CLAUDE_CACHE_TTL_MS + 1)).toBe(false);
  });
});
