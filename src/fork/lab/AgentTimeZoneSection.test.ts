// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import { AgentTimeZoneSection, hostLine, type AgentTimeZoneHost } from "./AgentTimeZoneSection";
import { agentTimeZoneSnapshot, resetAgentTimeZoneForTests } from "./agentTimeZone";
import { LAB_CHANGED } from "./labWatcher";

let root: Root;
let container: HTMLDivElement;
let stored: { zone: string | null; systemZone: string | null; effectiveZone: string | null };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetAgentTimeZoneForTests();
  localStorage.clear();
  stored = { zone: null, systemZone: "Asia/Kolkata", effectiveZone: "Asia/Kolkata" };
  listen.mockReset().mockResolvedValue(() => {});
  invoke.mockReset().mockImplementation(async (command: string, args?: { zone: string | null }) => {
    if (command === "fork_agent_tz_get") {
      return stored;
    }
    if (command === "fork_agent_tz_set") {
      if (args?.zone === "Asia/Nowhere") {
        throw "Asia/Nowhere is not a time zone on this Mac.";
      }
      stored = { ...stored, zone: args?.zone ?? null, effectiveZone: args?.zone ?? stored.systemZone };
      return stored;
    }
    throw new Error(`unexpected ${command}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetAgentTimeZoneForTests();
  vi.unstubAllGlobals();
});

async function render(props: { compact?: boolean; hosts?: AgentTimeZoneHost[] } = {}) {
  await act(async () => {
    root.render(createElement(AgentTimeZoneSection, props));
  });
  await act(async () => {});
}

function button(name: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => name.test(element.textContent ?? ""));
  if (!found) {
    throw new Error(`no button ${name}`);
  }
  return found;
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

describe("AgentTimeZoneSection", () => {
  it("shows the agents' clock and that it follows this Mac", async () => {
    await render();
    expect(container.textContent).toContain("Agents' time");
    expect(container.textContent).toContain("Kolkata (IST, GMT+5:30)");
    expect(container.textContent).toContain("Follows this Mac");
    expect(container.textContent).toContain("New agent sessions start in this zone");
    expect(button(/Follow this Mac \(Kolkata\)/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Pick a zone/).getAttribute("aria-pressed")).toBe("false");
  });

  it("picks a zone from the search with the keyboard, and tells the hosts", async () => {
    const changed = vi.fn();
    window.addEventListener(LAB_CHANGED, changed);
    try {
      await render();
      await act(async () => button(/Pick a zone/).click());
      const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      expect(document.activeElement).toBe(input);
      await type(input, "tokyo");
      const options = container.querySelectorAll('[role="option"]');
      expect([...options].map((option) => option.textContent)).toEqual([expect.stringContaining("Tokyo")]);
      await key(input, "Enter");
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith("fork_agent_tz_set", { zone: "Asia/Tokyo" });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(container.querySelector('input[role="combobox"]')).toBeNull();
      expect(container.textContent).toContain("Picked zone");
      expect(button(/^Tokyo$/).getAttribute("aria-pressed")).toBe("true");
    } finally {
      window.removeEventListener(LAB_CHANGED, changed);
    }
  });

  it("moves through results with the arrow keys and closes on Escape", async () => {
    await render();
    await act(async () => button(/Pick a zone/).click());
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await type(input, "asia");
    const first = input.getAttribute("aria-activedescendant");
    await key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).not.toBe(first);
    await key(input, "Escape");
    expect(container.querySelector('input[role="combobox"]')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("fork_agent_tz_set", expect.anything());
  });

  it("offers this Mac's zone and recent picks as quick picks", async () => {
    localStorage.setItem("monocode:fork-agent-tz-recent", JSON.stringify(["Europe/Paris"]));
    await render({ compact: true });
    await act(async () => button(/Pick a zone/).click());
    await act(async () => button(/^Paris$/).click());
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("fork_agent_tz_set", { zone: "Europe/Paris" });
  });

  it("sends null for Follow this Mac", async () => {
    stored = { zone: "Asia/Tokyo", systemZone: "Asia/Kolkata", effectiveZone: "Asia/Tokyo" };
    await render();
    expect(container.textContent).toContain("Tokyo (");
    await act(async () => button(/Follow this Mac/).click());
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("fork_agent_tz_set", { zone: null });
    expect(agentTimeZoneSnapshot().value?.zone).toBeNull();
  });

  it("shows a failed set in words", async () => {
    await render();
    await act(async () => button(/Pick a zone/).click());
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    // Not in the list, so pick it through a recent entry.
    await key(input, "Escape");
    localStorage.setItem("monocode:fork-agent-tz-recent", JSON.stringify(["Asia/Nowhere"]));
    await act(async () => button(/Pick a zone/).click());
    await act(async () => button(/^Nowhere$/).click());
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Asia/Nowhere is not a time zone on this Mac.");
  });

  it("says where each host stands, and nothing without hosts", async () => {
    const zone = (value: string | null) => ({ zone: value, updatedAt: 1, hostZone: "Australia/Sydney" });
    await render({
      compact: true,
      hosts: [
        { name: "vivobook", online: true, tzCapable: true, timeZone: zone("Asia/Kolkata") },
        { name: "lenovo", online: true, tzCapable: true, timeZone: zone(null) },
        { name: "pi", online: true, tzCapable: false },
        { name: "spare", online: false, tzCapable: true },
      ],
    });
    const lines = [...container.querySelectorAll("li")].map((line) => line.textContent);
    expect(lines).toEqual([
      "vivobook uses Kolkata",
      "lenovo: switching to Kolkata…",
      "pi needs a host update for this",
      "spare offline",
    ]);
    expect(container.textContent).not.toContain("New agent sessions start");
    await render({ hosts: [] });
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("hostLine", () => {
  it("compares with the zone the Mac sends", () => {
    const host = { name: "vivobook", online: true, tzCapable: true, timeZone: { zone: "Asia/Tokyo", updatedAt: 1, hostZone: null } };
    expect(hostLine(host, "Asia/Tokyo")).toBe("vivobook uses Tokyo");
    expect(hostLine(host, "Asia/Kolkata")).toBe("vivobook: switching to Kolkata…");
  });
});

describe("saving", () => {
  it("sends one save at a time", async () => {
    let release: () => void = () => {};
    await render();
    invoke.mockImplementation(async (command: string, args?: { zone: string | null }) => {
      if (command === "fork_agent_tz_get") {
        return stored;
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...stored, zone: args?.zone ?? null, effectiveZone: args?.zone ?? stored.systemZone };
    });
    await act(async () => button(/Pick a zone/).click());
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await type(input, "tokyo");
    await key(input, "Enter");
    await key(input, "Enter");
    const sets = () => invoke.mock.calls.filter(([command]) => command === "fork_agent_tz_set");
    expect(sets()).toHaveLength(1);
    await act(async () => release());
  });
});
