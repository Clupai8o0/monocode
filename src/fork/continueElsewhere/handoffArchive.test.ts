import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/app-data/"),
}));
vi.mock("../../platform/tauri/fs", () => ({
  createPath: vi.fn(async () => "/app-data/handoffs"),
  statFiles: vi.fn(async () => [{ mtimeMs: 1 }]),
  writeTextFile: vi.fn(async () => {}),
}));
import { createPath, statFiles, writeTextFile } from "../../platform/tauri/fs";
import { writeHandoffArchive } from "./handoffArchive";

beforeEach(() => vi.clearAllMocks());
it("writes complete text in app data before returning a usable path", async () => {
  const path = await writeHandoffArchive("Original instructions");
  expect(path).toMatch(/^\/app-data\/handoffs\/[\w-]+\.md$/);
  expect(createPath).toHaveBeenCalledWith("/app-data", "handoffs", true);
  expect(writeTextFile).toHaveBeenCalledWith(path, "Original instructions");
});
it("reuses the archive directory when it already exists", async () => {
  vi.mocked(createPath).mockRejectedValueOnce(new Error("Already exists"));
  await writeHandoffArchive("Context");
  expect(statFiles).toHaveBeenCalledWith(["/app-data/handoffs"]);
  expect(writeTextFile).toHaveBeenCalled();
});
it("does not return a dead file reference when writing fails", async () => {
  vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("Disk full"));
  await expect(writeHandoffArchive("Context")).rejects.toThrow("Disk full");
});
