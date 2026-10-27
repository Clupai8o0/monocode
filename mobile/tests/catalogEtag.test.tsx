import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const link = vi.hoisted(() => ({ request: vi.fn() }));
const saved = vi.hoisted(() => new Map<string, string>());
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  Platform: { OS: "android" },
}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (name: string) => (name.endsWith("hostToken") ? "token" : null),
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (name: string) => saved.get(name) ?? null,
    setItem: async (name: string, value: string) => void saved.set(name, value),
    removeItem: async (name: string) => void saved.delete(name),
  },
}));
vi.mock("@/features/connection/nativeLink", () => ({
  nativeCall: vi.fn(),
  parseHostInvitation: vi.fn(),
  parseInvitation: vi.fn(),
  request: link.request,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import {
  ConnectionProvider,
  useConnection,
} from "@/features/connection/ConnectionProvider";

const catalog = (name: string, etag?: string) => ({
  projects: [{ id: "p", name }],
  monos: [],
  sessions: [],
  ...(etag ? { etag } : {}),
});

afterEach(() => {
  vi.useRealTimers();
  saved.clear();
});

it("names the catalog it has, and keeps it when the host says nothing changed", async () => {
  vi.useFakeTimers();
  saved.set(
    "monocode.mobile.pairing",
    JSON.stringify({ name: "vivobook", fingerprint: "f", addresses: [], deviceId: "d", host: { url: "https://h" } }),
  );
  link.request
    .mockResolvedValueOnce(catalog("App", "e1"))
    .mockResolvedValueOnce({ unchanged: true, etag: "e1" })
    .mockResolvedValueOnce(catalog("Renamed", "e2"));
  let connection!: ReturnType<typeof useConnection>;
  function Probe() {
    connection = useConnection();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <ConnectionProvider>
        <Probe />
      </ConnectionProvider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(link.request).toHaveBeenNthCalledWith(1, expect.anything(), "workspace.list", {});
  expect(connection.catalog.projects[0]?.name).toBe("App");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(link.request).toHaveBeenNthCalledWith(2, expect.anything(), "workspace.list", {
    since: "e1",
  });
  expect(connection.catalog.projects[0]?.name).toBe("App");
  expect(connection.connected).toBe(true);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(link.request).toHaveBeenNthCalledWith(3, expect.anything(), "workspace.list", {
    since: "e1",
  });
  expect(connection.catalog.projects[0]?.name).toBe("Renamed");
  await act(async () => root.unmount());
});
