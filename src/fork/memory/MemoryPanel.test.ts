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
  harnessIdleSince: (id: string) => (id === "idle" ? Date.now() - 2 * 60_000 : undefined),
  parkIdleHarnessSession: park,
}));

import { newSession } from "../../features/sessions/model/session";
import { MemoryPanel } from "./MemoryPanel";
import { MemoryWatcher } from "./MemoryWatcher";
import { openMachines, pickMachineTab, resetMachines, setMachinesHost } from "../machines/machinesStore";
import { buildRows, suggestParks, totalSessionBytes, type MemoryReport } from "./memoryModel";
import {
  memorySettings,
  parkedSessions,
  refreshMemorySettings,
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
  resetMachines();
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
          total: totalSessionBytes(rows),
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

      // The Machines chip's popover gives the Memory tab somewhere to draw.
      const tab = document.createElement("div");
      document.body.append(tab);
      await act(async () => {
        setMachinesHost(tab);
        pickMachineTab("memory");
        openMachines();
      });
      expect(tab.querySelector("[data-fork-memory-total]")?.textContent).toBe("Memory · 3.2 GB");
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

  it("says so when memory can't be read at all, instead of checking forever", async () => {
    invoke.mockRejectedValue(new Error("no such command"));
    const footer = document.createElement("span");
    const tab = document.createElement("div");
    document.body.append(footer, tab);
    await act(async () => {
      root.render(
        createElement(MemoryWatcher, { sessions: { current: [] }, isForeground: () => false, chipHost: footer }),
      );
      setMachinesHost(tab);
      pickMachineTab("memory");
      openMachines();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(tab.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read memory use");
  });

  it("with auto-park on, parks the idle session after a minute of pressure and says so quietly", async () => {
    setMemorySettings({ autoPark: true, idleMinutes: 1 });
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

describe("memory settings", () => {
  it("defaults to off and 1 min, and moves an old 5-60 min threshold to the default", () => {
    expect(memorySettings()).toEqual({ autoPark: false, idleMinutes: 1 });
    resetMemoryStores();
    localStorage.setItem("monocode.fork.memory.idleMinutes", "30");
    expect(memorySettings().idleMinutes).toBe(1);
    expect(localStorage.getItem("monocode.fork.memory.idleMinutes")).toBe("1");
    resetMemoryStores();
    localStorage.setItem("monocode.fork.memory.idleMinutes", "0");
    expect(memorySettings().idleMinutes).toBe(0);
  });

  it("sees another window turn auto-park off", () => {
    setMemorySettings({ autoPark: true });
    const before = memorySettings();
    // Another window writes storage; this one hears a storage event.
    localStorage.setItem("monocode.fork.memory.autoPark", "0");
    window.dispatchEvent(new StorageEvent("storage", { key: "monocode.fork.memory.autoPark" }));
    expect(memorySettings().autoPark).toBe(false);
    // And a tick's re-read keeps the same object when nothing changed.
    const after = memorySettings();
    expect(after).not.toBe(before);
    expect(refreshMemorySettings()).toBe(after);
  });
});
