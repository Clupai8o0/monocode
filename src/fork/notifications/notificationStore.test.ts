// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import {
  announceSessionFinished,
  announceSessionInput,
  saveNotificationsEnabled,
} from "../../features/notifications/model/notifications";
import {
  notificationHistorySnapshot,
  openHistoryNotification,
  subscribeNotificationHistory,
} from "./notificationStore";
import { HISTORY_PREFIX, NotificationHistory } from "./notificationHistory";
import { OPEN_SESSION_EVENT } from "../workspaces/workspaces";

const { emit, emitTo, listen, invoke } = vi.hoisted(() => ({
  emit: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit, emitTo, listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "source-workspace" }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../features/settings/model/sounds", () => ({
  playCue: vi.fn(),
  loadSoundsEnabled: () => false,
}));

beforeEach(() => {
  localStorage.clear();
  emit.mockReset().mockResolvedValue(undefined);
  emitTo.mockReset().mockResolvedValue(undefined);
  listen.mockReset().mockResolvedValue(() => {});
  invoke.mockReset().mockResolvedValue(undefined);
  saveNotificationsEnabled(false);
});

function session() {
  return {
    ...newSession("codex", "/fixture/project"),
    id: "notification-session",
    blocks: [
      { id: "turn-1", role: "user" as const, text: "Check this" },
      { id: "reply", role: "assistant" as const, text: "Ready for review." },
    ],
  };
}

it("records actual finish and input announcements with OS notifications disabled", async () => {
  await announceSessionFinished(session(), true);
  await announceSessionInput(
    session(),
    { kind: "question", requestId: 9 },
    true,
  );
  expect(
    notificationHistorySnapshot()
      .map((row) => row.kind)
      .sort(),
  ).toEqual(["finished", "question"]);
  expect(
    invoke.mock.calls.some(([command]) => command === "show_notification"),
  ).toBe(false);
});

it("targets the source window's history opener for saved sessions, then marks read", async () => {
  await announceSessionFinished(session(), false);
  const row = notificationHistorySnapshot()[0];
  await openHistoryNotification(row);
  expect(emitTo).toHaveBeenCalledWith(
    "source-workspace",
    OPEN_SESSION_EVENT,
    row.sessionId,
  );
  expect(notificationHistorySnapshot()[0].readAt).toBeGreaterThan(0);
});

it("keeps a failed open unread", async () => {
  await announceSessionFinished(session(), false);
  const row = notificationHistorySnapshot()[0];
  emitTo.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(openHistoryNotification(row)).rejects.toThrow("Disconnected");
  expect(notificationHistorySnapshot()[0].readAt).toBeUndefined();
});

it("broadcasts local changes and reacts to another window's storage updates", async () => {
  const changed = vi.fn();
  const stop = subscribeNotificationHistory(changed);
  await announceSessionFinished(session(), false);
  expect(changed).toHaveBeenCalled();
  changed.mockClear();
  const remote = new NotificationHistory(() => localStorage);
  remote.record({
    ...notificationHistorySnapshot()[0],
    id: "remote-turn",
    occurredAt: Date.now() + 1000,
  });
  window.dispatchEvent(
    new StorageEvent("storage", { key: `${HISTORY_PREFIX}event.remote` }),
  );
  expect(changed).toHaveBeenCalledOnce();
  stop();
  changed.mockClear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(changed).not.toHaveBeenCalled();
});

it("serves React snapshots from memory without rescanning storage", async () => {
  await announceSessionFinished(session(), false);
  const keys = vi.spyOn(Storage.prototype, "key");
  try {
    const snapshot = notificationHistorySnapshot();
    for (let i = 0; i < 100; i++) {
      expect(notificationHistorySnapshot()).toBe(snapshot);
    }
    expect(keys).not.toHaveBeenCalled();
  } finally {
    keys.mockRestore();
  }
});
