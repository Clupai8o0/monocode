// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

import { GrokBotWebhooksSection } from "./GrokBotWebhooksSection";

const BOTS = {
  savedAt: null,
  bots: [
    { id: "bot-a", name: "Alpha", description: "", hidden: false, routines: 0 },
    { id: "bot-b", name: "Beta", description: "", hidden: false, routines: 0 },
  ],
};

let cleanup = () => {};

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

async function setup(save: () => Promise<unknown>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockImplementation(async (command: string) => {
    if (command === "fork_grok_bot_bots") return BOTS;
    if (command === "fork_grok_bot_webhooks") return [];
    if (command === "fork_grok_bot_webhook_set") return save();
    return null;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => root.render(createElement(GrokBotWebhooksSection)));
  return container;
}

function row(container: HTMLElement, name: string): HTMLElement {
  const item = [...container.querySelectorAll("li")].find((li) => li.textContent?.includes(name));
  if (!item) throw new Error(`no row ${name}`);
  return item as HTMLElement;
}

function button(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fill(scope: HTMLElement, url: string, key: string) {
  const [urlInput, keyInput] = [...scope.querySelectorAll("input")] as HTMLInputElement[];
  await type(urlInput, url);
  await type(keyInput, key);
}

it("opens another bot's form empty", async () => {
  const container = await setup(async () => ({}));
  await act(async () => button(row(container, "Alpha"), "Add webhook").click());
  await fill(row(container, "Alpha"), "https://a.example/hook", "alpha-secret-key");

  await act(async () => button(row(container, "Beta"), "Add webhook").click());

  expect(row(container, "Alpha").querySelector("form")).toBeNull();
  const inputs = [...row(container, "Beta").querySelectorAll("input")] as HTMLInputElement[];
  expect(inputs.map((input) => input.value)).toEqual(["", ""]);
});

it("locks Cancel and other rows while a save runs, then closes only its own form", async () => {
  let finish: (value: unknown) => void = () => {};
  const container = await setup(() => new Promise((resolve) => (finish = resolve)));
  await act(async () => button(row(container, "Alpha"), "Add webhook").click());
  await fill(row(container, "Alpha"), "https://a.example/hook", "alpha-secret-key");

  await act(async () => row(container, "Alpha").querySelector("form")!.requestSubmit());

  expect(button(row(container, "Alpha"), "Cancel").disabled).toBe(true);
  expect(button(row(container, "Beta"), "Add webhook").disabled).toBe(true);
  expect(invoke).toHaveBeenCalledWith("fork_grok_bot_webhook_set", {
    botId: "bot-a",
    url: "https://a.example/hook",
    key: "alpha-secret-key",
  });

  await act(async () => finish({}));

  expect(row(container, "Alpha").querySelector("form")).toBeNull();
  expect(button(row(container, "Beta"), "Add webhook").disabled).toBe(false);
});
