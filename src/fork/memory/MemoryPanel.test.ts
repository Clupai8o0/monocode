// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const park = vi.hoisted(() => vi.fn(async (_id: string) => true));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("../../integrations/harness/core/registry", () => ({
  harnessIdleSince: (id: string) => (id === "idle" ? Date.now() - 20 * 60_000 : undefined),
  parkIdleHarnessSession: park,
}));

import { newSession } from "../../features/sessions/model/session";
import { MemoryPanel } from "./MemoryPanel";
import { MemoryWatcher } from "./MemoryWatcher";
import { buildRows, suggestParks, type MemoryReport } from "./memoryModel";
import {
  memorySettings,
  parkedSessions,
  resetMemoryStores,
  setMemorySettings,
} from "./memoryStore";

const GB = 1024 ** 3;
const report: MemoryReport = {
  pressure: "critical",
  totalBytes: 16 * GB,
  availableBytes: 1 * GB,
  sessions: [
    { sessionId: "idle", rssBytes: 1.2 * GB, processCount: 3 },
    { sessionId: "busy", rssBytes: 2 * GB, processCount: 1 },
  ],
};

function session(id: string, title: string, busy = false) {
  return { ...newSession("claude", "/repo"), id, title, busy };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetMemoryStores();
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  invoke.mockReset();
  park.mockClear();
  vi.unstubAllGlobals();
});

describe("memory popover", () => {
  it("lists sessions by RAM with Park only on idle ones, the suggestion and parked sessions", () => {
    const now = Date.now();
    const rows = buildRows(
      report,
      new Map([
        ["idle", { id: "idle", title: "Refactor", busy: false, needsInput: false, foreground: false, idleSince: now - 20 * 60_000 }],
        ["busy", { id: "busy", title: "Build", busy: true, needsInput: false, foreground: false }],
      ]),
      now,
    );
    const onPark = vi.fn();
    const onParkSuggested = vi.fn();
    act(() =>
      root.render(
        createElement(MemoryPanel, {
          report,
          rows,
          suggestion: suggestParks(rows, report),
          parked: [{ sessionId: "old", title: "Old chat", freedBytes: GB, parkedAt: now }],
          parking: new Set(),
          onPark,
          onParkSuggested,
        }),
      ),
    );
    const items = [...container.querySelectorAll("[data-memory-session]")];
    expect(items.map((item) => item.getAttribute("data-memory-session"))).toEqual(["busy", "idle"]);
    expect(items[0].textContent).toContain("Working");
    expect(items[0].querySelector("button")).toBeNull();
    expect(items[1].textContent).toContain("1.2 GB · 3 processes · idle 20 min");

    const suggested = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Park suggested"),
    )!;
    expect(suggested.textContent).toBe("Park suggested (1, frees ~1.2 GB)");
    act(() => suggested.click());
    expect(onParkSuggested).toHaveBeenCalled();

    act(() => (container.querySelector('[aria-label="Park Refactor"]') as HTMLButtonElement).click());
    expect(onPark).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "idle" }));
    expect(container.textContent).toContain("Old chat");
    expect(container.textContent).toContain("Parked — wakes on your next message");
    expect(container.textContent).toContain("Memory is very tight");
  });

  it("shows the footer chip, parks from the popover and never parks on its own by default", async () => {
    expect(memorySettings().autoPark).toBe(false);
    invoke.mockImplementation(async (command: string) => {
      if (command === "fork_memory_report") {
        // A parked session's process is gone from the next report.
        const gone = new Set(park.mock.calls.map(([id]) => id));
        return { ...report, sessions: report.sessions.filter((row) => !gone.has(row.sessionId)) };
      }
      throw new Error(command);
    });
    const footer = document.createElement("span");
    document.body.append(footer);
    const sessions = { current: [session("idle", "Refactor"), session("busy", "Build", true)] };
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(
          createElement(MemoryWatcher, {
            sessions,
            isForeground: () => false,
            chipHost: footer,
          }),
        );
      });
      // Several minutes of critical pressure: with the setting off, nothing parks.
      await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
      expect(park).not.toHaveBeenCalled();

      const chip = footer.querySelector("[data-fork-memory]") as HTMLButtonElement;
      expect(chip.textContent).toBe("Memory · 3.2 GB");
      await act(async () => chip.click());
      const button = document.querySelector('[aria-label="Park Refactor"]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      expect(document.querySelector('[aria-label="Park Build"]')).toBeNull();
      await act(async () => button.click());
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(park).toHaveBeenCalledWith("idle");
      expect(parkedSessions().has("idle")).toBe(true);
      expect(document.body.textContent).toContain("Parked — wakes on your next message");
    } finally {
      vi.useRealTimers();
    }
  });

  it("with auto-park on, parks the idle session after a minute of pressure and says so quietly", async () => {
    setMemorySettings({ autoPark: true, idleMinutes: 10 });
    invoke.mockImplementation(async (command: string) => {
      if (command === "fork_memory_report") {
        const gone = new Set(park.mock.calls.map(([id]) => id));
        return { ...report, sessions: report.sessions.filter((row) => !gone.has(row.sessionId)) };
      }
      throw new Error(command);
    });
    const footer = document.createElement("span");
    document.body.append(footer);
    const sessions = { current: [session("idle", "Refactor"), session("busy", "Build", true)] };
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(createElement(MemoryWatcher, { sessions, isForeground: () => false, chipHost: footer }));
      });
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(park).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(45_000));
      expect(park.mock.calls).toEqual([["idle"]]);
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Parked 1 idle session · frees ~1.2 GB",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
