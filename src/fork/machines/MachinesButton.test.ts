// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined), emit: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("closes with the footer, so it doesn't reopen when the footer comes back", async () => {
  vi.stubEnv("MODE", "development");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MachinesButton } = await import("./MachinesButton");
  const { currentMachineTab, openMachines } = await import("./machinesStore");
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(MachinesButton)));
  await act(async () => openMachines());
  expect(currentMachineTab()).toBe("lab");
  await act(async () => root.unmount());
  expect(currentMachineTab()).toBeNull();
});
