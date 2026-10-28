// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import type { HostModelCatalog } from "./protocol";

const catalog = (name: string): HostModelCatalog => ({
  models: { codex: [{ id: `codex:${name}`, name } as never] },
  errors: {},
});

let cache: typeof import("./remoteCatalogCache");
beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  cache = await import("./remoteCatalogCache");
});

it("refreshes when nothing is cached, after ten minutes, or when forced", () => {
  const entry = { at: 1_000_000, catalog: catalog("a") };
  expect(cache.catalogNeedsRefresh(undefined, entry.at)).toBe(true);
  expect(cache.catalogNeedsRefresh(entry, entry.at + 60_000)).toBe(false);
  expect(cache.catalogNeedsRefresh(entry, entry.at + 60_000, true)).toBe(true);
  expect(cache.catalogNeedsRefresh(entry, entry.at + cache.CATALOG_REFRESH_MS)).toBe(true);
  // A clock set back cannot keep a copy fresh forever.
  expect(cache.catalogNeedsRefresh(entry, entry.at - 1)).toBe(true);
});

it("keeps a machine project's catalog across restarts", async () => {
  cache.rememberRemoteCatalog("machine", "project", catalog("a"), 5);
  vi.resetModules();
  const restarted = await import("./remoteCatalogCache");
  expect(restarted.cachedRemoteCatalog("machine", "project")).toEqual({
    at: 5,
    catalog: catalog("a"),
  });
  expect(restarted.cachedRemoteCatalog("machine", "other")).toBeUndefined();
});

it("stores only the most recent few catalogs", async () => {
  for (const project of ["a", "b", "c", "d"])
    cache.rememberRemoteCatalog("machine", project, catalog(project));
  vi.resetModules();
  const restarted = await import("./remoteCatalogCache");
  expect(restarted.cachedRemoteCatalog("machine", "a")).toBeUndefined();
  expect(restarted.cachedRemoteCatalog("machine", "d")?.catalog).toEqual(catalog("d"));
});

it("asks the host once for concurrent reads, and a failure keeps the cache", async () => {
  cache.rememberRemoteCatalog("machine", "project", catalog("old"), 5);
  let finish!: (value: HostModelCatalog) => void;
  const request = vi.fn(
    () => new Promise<HostModelCatalog>((resolve) => { finish = resolve; }),
  );
  const first = cache.fetchRemoteCatalog("machine", "project", request);
  const second = cache.fetchRemoteCatalog("machine", "project", request);
  expect(request).toHaveBeenCalledTimes(1);
  finish(catalog("new"));
  await expect(first).resolves.toEqual(catalog("new"));
  await expect(second).resolves.toEqual(catalog("new"));
  expect(cache.cachedRemoteCatalog("machine", "project")?.catalog).toEqual(catalog("new"));

  await expect(
    cache.fetchRemoteCatalog("machine", "project", () => Promise.reject(new Error("offline"))),
  ).rejects.toThrow("offline");
  expect(cache.cachedRemoteCatalog("machine", "project")?.catalog).toEqual(catalog("new"));
  await expect(
    cache.fetchRemoteCatalog("machine", "project", () =>
      Promise.resolve(undefined as unknown as HostModelCatalog),
    ),
  ).rejects.toThrow("Invalid model catalog");
  expect(cache.cachedRemoteCatalog("machine", "project")?.catalog).toEqual(catalog("new"));
});

it("rejects malformed catalogs and never restores a forgotten machine's", async () => {
  await expect(
    cache.fetchRemoteCatalog("machine", "project", () =>
      Promise.resolve({ models: [], errors: [] } as unknown as HostModelCatalog),
    ),
  ).rejects.toThrow("Invalid model catalog");
  for (const bad of [
    { models: { claude: "bad" }, errors: {} },
    { models: { claude: [null] }, errors: {} },
    { models: { claude: [{ id: "claude:x" }] }, errors: {} },
    { models: { claude: [{ id: "claude:x", name: "X", settings: {} }] }, errors: {} },
    { models: {}, errors: { claude: { message: "down" } } },
  ]) {
    await expect(
      cache.fetchRemoteCatalog("machine", "project", () =>
        Promise.resolve(bad as unknown as HostModelCatalog),
      ),
    ).rejects.toThrow("Invalid model catalog");
  }
  localStorage.setItem(
    "monocode.remote-catalog.v1:" + JSON.stringify(["machine", "project"]),
    JSON.stringify({ at: 1, catalog: { models: { claude: "bad" }, errors: {} } }),
  );
  expect(cache.cachedRemoteCatalog("machine", "project")).toBeUndefined();
  let finish!: (value: HostModelCatalog) => void;
  const late = cache.fetchRemoteCatalog(
    "machine",
    "project",
    () => new Promise<HostModelCatalog>((resolve) => { finish = resolve; }),
  );
  cache.forgetRemoteCatalogs("machine");
  finish(catalog("late"));
  await late;
  expect(cache.cachedRemoteCatalog("machine", "project")).toBeUndefined();
});

it("survives storage that throws", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => cache.rememberRemoteCatalog("machine", "project", catalog("a"))).not.toThrow();
  expect(cache.cachedRemoteCatalog("machine", "project")?.catalog).toEqual(catalog("a"));
  spy.mockRestore();
});
