import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDiffStats, gitDiffStats, type DiffStats } from "./git-diff-stats";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "monocode-diffstats-test-"));
  dirs.push(dir);
  return dir;
};

it("counts tracked changes against HEAD and untracked lines", async () => {
  const repo = temp();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
    });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-qm", "first");
  expect(await gitDiffStats(repo)).toEqual({ additions: 0, deletions: 0 });
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "x\ny\nz\n");
  expect(await gitDiffStats(repo)).toEqual({ additions: 3, deletions: 1 });
});

it("counts staged files in a repo with no commit yet", async () => {
  const repo = temp();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "staged.txt"), "a\nb\n");
  execFileSync("git", ["add", "staged.txt"], { cwd: repo });
  writeFileSync(join(repo, "loose.txt"), "c\n");
  expect(await gitDiffStats(repo)).toEqual({ additions: 3, deletions: 0 });
});

it("skips a folder that is not a git repo", async () => {
  expect(await gitDiffStats(temp())).toBeNull();
});

it("caches counts, says when they change, and runs one count at a time", async () => {
  let running = 0;
  let most = 0;
  const results = new Map<string, DiffStats | null>([
    ["/a", { additions: 2, deletions: 1 }],
    ["/b", null],
  ]);
  const count = vi.fn(async (cwd: string) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return results.get(cwd) ?? null;
  });
  const onChange = vi.fn();
  const stats = createDiffStats({ count, onChange });
  expect(stats.get("a")).toEqual({ additions: 0, deletions: 0 });
  void stats.refresh("a", "/a");
  void stats.refresh("b", "/b");
  void stats.refresh("b", "/b");
  await stats.idle();
  expect(most).toBe(1);
  // The second refresh of "b" joined the queued one.
  expect(count).toHaveBeenCalledTimes(2);
  expect(stats.get("a")).toEqual({ additions: 2, deletions: 1 });
  expect(stats.get("b")).toEqual({ additions: 0, deletions: 0 });
  expect(onChange).toHaveBeenCalledTimes(1);
  await stats.refresh("a", "/a");
  expect(onChange).toHaveBeenCalledTimes(1);
  results.set("/a", { additions: 5, deletions: 1 });
  await stats.refresh("a", "/a");
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(stats.get("a").additions).toBe(5);
});

it("recounts only recently active projects on its timer", async () => {
  const count = vi.fn(async () => ({ additions: 1, deletions: 0 }));
  const stats = createDiffStats({
    count,
    now: () => 1_000_000_000,
    active: () => [
      { id: "new", cwd: "/new", updatedAt: 1_000_000_000 - 1_000 },
      { id: "old", cwd: "/old", updatedAt: 0 },
    ],
  });
  stats.tick();
  await stats.idle();
  stats.stop();
  expect(count.mock.calls).toEqual([["/new"]]);
});

it("keeps the last good count when a count fails, and drops it outside git", async () => {
  let result: () => DiffStats | null = () => ({ additions: 4, deletions: 2 });
  const onChange = vi.fn();
  const stats = createDiffStats({ count: async () => result(), onChange });
  await stats.refresh("a", "/a");
  result = () => {
    throw new Error("git timed out");
  };
  await stats.refresh("a", "/a");
  expect(stats.get("a")).toEqual({ additions: 4, deletions: 2 });
  expect(onChange).toHaveBeenCalledTimes(1);
  result = () => null;
  await stats.refresh("a", "/a");
  expect(stats.get("a")).toEqual({ additions: 0, deletions: 0 });
  expect(onChange).toHaveBeenCalledTimes(2);
});
