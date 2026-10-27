// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import {
  announceSessionFinished,
  announceSessionInput,
  saveNotificationsEnabled,
} from "../../features/notifications/model/notifications";
import { updateNotificationPreferences } from "../../features/notifications/model/notificationPreferences";
import { markNotificationsRead, notificationHistorySnapshot } from "./notificationStore";
import { NotificationPopups, POPUP_MS } from "./NotificationPopups";

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  emit.mockReset().mockResolvedValue(undefined);
  emitTo.mockReset().mockResolvedValue(undefined);
  listen.mockReset().mockResolvedValue(() => {});
  invoke.mockReset().mockResolvedValue(undefined);
  saveNotificationsEnabled(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(NotificationPopups)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function session(id = "popup-session", reply = "Ready for review.") {
  return {
    ...newSession("codex", "/fixture/project"),
    id,
    blocks: [
      { id: "turn-1", role: "user" as const, text: "Check this" },
      { id: `reply-${reply}`, role: "assistant" as const, text: reply },
    ],
  };
}

const popups = () => document.querySelectorAll("[data-fork-notification-popup]");

it("pops up a new event from a session that is not on screen, once", async () => {
  await act(() => announceSessionFinished(session(), true));
  expect(popups()).toHaveLength(0);
  expect(notificationHistorySnapshot()).toHaveLength(1);

  await act(() => announceSessionInput(session("asks"), { kind: "question", requestId: 3 }, false));
  await act(() => announceSessionInput(session("asks"), { kind: "question", requestId: 3 }, false));
  expect(popups()).toHaveLength(1);
  expect(document.body.textContent).toContain("Question");
});

it("hides after a few seconds but stays in the bell; hovering keeps it open", async () => {
  await act(() => announceSessionFinished(session(), false));
  const card = popups()[0].closest("article")!;
  act(() => card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  act(() => vi.advanceTimersByTime(POPUP_MS.finished + 1000));
  expect(popups()).toHaveLength(1);
  act(() => card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  act(() => vi.advanceTimersByTime(POPUP_MS.finished));
  expect(popups()).toHaveLength(0);
  expect(notificationHistorySnapshot()[0].readAt).toBeFalsy();
});

it("goes when read from the bell, and stays quiet for muted projects", async () => {
  await act(() => announceSessionFinished(session(), false));
  act(() => markNotificationsRead([notificationHistorySnapshot()[0].id]));
  expect(popups()).toHaveLength(0);

  updateNotificationPreferences([notificationHistorySnapshot()[0].projectId], { mutedUntil: null });
  await act(() => announceSessionFinished(session("other", "Done again."), false));
  expect(notificationHistorySnapshot()).toHaveLength(2);
  expect(popups()).toHaveLength(0);
});
