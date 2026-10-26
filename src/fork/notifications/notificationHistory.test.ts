// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import { notificationText } from "../../features/notifications/model/notifications";
import {
  HISTORY_LIMIT,
  HISTORY_PREFIX,
  NotificationHistory,
  historyNotification,
} from "./notificationHistory";
import type { NotificationEvent } from "../../features/notifications/model/notifications";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

beforeEach(() => {
  localStorage.clear();
});

function sample(
  turn = "turn-1",
  event: NotificationEvent = "finished",
  at = 1000,
) {
  const session = {
    ...newSession("codex", "/fixture/monocode"),
    id: "session-1",
    title: "Check keyboard navigation",
    blocks: [
      { id: turn, role: "user" as const, text: "Check navigation" },
      {
        id: "answer",
        role: "assistant" as const,
        text: "The keyboard checks passed.",
      },
    ],
  };
  return historyNotification(
    session,
    event,
    notificationText(session, event),
    "local:/fixture/monocode",
    at,
  )!;
}

describe("notification history", () => {
  it("starts empty and does not manufacture a completion for a session without a submitted turn", () => {
    const history = new NotificationHistory(() => localStorage);
    const session = newSession("codex", "/fixture/monocode");
    expect(history.getSnapshot()).toEqual([]);
    expect(
      historyNotification(
        session,
        "finished",
        notificationText(session, "finished"),
        "project",
        10,
      ),
    ).toBeNull();
  });

  it("deduplicates a completed turn without resetting its read state", () => {
    const history = new NotificationHistory(() => localStorage);
    const entry = sample();
    expect(history.record(entry)).toBe(true);
    history.markRead([entry.id], 1500);
    expect(history.record({ ...entry, occurredAt: 2000 })).toBe(false);
    expect(history.getSnapshot()).toEqual([{ ...entry, readAt: 1500 }]);
    expect(history.record(sample("turn-2", "finished", 3000))).toBe(true);
    expect(history.getSnapshot()).toHaveLength(2);
  });

  it("keeps question and approval requests distinct within and across turns", () => {
    const history = new NotificationHistory(() => localStorage);
    for (const entry of [
      sample("turn-1", { kind: "question", requestId: 1 }),
      sample("turn-1", { kind: "question", requestId: 2 }),
      sample("turn-1", { kind: "approval", requestId: 1 }),
      sample("turn-2", { kind: "question", requestId: 1 }),
    ]) {
      history.record(entry);
    }
    expect(history.getSnapshot()).toHaveLength(4);
    expect(
      history.getSnapshot().filter((row) => row.kind === "approval"),
    ).toHaveLength(1);
  });

  it("merges independent windows and preserves cross-window read markers", () => {
    const first = new NotificationHistory(() => localStorage);
    const second = new NotificationHistory(() => localStorage);
    first.getSnapshot();
    second.getSnapshot();
    const one = sample("first", "finished", 1000);
    const two = sample("second", "finished", 2000);
    first.record(one);
    second.record(two);
    second.markRead([one.id], 2500);
    expect(first.getSnapshot().map((row) => row.id)).toEqual([two.id, one.id]);
    expect(first.getSnapshot()[1].readAt).toBe(2500);
    expect(new NotificationHistory(() => localStorage).getSnapshot()).toEqual(
      first.getSnapshot(),
    );
  });

  it("bounds persisted events and prunes their read markers", () => {
    const history = new NotificationHistory(() => localStorage);
    const oldest = sample("old", "finished", 1);
    history.record(oldest);
    history.markRead([oldest.id], 2);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      history.record(sample(`turn-${i}`, "finished", i + 10));
    }
    expect(history.getSnapshot()).toHaveLength(HISTORY_LIMIT);
    expect(localStorage.length).toBe(HISTORY_LIMIT);
    expect(history.getSnapshot()[0].occurredAt).toBe(HISTORY_LIMIT + 14);
  });

  it("does not prune an event another window inserts after the key snapshot", () => {
    const local = sample("local-window", "finished", 1000);
    const remote = sample("remote-window", "finished", 2000);
    const localKey = `${HISTORY_PREFIX}event.${encodeURIComponent(local.id)}`;
    const remoteKey = `${HISTORY_PREFIX}event.${encodeURIComponent(remote.id)}`;
    let inserted = false;
    const storage: Storage = {
      get length() {
        return localStorage.length;
      },
      key: (index) => localStorage.key(index),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
      clear: () => localStorage.clear(),
      getItem: (key) => {
        const value = localStorage.getItem(key);
        if (key === localKey && value && !inserted) {
          inserted = true;
          localStorage.setItem(remoteKey, JSON.stringify(remote));
        }
        return value;
      },
    };
    const history = new NotificationHistory(() => storage);
    history.record(local);
    expect(inserted).toBe(true);
    expect(localStorage.getItem(remoteKey)).not.toBeNull();
    expect(history.getSnapshot().map((row) => row.id)).toEqual([
      remote.id,
      local.id,
    ]);
  });

  it("keeps 120 events when another writer shifts storage indices during retention", () => {
    const other = new NotificationHistory(() => localStorage);
    for (let i = 1; i <= HISTORY_LIMIT; i++) {
      other.record(sample(`event-${i}`, "finished", i));
    }
    let enumeration = 0;
    let interleaved = false;
    const insertOther = () => {
      interleaved = true;
      other.record(sample("event-122", "finished", 122));
    };
    const storage: Storage = {
      get length() {
        return localStorage.length;
      },
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
      clear: () => localStorage.clear(),
      key: (index) => {
        if (index === 0) {
          enumeration++;
        }
        // Writer B removes events 1–2 after A reads index 0; index 1 now
        // refers to event 4. A must never treat skipped event 3 as stale.
        if (enumeration === 2 && index === 1 && !interleaved) {
          insertOther();
        }
        return localStorage.key(index);
      },
    };
    const first = new NotificationHistory(() => storage);
    first.record(sample("event-121", "finished", 121));
    // The fixed writer has no second enumeration, so B runs immediately after A.
    if (!interleaved) {
      insertOther();
    }
    expect(localStorage.length).toBe(HISTORY_LIMIT);
    expect(other.getSnapshot().map((row) => row.occurredAt)).toEqual(
      Array.from({ length: HISTORY_LIMIT }, (_, index) => 122 - index),
    );
  });

  it("ignores malformed entries and retains a bounded memory fallback when storage is unavailable", () => {
    localStorage.setItem(`${HISTORY_PREFIX}event.bad`, '{"occurredAt":1e300}');
    const history = new NotificationHistory(() => localStorage);
    expect(history.getSnapshot()).toEqual([]);
    const unavailable = new NotificationHistory(() => {
      throw new Error("Storage denied");
    });
    unavailable.record(sample());
    unavailable.markRead([sample().id], 2000);
    expect(unavailable.getSnapshot()[0].readAt).toBe(2000);
  });

  it("returns stable snapshots until stored content changes", () => {
    const history = new NotificationHistory(() => localStorage);
    history.record(sample());
    const first = history.getSnapshot();
    expect(history.getSnapshot()).toBe(first);
    history.markRead([first[0].id], 2000);
    expect(history.getSnapshot()).not.toBe(first);
  });
});
